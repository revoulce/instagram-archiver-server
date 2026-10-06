const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Queue } = require('bullmq');
const { QueueService } = require('../dist/infrastructure/queue/QueueService');
const { PermanentTaskError, TelegramRateLimitError } = require('../dist/domain/taskErrors');

test('Redis integration: metadata recovery runs on startup and interval with a shared restart cooldown', {
    skip: !process.env.TEST_REDIS_HOST, timeout: 15000,
}, async t => {
    const host = process.env.TEST_REDIS_HOST;
    const port = Number(process.env.TEST_REDIS_PORT || 6379);
    const namespace = `archiver-test-${randomUUID()}`;
    const control = new Queue(namespace, { connection: { host, port, maxRetriesPerRequest: 1 } });
    const services = [];
    const downloads = { META: 0, UNSAFE: 0, OTHER: 0 };
    let sends = 0;
    const metadata = { downloadDirectory: 'fixture', filePaths: ['image.jpg'], description: '', author: 'a', likes: 0, uploadDate: '', mediaType: 'image' };
    const connect = async interval => {
        const service = new QueueService(host, port, {
            download: async url => {
                const code = new URL(url).pathname.split('/')[2];
                downloads[code]++;
                if (code === 'OTHER') throw new PermanentTaskError('Fixture permanent failure');
                if (code === 'UNSAFE' || downloads[code] < 3) {
                    throw new Error('Gallery-dl returned incomplete or inconsistent post metadata');
                }
                return metadata;
            }, cleanup: async () => {}, isAvailable: async () => true,
        }, { sendPost: async (_metadata, _url, options) => {
            await options.onBatchStart(0);
            sends++;
            await options.onBatchSent(1, [sends]);
        }, sendError: async () => {} }, namespace, { minIntervalMs: 1, metadataRetryIntervalMs: interval });
        services.push(service);
        await service.waitUntilReady();
        return service;
    };
    t.after(async () => {
        await Promise.all(services.map(service => service.close()));
        await (await control.client).del(control.toKey('metadata-auto-retry'), control.toKey('instagram-session'));
        await control.obliterate({ force: true });
        await control.close();
    });
    const waitFor = async predicate => {
        const deadline = Date.now() + 6000;
        while (Date.now() < deadline) {
            if (await predicate()) return;
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.fail('Metadata recovery did not reach expected state');
    };
    const first = await connect(0);
    for (const code of Object.keys(downloads)) {
        await control.add('download-post', { url: `https://www.instagram.com/p/${code}/`, source: 'extension' },
            { jobId: code, attempts: 1 });
        await waitFor(async () => (await control.getJob(code)).getState().then(state => state === 'failed'));
    }
    const unsafe = await control.getJob('UNSAFE');
    await unsafe.updateData({ ...unsafe.data, checkpoint: { nextFileIndex: 0, messageIds: [], pendingFileIndex: 0 } });
    await first.close();
    await connect(1000);
    await waitFor(async () => downloads.META === 2 && await (await control.getJob('META')).getState() === 'failed');
    // A second container starts while the shared cooldown is still active.
    await connect(1000);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(downloads.META, 2);
    await waitFor(async () => await (await control.getJob('META')).getState() === 'completed');
    assert.deepEqual(downloads, { META: 3, UNSAFE: 1, OTHER: 1 });
    assert.equal(sends, 1);
    assert.equal(await (await control.getJob('UNSAFE')).getState(), 'failed');
    assert.equal(await (await control.getJob('OTHER')).getState(), 'failed');
});

test('Redis integration: atomic duplicate suppression, persisted status and safe manual retry', {
    skip: !process.env.TEST_REDIS_HOST, timeout: 30000,
}, async t => {
    const host = process.env.TEST_REDIS_HOST;
    const port = Number(process.env.TEST_REDIS_PORT || 6379);
    const namespace = `archiver-test-${randomUUID()}`;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let downloads = 0;
    let sends = 0;
    let rejectNext = false;
    const metadata = { downloadDirectory: 'fixture', filePaths: ['image.jpg'], description: '', author: 'a', likes: 0, uploadDate: '', mediaType: 'image' };
    const service = new QueueService(host, port, {
        download: async () => { downloads++; return metadata; }, cleanup: async () => {}, isAvailable: async () => true,
    }, {
        sendPost: async (_metadata, _url, options) => {
            await gate;
            await options.onBatchStart(0);
            sends++;
            if (rejectNext) {
                rejectNext = false;
                await options.onBatchRejected();
                throw new PermanentTaskError('Fixture rejection');
            }
            await options.onBatchSent(1, [sends]);
        }, sendError: async () => {},
    }, namespace, { minIntervalMs: 1 });
    t.after(async () => {
        release();
        await service.close();
        const cleanup = new Queue(namespace, { connection: { host, port, maxRetriesPerRequest: 1 } });
        try { await cleanup.obliterate({ force: true }); }
        finally { await cleanup.close(); }
    });
    await service.waitUntilReady();
    const ids = await Promise.all(Array.from({ length: 10 }, (_, i) => service.add({
        url: i % 2 ? 'https://instagram.com/reel/ABC/?x=1' : 'https://instagram.com/p/ABC/', source: 'extension',
    })));
    assert.equal(new Set(ids).size, 1);
    release();
    async function waitFor(id, expected) {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
            const status = await service.getStatus(id);
            if (status?.status === expected) return status;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.fail(`Task did not reach ${expected}`);
    }
    const done = await waitFor(ids[0], 'completed');
    assert.equal(downloads, 1);
    assert.equal(sends, 1);
    assert.equal(done.sentFiles, 1);
    assert.deepEqual(done.messageIds, [1]);
    assert.equal(await service.retry(ids[0]), 'conflict');
    assert.equal(await service.isReady(), true);
    rejectNext = true;
    const failedId = await service.add({ url: 'https://instagram.com/p/FAILED/', source: 'extension' });
    assert.equal((await waitFor(failedId, 'failed')).requiresReview, false);
    assert.equal(await service.retry(failedId), 'queued');
    assert.equal((await waitFor(failedId, 'completed')).sentFiles, 1);
    assert.equal(downloads, 3);
});

async function albumFixture(t, sendPost) {
    const host = process.env.TEST_REDIS_HOST;
    const port = Number(process.env.TEST_REDIS_PORT || 6379);
    const namespace = `archiver-test-${randomUUID()}`;
    let downloads = 0;
    let cleanups = 0;
    const metadata = {
        downloadDirectory: 'fixture', filePaths: Array.from({ length: 11 }, (_, i) => `${i}.jpg`),
        description: '', author: 'a', likes: 0, uploadDate: '', mediaType: 'album',
    };
    const downloader = {
        download: async () => { downloads++; return metadata; },
        cleanup: async () => { cleanups++; }, isAvailable: async () => true,
    };
    let current;
    const connect = async notifier => {
        current = new QueueService(host, port, downloader, { sendPost: notifier, sendError: async () => {} }, namespace, { minIntervalMs: 1 });
        await current.waitUntilReady();
        return current;
    };
    const service = await connect(sendPost);
    t.after(async () => {
        await current.close();
        const cleanup = new Queue(namespace, { connection: { host, port, maxRetriesPerRequest: 1 } });
        try { await cleanup.obliterate({ force: true }); }
        finally { await cleanup.close(); }
    });
    const waitFor = async (id, expected) => {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
            const status = await current.getStatus(id);
            if (status?.status === expected) return status;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.fail(`Task did not reach ${expected}: ${JSON.stringify(await current.getStatus(id))}`);
    };
    return { service, connect, waitFor, downloads: () => downloads, cleanups: () => cleanups, host, port, namespace };
}

test('Redis integration: restart resumes only the unsent part of an album', {
    skip: !process.env.TEST_REDIS_HOST, timeout: 30000,
}, async t => {
    const starts = [];
    const fixture = await albumFixture(t, async (_metadata, _url, options) => {
        starts.push(options.startFileIndex);
        await options.onBatchStart(0);
        await options.onBatchSent(10, Array.from({ length: 10 }, (_, i) => i + 1));
        await options.onBatchStart(10);
        await options.onBatchRejected();
        throw new TelegramRateLimitError(60000);
    });
    const id = await fixture.service.add({ url: 'https://instagram.com/p/RESUME/', source: 'extension' });
    const waiting = await fixture.waitFor(id, 'retrying');
    assert.equal(waiting.sentFiles, 10);
    assert.equal(waiting.requiresReview, false);
    assert.equal(fixture.cleanups(), 0);
    await fixture.service.close();
    await fixture.connect(async (_metadata, _url, options) => {
        starts.push(options.startFileIndex);
        await options.onBatchStart(10);
        await options.onBatchSent(11, [11]);
    });
    const control = new Queue(fixture.namespace, { connection: { host: fixture.host, port: fixture.port } });
    try { await (await control.getJob(id)).promote(); }
    finally { await control.close(); }
    const done = await fixture.waitFor(id, 'completed');
    assert.deepEqual(starts, [0, 10]);
    assert.equal(fixture.downloads(), 1);
    assert.equal(fixture.cleanups(), 1);
    assert.deepEqual(done.messageIds, Array.from({ length: 11 }, (_, i) => i + 1));
});

test('Redis integration: ambiguous Telegram delivery blocks retries and duplicate POSTs', {
    skip: !process.env.TEST_REDIS_HOST, timeout: 30000,
}, async t => {
    let sends = 0;
    const fixture = await albumFixture(t, async (_metadata, _url, options) => {
        await options.onBatchStart(0);
        sends++;
        throw new Error('Response lost after request');
    });
    const input = { url: 'https://instagram.com/p/UNCERTAIN/', source: 'extension' };
    const id = await fixture.service.add(input);
    const failed = await fixture.waitFor(id, 'failed');
    assert.equal(failed.requiresReview, true);
    assert.equal(await fixture.service.retry(id), 'requires_review');
    assert.equal(await fixture.service.add(input), id);
    assert.equal(sends, 1);
    assert.equal(fixture.downloads(), 1);
});
