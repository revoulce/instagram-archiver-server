const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Queue } = require('bullmq');
const { QueueService } = require('../dist/infrastructure/queue/QueueService');
const { PermanentTaskError } = require('../dist/domain/taskErrors');

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
    }, namespace);
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
