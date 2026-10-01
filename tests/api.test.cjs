const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('../dist/infrastructure/api/server');
const { normalizeInstagramUrl } = require('../dist/domain/instagramUrl');

test('Instagram links are canonicalized without query or fragment', () => {
    assert.equal(normalizeInstagramUrl('https://m.instagram.com/reels/ABC-12/?igsh=x#x'), 'https://www.instagram.com/reel/ABC-12/');
    assert.equal(normalizeInstagramUrl('https://instagram.com/stories/user.name/12345/'), 'https://www.instagram.com/stories/user.name/12345/');
});

test('reject foreign hosts, credentials, protocols, ports and unsupported routes', () => {
    for (const value of [undefined, 123, {}, ['https://instagram.com/p/ABC/'],
        'https://instagram.com.evil.example/p/ABC/', 'https://evil.example/instagram.com',
        'http://127.0.0.1/?instagram.com', 'http://instagram.com/p/ABC/',
        'https://user:password@instagram.com/p/ABC/', 'https://instagram.com:8080/p/ABC/',
        'https://instagram.com/', 'https://instagram.com/stories/user/', 'x'.repeat(2049)]) {
        assert.equal(normalizeInstagramUrl(value), null);
    }
});

test('HTTP API preserves extension contract and never queues invalid requests', async t => {
    const tasks = [];
    const queue = { add: async task => { tasks.push(task); return '42'; } };
    const server = createServer(queue, 'test-key').listen(0, '127.0.0.1');
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    await once(server, 'listening');
    const endpoint = `http://127.0.0.1:${server.address().port}/api/v1/task`;
    const request = (body, secret = 'test-key') => fetch(endpoint, {
        method: 'POST', headers: { Authorization: secret, 'Content-Type': 'application/json' }, body,
    });

    const forbidden = await request('{', 'wrong-key');
    assert.equal(forbidden.status, 403);
    await forbidden.text();
    for (const body of ['{', '{}', '{"url":123}', '{"url":{}}', '{"url":"https://evil.example/instagram.com"}']) {
        const response = await request(body);
        assert.equal(response.status, 400);
        assert.equal(typeof (await response.json()).error, 'string');
    }
    const oversized = await request(JSON.stringify({ url: 'x'.repeat(17000) }));
    assert.equal(oversized.status, 413);
    await oversized.json();
    assert.equal(tasks.length, 0);
    const accepted = await request(JSON.stringify({ url: 'https://instagram.com/p/ABC/?igsh=x' }));
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { status: 'queued', jobId: '42' });
    assert.deepEqual(tasks, [{ url: 'https://www.instagram.com/p/ABC/', source: 'extension' }]);
});
