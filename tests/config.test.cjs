const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../dist/config');
const required = { AUTH_SECRET: 'test-key', TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHANNEL_ID: '-100123' };

test('configuration has numeric defaults and requires explicit credentials', () => {
    const config = loadConfig(required);
    assert.equal(config.port, 3000);
    assert.equal(config.redisPort, 6379);
    assert.equal(config.downloadTimeoutMs, 600000);
    assert.equal(config.shutdownTimeoutMs, 30000);
    for (const name of Object.keys(required)) {
        assert.throws(() => loadConfig({ ...required, [name]: ' ' }), new RegExp(name));
    }
});

test('invalid port and timeout settings fail before services are started', () => {
    for (const name of ['PORT', 'REDIS_PORT', 'DOWNLOAD_TIMEOUT_MS', 'SHUTDOWN_TIMEOUT_MS']) {
        for (const value of ['', 'abc', '0', '-1', '1.5', 'Infinity']) {
            assert.throws(() => loadConfig({ ...required, [name]: value }), new RegExp(name));
        }
    }
    assert.throws(() => loadConfig({ ...required, PORT: '65536' }), /PORT/);
    assert.equal(loadConfig({ ...required, PORT: '4000' }).port, 4000);
});
