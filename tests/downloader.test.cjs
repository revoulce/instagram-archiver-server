const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { GalleryDLService } = require('../dist/infrastructure/downloader/GalleryDLService');
const { sessionFingerprint, classifyInstagramFailure } = require('../dist/infrastructure/downloader/instagramSession');
const { InstagramRestrictionError, InstagramWaitError } = require('../dist/domain/taskErrors');

const cookie = value => `# Netscape HTTP Cookie File\n#HttpOnly_.instagram.com\tTRUE\t/\tTRUE\t4102444800\tsessionid\t${value}\n`;
const url = 'https://www.instagram.com/p/FIXTURE/';

async function fixture(t, run) {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'archiver-download-'));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const cookies = path.join(base, 'cookies.txt');
    await fs.writeFile(cookies, cookie('fixture-session'));
    const downloads = path.join(base, 'downloads');
    return { base, cookies, downloads, service: new GalleryDLService(cookies, downloads, 12345, 10, run) };
}

test('session identity only changes with a valid new Instagram session', () => {
    const initial = sessionFingerprint(cookie('session-a'));
    assert.match(initial, /^[a-f0-9]{64}$/);
    assert.equal(initial, sessionFingerprint(cookie('session-a') + '# changed comment\n'));
    assert.notEqual(initial, sessionFingerprint(cookie('session-b')));
    for (const value of ['', 'invalid', cookie(''), cookie('x').replace('4102444800', '1'),
        cookie('x').replace('.instagram.com', '.evil.com'), cookie('x').replace('4102444800', 'invalid')]) {
        assert.equal(sessionFingerprint(value), null);
    }
});

test('classifies rate limits and authentication failures without exposing response text', () => {
    for (const message of ["[instagram][error] HttpError: '429 Too Many Requests'", 'Please wait a few minutes']) {
        assert.equal(classifyInstagramFailure(message, 'hash').reason, 'rate_limited');
    }
    for (const message of ['HTTP redirect to login page (url)', 'HTTP redirect to challenge page (url)',
        'challenge_required', 'login_required', 'feedback_required', "'403 Forbidden'", 'We suspect automated behavior', "KeyError: 'items'"]) {
        const error = classifyInstagramFailure(message, 'hash');
        assert.equal(error.reason, 'auth_required');
        assert.equal(error.sessionFingerprint, 'hash');
        assert.ok(!error.message.includes(message));
    }
    assert.equal(classifyInstagramFailure('429 retry_after: 7200', 'hash').retryAfterMs, 7200000);
    assert.equal(classifyInstagramFailure('404 Not Found', 'hash'), null);
    assert.equal(classifyInstagramFailure('429 challenge_required', 'hash').reason, 'auth_required');
});

test('single-pass downloader preserves album order and reads matching metadata sidecars', async t => {
    let calls = 0;
    const f = await fixture(t, async (args, options) => {
        calls++;
        const directory = args[args.indexOf('--directory') + 1];
        assert.equal(await fs.readFile(args[args.indexOf('--cookies') + 1], 'utf8'), cookie('fixture-session'));
        assert.ok(args.includes('--write-metadata'));
        assert.ok(!args.includes('--dump-json'));
        assert.equal(args[args.indexOf('--retries') + 1], '0');
        assert.equal(args[args.indexOf('--sleep-request') + 1], '10');
        assert.equal(options.timeout, 12345);
        // Creation order and media IDs do not define album order.
        for (const [num, id] of [[2, '100'], [1, '999']]) {
            const file = path.join(directory, `${String(num).padStart(4, '0')}_${id}.jpg`);
            await fs.writeFile(file, 'media');
            await fs.writeFile(`${file}.json`, JSON.stringify({ num, count: 2, post_id: 'post',
                username: 'author', fullname: 'Author', description: 'caption', likes: 5, date: '2026-10-05' }));
        }
        return { stdout: '', stderr: '' };
    });
    const metadata = await f.service.download(url, await f.service.getSessionFingerprint());
    assert.equal(calls, 1);
    assert.deepEqual(metadata.filePaths.map(file => path.basename(file)), ['0001_999.jpg', '0002_100.jpg']);
    assert.equal(metadata.description, 'caption');
    assert.equal(metadata.mediaType, 'album');
    assert.equal(metadata.likes, 5);
    await assert.rejects(fs.stat(path.join(metadata.downloadDirectory, '.cookies.txt')), { code: 'ENOENT' });
});

test('cookie replacement between admission and launch sends no request', async t => {
    let calls = 0;
    const f = await fixture(t, async () => { calls++; return { stdout: '', stderr: '' }; });
    const oldFingerprint = await f.service.getSessionFingerprint();
    await fs.writeFile(f.cookies, cookie('replacement'));
    await assert.rejects(f.service.download(url, oldFingerprint), InstagramWaitError);
    assert.equal(calls, 0);
    await fs.unlink(f.cookies);
    assert.equal(await f.service.getSessionFingerprint(), null);
    await assert.rejects(f.service.download(url), error => error.reason === 'cookies_required');
    assert.equal(calls, 0);
});

test('restriction after partial download discards media and keeps the original session identity', async t => {
    let f;
    f = await fixture(t, async args => {
        const directory = args[args.indexOf('--directory') + 1];
        await fs.writeFile(path.join(directory, '0001_fixture.jpg'), 'partial');
        await fs.writeFile(f.cookies, cookie('new-session'));
        throw Object.assign(new Error('raw secret response'), { stderr: "[instagram][error] HttpError: '429 Too Many Requests'" });
    });
    const fingerprint = await f.service.getSessionFingerprint();
    await assert.rejects(f.service.download(url, fingerprint), error =>
        error instanceof InstagramRestrictionError && error.reason === 'rate_limited' && error.sessionFingerprint === fingerprint);
    assert.deepEqual(await fs.readdir(f.downloads), []);
});

test('incomplete album and failed process cannot be published or leak raw stderr', async t => {
    const f = await fixture(t, async args => {
        const directory = args[args.indexOf('--directory') + 1];
        const file = path.join(directory, '0001_fixture.jpg');
        await fs.writeFile(file, 'partial');
        await fs.writeFile(`${file}.json`, JSON.stringify({ num: 1, count: 2, post_id: 'post', username: 'a' }));
        return { stdout: '', stderr: '' };
    });
    await assert.rejects(f.service.download(url), /incomplete/);
    assert.deepEqual(await fs.readdir(f.downloads), []);
    f.service.runGallery = async () => { throw Object.assign(new Error('sessionid=SECRET'), { stderr: 'signed-url=SECRET' }); };
    await assert.rejects(f.service.download(url), error => error.message === 'gallery-dl download failed');
});
