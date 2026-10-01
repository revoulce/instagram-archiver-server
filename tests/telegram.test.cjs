const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCaption } = require('../dist/infrastructure/telegram/caption');
const { GrammyService } = require('../dist/infrastructure/telegram/GrammyService');
const url = 'https://www.instagram.com/p/ABC/';
const metadata = { description: '', author: 'author', likes: 12, uploadDate: '', downloadDirectory: '', filePaths: [], mediaType: 'album' };

function visibleText(html) {
    return html.replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

test('long captions preserve complete HTML, author and original link', () => {
    for (const description of ['<&>'.repeat(1000), '😀'.repeat(1000), 'x'.repeat(1019) + '&']) {
        const caption = buildCaption({ ...metadata, description }, url);
        assert.ok(visibleText(caption).length <= 1024);
        assert.match(caption, /<b>author<\/b>/);
        assert.ok(caption.endsWith(`<a href="${url}">Original Link</a>`));
        assert.ok(!caption.includes('\uFFFD'));
        assert.equal(visibleText(caption).isWellFormed(), true);
    }
});

test('caption escapes external text and bounds oversized author', () => {
    const caption = buildCaption({ ...metadata, description: '<b>external</b>', author: '<script>&'.repeat(200) }, url + '?x="&');
    assert.ok(!caption.includes('<script>'));
    assert.ok(caption.includes('&lt;b&gt;external&lt;/b&gt;'));
    assert.ok(caption.includes('?x=&quot;&amp;'));
    assert.ok(visibleText(caption).length <= 1024);
});

for (const count of [1, 2, 10, 11, 20, 21]) {
    test(`send ${count} media files without a one-item media group`, async () => {
        const service = new GrammyService('123:test-token', '-100123');
        const calls = [];
        service.bot.api.sendMediaGroup = async (_channel, media) => { calls.push({ type: 'group', media }); return media.map((_, index) => ({ message_id: index + 1 })); };
        service.bot.api.sendPhoto = async (_channel, media, options) => { calls.push({ type: 'photo', media: [{ media, ...options }] }); return { message_id: 100 }; };
        service.bot.api.sendVideo = async (_channel, media, options) => { calls.push({ type: 'video', media: [{ media, ...options }] }); return { message_id: 101 }; };
        const filePaths = Array.from({ length: count }, (_, index) => index === count - 1 ? `${index}.MP4` : `${index}.jpg`);
        await service.sendPost({ ...metadata, filePaths }, url);
        assert.equal(calls.flatMap(call => call.media).length, count);
        for (const call of calls.filter(call => call.type === 'group')) {
            assert.ok(call.media.length >= 2 && call.media.length <= 10);
        }
        assert.equal(calls.flatMap(call => call.media).filter(item => item.caption).length, 1);
        if (count % 10 === 1) assert.equal(calls.at(-1).type, 'video');
    });
}

test('empty media is rejected before any Telegram request', async () => {
    const service = new GrammyService('123:test-token', '-100123');
    await assert.rejects(service.sendPost(metadata, url), /without media/);
});
