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
    assert.equal(config.instagramMinIntervalMs, 60000);
    assert.equal(config.instagramRequestIntervalSeconds, 10);
    assert.equal(config.instagramRateLimitCooldownMs, 3600000);
    assert.equal(config.instagramCookiesPollMs, 30000);
    assert.equal(config.instagramMetadataRetryIntervalMs, 3600000);
    assert.equal(loadConfig({ ...required, INSTAGRAM_METADATA_RETRY_INTERVAL_MS: '0' }).instagramMetadataRetryIntervalMs, 0);
    assert.equal(loadConfig({ ...required, INSTAGRAM_METADATA_RETRY_INTERVAL_MS: '7200000' }).instagramMetadataRetryIntervalMs, 7200000);
    for (const name of Object.keys(required)) {
        assert.throws(() => loadConfig({ ...required, [name]: ' ' }), new RegExp(name));
    }
});

test('invalid port and timeout settings fail before services are started', () => {
    for (const name of ['PORT', 'REDIS_PORT', 'DOWNLOAD_TIMEOUT_MS', 'SHUTDOWN_TIMEOUT_MS',
        'INSTAGRAM_MIN_INTERVAL_MS', 'INSTAGRAM_REQUEST_INTERVAL_SECONDS', 'INSTAGRAM_RATE_LIMIT_COOLDOWN_MS', 'INSTAGRAM_COOKIES_POLL_MS']) {
        for (const value of ['', 'abc', '0', '-1', '1.5', 'Infinity']) {
            assert.throws(() => loadConfig({ ...required, [name]: value }), new RegExp(name));
        }
    }
    assert.throws(() => loadConfig({ ...required, PORT: '65536' }), /PORT/);
    assert.equal(loadConfig({ ...required, PORT: '4000' }).port, 4000);
    for (const value of ['', 'abc', '-1', '1.5', 'Infinity', '2147483648']) {
        assert.throws(() => loadConfig({ ...required, INSTAGRAM_METADATA_RETRY_INTERVAL_MS: value }), /INSTAGRAM_METADATA_RETRY_INTERVAL_MS/);
    }
});
