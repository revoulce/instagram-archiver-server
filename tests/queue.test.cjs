const test = require('node:test');
const assert = require('node:assert/strict');
const { QueueService } = require('../dist/infrastructure/queue/QueueService');
const { taskIdentity } = require('../dist/domain/taskIdentity');

test('post and Reel URLs for the same media have the same stable task ID', () => {
    assert.equal(taskIdentity('https://www.instagram.com/p/ABC/'), taskIdentity('https://www.instagram.com/reel/ABC/'));
    assert.notEqual(taskIdentity('https://www.instagram.com/p/ABC/'), taskIdentity('https://www.instagram.com/p/OTHER/'));
});

test('queue uses canonical URL and stable job ID for duplicate requests', async () => {
    const queue = Object.create(QueueService.prototype);
    const calls = [];
    queue.queue = { add: async (name, data, options) => { calls.push({ name, data, options }); return { id: options.jobId }; } };
    const first = await queue.add({ url: 'https://instagram.com/reels/ABC/?x=1', source: 'extension' });
    const second = await queue.add({ url: 'https://www.instagram.com/p/ABC/', source: 'extension' });
    assert.equal(first, second);
    assert.equal(calls[0].data.url, 'https://www.instagram.com/reel/ABC/');
    await assert.rejects(queue.add({ url: 'https://evil.example/instagram.com', source: 'extension' }));
    assert.equal(calls.length, 2);
});

test('status reports progress and review flag without leaking filesystem paths or raw errors', async () => {
    const queue = Object.create(QueueService.prototype);
    const job = {
        id: '42', data: { url: 'url', checkpoint: {
            nextFileIndex: 10, pendingFileIndex: 10, messageIds: [123],
            metadata: { downloadDirectory: '/private/path', filePaths: Array(11).fill('/private/media') },
        } }, attemptsMade: 1, timestamp: 1000, finishedOn: 2000,
        failedReason: 'secret or raw exception', getState: async () => 'failed',
    };
    queue.queue = { getJob: async () => job };
    const status = await queue.getStatus('42');
    assert.equal(status.status, 'failed');
    assert.equal(status.sentFiles, 10);
    assert.equal(status.totalFiles, 11);
    assert.equal(status.requiresReview, true);
    assert.deepEqual(status.messageIds, [123]);
    assert.ok(!JSON.stringify(status).includes('private'));
    assert.ok(!JSON.stringify(status).includes('secret'));
    job.getState = async () => 'active';
    assert.equal((await queue.getStatus('42')).requiresReview, false);
});

test('manual retry rejects active, completed and uncertain jobs and renews safe retry budget', async () => {
    const queue = Object.create(QueueService.prototype);
    let retryCount = 0;
    const job = { data: {}, getState: async () => 'active', retry: async (state, options) => {
        assert.equal(state, 'failed'); assert.equal(options.resetAttemptsMade, true); retryCount++;
    } };
    queue.queue = { getJob: async () => job };
    assert.equal(await queue.retry('42'), 'conflict');
    job.getState = async () => 'completed';
    assert.equal(await queue.retry('42'), 'conflict');
    job.getState = async () => 'failed';
    job.data.checkpoint = { pendingFileIndex: 0 };
    assert.equal(await queue.retry('42'), 'requires_review');
    job.data.checkpoint = undefined;
    assert.equal(await queue.retry('42'), 'queued');
    assert.equal(retryCount, 1);
    queue.queue.getJob = async () => undefined;
    assert.equal(await queue.retry('missing'), 'not_found');
});

test('terminal status reloads the final checkpoint if the worker completes between reads', async () => {
    const queue = Object.create(QueueService.prototype);
    const initial = {
        id: '42', data: { url: 'url', checkpoint: { nextFileIndex: 10, messageIds: [1] } },
        attemptsMade: 1, timestamp: 1000, getState: async () => 'completed',
    };
    const final = {
        ...initial, data: { url: 'url', checkpoint: { nextFileIndex: 11, messageIds: [1,11] } },
        attemptsMade: 2, finishedOn: 2000,
    };
    let reads = 0;
    queue.queue = { getJob: async () => ++reads === 1 ? initial : final };
    const status = await queue.getStatus('42');
    assert.equal(status.sentFiles, 11);
    assert.equal(status.attemptsMade, 2);
    assert.deepEqual(status.messageIds, [1,11]);
});

