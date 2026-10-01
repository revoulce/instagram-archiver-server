const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('../dist/infrastructure/api/server');
const { createShutdown } = require('../dist/infrastructure/api/shutdown');

test('health distinguishes liveness, readiness, Redis failure and draining without exposing credentials', async t => {
    let ready = true;
    let stopping = false;
    let failure = false;
    let stalled = false;
    const server = createServer({}, 'test-key', {
        isReady: async () => {
            if (failure) throw new Error('secret/internal connection details');
            if (stalled) return new Promise(() => {});
            return ready;
        }, isStopping: () => stopping, timeoutMs: 20,
    }).listen(0, '127.0.0.1');
    t.after(() => new Promise(resolve => server.close(resolve)));
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (path, options = {}) => {
        const response = await fetch(base + path, options);
        return { status: response.status, body: await response.json() };
    };
    assert.equal((await request('/health/live')).status, 200);
    assert.equal((await request('/health/ready')).status, 200);
    ready = false;
    assert.equal((await request('/health/ready')).status, 503);
    failure = true;
    assert.deepEqual((await request('/health/ready')).body, { status: 'unavailable' });
    failure = false;
    stalled = true;
    assert.equal((await request('/health/ready')).status, 503);
    stalled = false;
    ready = true;
    stopping = true;
    assert.equal((await request('/health/ready')).status, 503);
    assert.equal((await request('/api/v1/task', { method: 'POST', headers: { Authorization: 'test-key' } })).status, 503);
    assert.equal((await request('/api/v1/task')).status, 403);
});

test('shutdown immediately marks draining, closes HTTP and queue in parallel and runs once', async () => {
    const events = [];
    let finishHttp;
    let finishQueue;
    const shutdown = createShutdown({
        markStopping: () => events.push('draining'),
        closeHttp: () => { events.push('http'); return new Promise(resolve => { finishHttp = resolve; }); },
        closeQueue: () => { events.push('queue'); return new Promise(resolve => { finishQueue = resolve; }); },
        timeoutMs: 1000,
    });
    const first = shutdown();
    assert.equal(shutdown(), first);
    await Promise.resolve();
    assert.deepEqual(events, ['draining', 'http', 'queue']);
    let finished = false;
    first.then(() => { finished = true; });
    finishHttp();
    await Promise.resolve();
    assert.equal(finished, false);
    finishQueue();
    await first;
});

test('shutdown has a deadline for hung dependencies', async () => {
    const shutdown = createShutdown({
        markStopping: () => {}, closeHttp: async () => {}, closeQueue: () => new Promise(() => {}), timeoutMs: 10,
    });
    await assert.rejects(shutdown(), /timed out/);
});

test('shutdown propagates close errors instead of reporting success', async () => {
    const shutdown = createShutdown({
        markStopping: () => {}, closeHttp: async () => { throw new Error('HTTP close failed'); }, closeQueue: async () => {}, timeoutMs: 1000,
    });
    await assert.rejects(shutdown(), /HTTP close failed/);
});
