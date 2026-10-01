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
