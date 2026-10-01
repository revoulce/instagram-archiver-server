const test = require('node:test');
const assert = require('node:assert/strict');
const { GrammyError, HttpError } = require('grammy');
const { GrammyService } = require('../dist/infrastructure/telegram/GrammyService');
const { ProcessTask } = require('../dist/application/ProcessTask');
const { DeliveryUncertainError, TelegramRateLimitError, PermanentTaskError } = require('../dist/domain/taskErrors');

const url = 'https://www.instagram.com/p/ABC/';
const metadata = {
    description: '', author: 'author', likes: 0, uploadDate: '', mediaType: 'album',
    downloadDirectory: 'test-directory', filePaths: Array.from({ length: 11 }, (_, i) => `${i}.jpg`),
};
const rejected = code => new GrammyError('Rejected', {
    ok: false, error_code: code, description: 'Rejected', parameters: { retry_after: 13 },
}, 'sendPhoto', {});

function harness(options = {}) {
    let checkpoint = options.checkpoint;
    let downloads = 0;
    let cleaned = 0;
    let sends = 0;
    const service = new GrammyService('123:test-token', '-100123');
    service.bot.api.sendMediaGroup = async (_channel, media) => {
        sends++;
        if (options.groupError) throw options.groupError;
        return media.map((_, index) => ({ message_id: index + 1 }));
    };
    service.bot.api.sendPhoto = async () => {
        sends++;
        if (options.singleError) throw options.singleError;
        return { message_id: 11 };
    };
    const downloader = {
        download: async () => { downloads++; return metadata; },
        cleanup: async () => { cleaned++; },
        isAvailable: async () => options.available !== false,
    };
    const task = new ProcessTask(downloader, service);
    const run = finalAttempt => task.execute(url, {
        checkpoint: structuredClone(checkpoint), finalAttempt,
        save: async next => {
            if (options.saveError?.(next)) throw new Error('Redis unavailable');
            checkpoint = structuredClone(next);
        },
    });
    return { run, state: () => checkpoint, downloads: () => downloads, cleaned: () => cleaned,
        sends: () => sends, service };
}

test('retry resumes after confirmed first group without downloading or sending it again', async () => {
    const h = harness({ singleError: rejected(429) });
    await assert.rejects(h.run(false), TelegramRateLimitError);
    assert.equal(h.state().nextFileIndex, 10);
    assert.deepEqual(h.state().messageIds, [1,2,3,4,5,6,7,8,9,10]);
    assert.equal(h.state().pendingFileIndex, undefined);
    assert.equal(h.cleaned(), 0);
    h.service.bot.api.sendPhoto = async () => ({ message_id: 11 });
    await h.run(true);
    assert.equal(h.downloads(), 1);
    assert.equal(h.state().nextFileIndex, 11);
    assert.equal(h.cleaned(), 1);
});

test('network failure leaves an uncertain delivery marker and cannot be automatically repeated', async () => {
    const h = harness({ singleError: new HttpError('Lost response', new Error('Connection reset')) });
    await assert.rejects(h.run(false), DeliveryUncertainError);
    assert.equal(h.state().pendingFileIndex, 10);
    const sends = h.sends();
    await assert.rejects(h.run(true), DeliveryUncertainError);
    assert.equal(h.sends(), sends);
    assert.equal(h.state().nextFileIndex, 10);
});

test('failure to persist a confirmed Telegram send cannot cause a duplicate batch', async () => {
    const h = harness({ saveError: next => next.nextFileIndex === 10 && next.pendingFileIndex === undefined });
    await assert.rejects(h.run(false), DeliveryUncertainError);
    assert.equal(h.state().pendingFileIndex, 0);
    assert.equal(h.sends(), 1);
    await assert.rejects(h.run(true), DeliveryUncertainError);
    assert.equal(h.sends(), 1);
});

test('failure to persist the pre-send marker prevents the Telegram call', async () => {
    const h = harness({ saveError: next => next.pendingFileIndex === 0 });
    await assert.rejects(h.run(false), /Redis unavailable/);
    assert.equal(h.sends(), 0);
});

test('restart after final confirmed batch only cleans files', async () => {
    const h = harness({ checkpoint: { metadata, nextFileIndex: 11, messageIds: [1,11] }, available: false });
    await h.run(true);
    assert.equal(h.downloads(), 0);
    assert.equal(h.sends(), 0);
    assert.equal(h.cleaned(), 1);
});

test('missing media after partial delivery stops for review instead of re-downloading', async () => {
    const h = harness({ checkpoint: { metadata, nextFileIndex: 10, messageIds: [1] }, available: false });
    await assert.rejects(h.run(false), DeliveryUncertainError);
    assert.equal(h.state().filesDiscarded, true);
    assert.equal(h.downloads(), 0);
    assert.equal(h.sends(), 0);
});

test('expired files before any delivery can be re-downloaded safely', async () => {
    const h = harness({ checkpoint: { metadata, nextFileIndex: 0, messageIds: [], filesDiscarded: true } });
    await h.run(true);
    assert.equal(h.downloads(), 1);
    assert.equal(h.state().nextFileIndex, 11);
});

test('definite Telegram rejection is permanent and clears pending marker', async () => {
    const h = harness({ groupError: rejected(403) });
    await assert.rejects(h.run(false), PermanentTaskError);
    assert.equal(h.state().pendingFileIndex, undefined);
    assert.equal(h.state().filesDiscarded, true);
    assert.equal(h.cleaned(), 1);
});

test('Telegram rate limiting respects retry_after', async () => {
    const h = harness({ groupError: rejected(429) });
    await assert.rejects(h.run(false), error => error instanceof TelegramRateLimitError && error.retryAfterMs === 13000);
    assert.equal(h.state().pendingFileIndex, undefined);
    assert.equal(h.cleaned(), 0);
});