test('retry reloads the failed checkpoint before allowing another delivery attempt', async () => {
    const queue = Object.create(QueueService.prototype);
    let reads = 0;
    let retried = false;
    const initial = { data: {}, getState: async () => 'failed', retry: async () => { retried = true; } };
    const final = { ...initial, data: { checkpoint: { pendingFileIndex: 10 } } };
    queue.queue = { getJob: async () => ++reads === 1 ? initial : final };
    assert.equal(await queue.retry('42'), 'requires_review');
    assert.equal(retried, false);
});

test('Instagram waits expose a reason and next local check without exposing the session', async () => {
    const queue = Object.create(QueueService.prototype);
    queue.queue = { getJob: async () => ({ id: '42', data: { url: 'url',
        instagramWait: { reason: 'auth_required', checkAt: 5000 } },
        attemptsMade: 0, timestamp: 1000, getState: async () => 'delayed' }) };
    const status = await queue.getStatus('42');
    assert.equal(status.status, 'retrying');
    assert.equal(status.waitingReason, 'auth_required');
    assert.equal(status.nextCheckAt, new Date(5000).toISOString());
    assert.equal(status.attemptsMade, 0);
});

test('automatic metadata recovery rechecks delivery state, failure generation and job state', async () => {
    const service = Object.create(QueueService.prototype);
    service.metadataRetryIntervalMs = 3600000;
    const retryCalls = [];
    const failedReason = 'Gallery-dl returned incomplete or inconsistent post metadata';
    const job = (id, changes = {}) => ({ id, finishedOn: 1000, failedReason, data: {},
        getState: async () => 'failed', retry: async (state, options) => {
            assert.equal(state, 'failed');
            assert.deepEqual(options, { resetAttemptsMade: true, resetAttemptsStarted: true });
            retryCalls.push(id);
        }, ...changes });
    const candidates = [job('safe'), job('other', { failedReason: 'Telegram rejection' }),
        job('uncertain', { data: { checkpoint: { pendingFileIndex: 0 } } }),
        job('sent', { data: { checkpoint: { nextFileIndex: 10, messageIds: [1] } } }),
        job('stale'), job('active'), job('deleted'), job('changed')];
    const current = new Map(candidates.map(value => [value.id, value]));
    current.set('stale', job('stale', { finishedOn: 2000 }));
    current.set('active', job('active', { getState: async () => 'active' }));
    current.delete('deleted');
    current.set('changed', job('changed', { data: { checkpoint: { pendingFileIndex: 0 } } }));
    let claimAllowed = true;
    const client = { defineCommand: () => {}, runCommand: async () => claimAllowed ? 'OK' : null };
    service.queue = { getFailed: async () => candidates, getJob: async id => current.get(id),
        client: Promise.resolve(client), toKey: name => name };
    assert.equal(await service.retryMetadataFailures(), 1);
    assert.deepEqual(retryCalls, ['safe']);
    claimAllowed = false;
    assert.equal(await service.retryMetadataFailures(), 0);
    assert.deepEqual(retryCalls, ['safe']);
    service.metadataRetryIntervalMs = 0;
    service.queue.getFailed = async () => assert.fail('Disabled recovery must not scan');
    assert.equal(await service.retryMetadataFailures(), 0);
});

test('automatic recovery does not overlap scans and shutdown waits for an in-flight scan', async () => {
    const service = Object.create(QueueService.prototype);
    service.metadataRetryIntervalMs = 3600000;
    let release;
    let calls = 0;
    service.queue = { getFailed: () => { calls++; return new Promise(resolve => { release = () => resolve([]); }); },
        close: async () => {} };
    let workerClosed = false;
    service.worker = { close: async () => { workerClosed = true; } };
    service.startup = Promise.resolve();
    const first = service.retryMetadataFailures();
    const second = service.retryMetadataFailures();
    const closing = service.close();
    assert.equal(calls, 1);
    assert.equal(workerClosed, false);
    release();
    assert.deepEqual(await Promise.all([first, second]), [0, 0]);
    await closing;
    assert.equal(workerClosed, true);
    assert.equal(await service.retryMetadataFailures(), 0);
});
