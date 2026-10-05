const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Queue } = require('bullmq');
const { QueueService } = require('../dist/infrastructure/queue/QueueService');
const { InstagramSessionGate } = require('../dist/infrastructure/queue/InstagramSessionGate');
const { InstagramRestrictionError, InstagramWaitError } = require('../dist/domain/taskErrors');

const integration = { skip: !process.env.TEST_REDIS_HOST, timeout: 15000 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const media = { downloadDirectory: 'fixture', filePaths: ['image.jpg'], description: '', author: 'author',
    likes: 0, uploadDate: '', mediaType: 'image' };

async function fixture(t, download, options = {}) {
    const host = process.env.TEST_REDIS_HOST;
    const port = Number(process.env.TEST_REDIS_PORT || 6379);
    const namespace = `instagram-test-${randomUUID()}`;
    const control = new Queue(namespace, { connection: { host, port, maxRetriesPerRequest: 1 } });
    let session = 'original';
    let downloads = 0;
    let sends = 0;
    const starts = [];
    const services = [];
    let current;
    const connect = async () => {
        const service = new QueueService(host, port, {
            getSessionFingerprint: async () => session,
            download: async (_url, admitted) => {
                downloads++;
                starts.push(Date.now());
                return download ? download(admitted, downloads) : media;
            },
            isAvailable: async () => true, cleanup: async () => {},
        }, { sendPost: async (_metadata, _url, delivery) => {
            await delivery.onBatchStart(0);
            sends++;
            await delivery.onBatchSent(1, [sends]);
        } }, namespace, { minIntervalMs: 100, rateLimitCooldownMs: 600, cookiesPollMs: 100, ...options });
        services.push(service);
        await service.waitUntilReady();
        current = service;
        return service;
    };
    t.after(async () => {
        await Promise.all(services.map(service => service.close()));
        await (await control.client).del(control.toKey('instagram-session'), control.toKey('atomic-session'));
        await control.obliterate({ force: true });
        await control.close();
    });
    const service = await connect();
    const waitFor = async (id, predicate) => {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
            const status = await current.getStatus(id);
            if (status && predicate(status)) return status;
            await sleep(20);
        }
        assert.fail(`Task did not reach expected state: ${JSON.stringify(await current.getStatus(id))}`);
    };
    const add = shortcode => current.add({ url: `https://instagram.com/p/${shortcode}/`, source: 'extension' });
    return { service, control, connect, waitFor, add, starts,
        setSession: value => { session = value; }, downloads: () => downloads, sends: () => sends,
        status: id => current.getStatus(id) };
}

test('Redis integration: auth pause survives restart, new tasks and repeated local polls', integration, async t => {
    const f = await fixture(t, async (session, count) => {
        if (count === 1) throw new InstagramRestrictionError('auth_required', session);
        return media;
    });
    const first = await f.add('FIRST');
    const waiting = await f.waitFor(first, status => status.waitingReason === 'auth_required');
    assert.equal(waiting.attemptsMade, 0);
    const second = await f.add('SECOND');
    await f.waitFor(second, status => status.waitingReason === 'auth_required');
    await f.service.close();
    const restored = await f.connect();
    await sleep(400);
    assert.equal(f.downloads(), 1);
    assert.equal((await restored.getStatus(first)).attemptsMade, 0);
    assert.equal(await restored.retry(first), 'conflict');

    // Already-downloaded content can reach Telegram even during an auth pause.
    await f.control.add('download-post', { url: 'https://www.instagram.com/p/READY/', source: 'extension',
        checkpoint: { metadata: media, nextFileIndex: 0, messageIds: [] } }, { jobId: 'ready-media' });
    await f.waitFor('ready-media', status => status.status === 'completed');
    assert.equal(f.downloads(), 1);

    f.setSession('new-login-session');
    await f.waitFor(first, status => status.status === 'completed');
    await f.waitFor(second, status => status.status === 'completed');
    assert.equal(f.downloads(), 3);
    assert.equal(f.sends(), 3);
});

test('Redis integration: rate-limit cooldown and retry-after survive restart and cookie replacement', integration, async t => {
    const f = await fixture(t, async (session, count) => {
        if (count === 1) throw new InstagramRestrictionError('rate_limited', session, 1200);
        return media;
    });
    const first = await f.add('LIMITED');
    await f.waitFor(first, status => status.waitingReason === 'rate_limited');
    await f.service.close();
    f.setSession('new-login-session');
    await f.connect();
    const second = await f.add('NEXT');
    await f.waitFor(second, status => status.waitingReason === 'rate_limited');
    await sleep(300);
    assert.equal(f.downloads(), 1);
    await f.waitFor(first, status => status.status === 'completed');
    await f.waitFor(second, status => status.status === 'completed');
    assert.ok(f.starts[1] - f.starts[0] >= 1200);
    assert.equal(f.downloads(), 3);
    assert.equal((await f.status(first)).attemptsMade, 1);
});

test('Redis integration: multiple workers share pacing and missing cookies make no requests', integration, async t => {
    const f = await fixture(t, null, { minIntervalMs: 200 });
    await f.connect();
    f.setSession(null);
    const missing = await f.add('MISSING');
    await f.waitFor(missing, status => status.waitingReason === 'cookies_required');
    assert.equal(f.downloads(), 0);
    f.setSession('valid-session');
    const ids = [missing, ...await Promise.all(['TWO', 'THREE', 'FOUR'].map(f.add))];
    await Promise.all(ids.map(id => f.waitFor(id, status => status.status === 'completed')));
    assert.equal(f.downloads(), 4);
    for (let i = 1; i < f.starts.length; i++) assert.ok(f.starts[i] - f.starts[i - 1] >= 190);
});

test('Redis integration: simultaneous reservations are atomic across gate instances', integration, async t => {
    const f = await fixture(t);
    const key = f.control.toKey('atomic-session');
    const gates = Array.from({ length: 10 }, () => new InstagramSessionGate(() => f.control.client, key));
    const results = await Promise.allSettled(gates.map(gate => gate.reserve('session')));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    for (const result of results.filter(result => result.status === 'rejected')) {
        assert.ok(result.reason instanceof InstagramWaitError);
        assert.equal(result.reason.reason, 'pacing');
    }
});
