const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ProcessTask } = require('../dist/application/ProcessTask');
const { GalleryDLService } = require('../dist/infrastructure/downloader/GalleryDLService');

test('task processing cleans files after success and preserves a send error', async () => {
    for (const failure of [false, true]) {
        const steps = [];
        const metadata = { filePaths: ['image.jpg'] };
        const error = new Error('Telegram unavailable');
        const downloader = {
            download: async () => { steps.push('download'); return metadata; },
            cleanup: async value => { assert.equal(value, metadata); steps.push('cleanup'); },
        };
        const notifier = { sendPost: async value => { assert.equal(value, metadata); steps.push('send'); if (failure) throw error; } };
        const task = new ProcessTask(downloader, notifier);
        if (failure) await assert.rejects(task.execute('url'), error);
        else await task.execute('url');
        assert.deepEqual(steps, ['download', 'send', 'cleanup']);
    }
});

test('cleanup failure does not retry an already published post', async t => {
    t.mock.method(console, 'error', () => {});
    const task = new ProcessTask({
        download: async () => ({}), cleanup: async () => { throw new Error('Disk unavailable'); },
    }, { sendPost: async () => {} });
    await assert.doesNotReject(task.execute('url'));
});

test('downloader cleanup removes only its UUID task directory', async t => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'archiver-cleanup-'));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const directory = path.join(base, randomUUID());
    const sibling = path.join(base, randomUUID());
    await fs.mkdir(directory);
    await fs.mkdir(sibling);
    await fs.writeFile(path.join(directory, 'media.jpg'), 'fixture');
    const service = new GalleryDLService('cookies.txt', base);
    for (const target of [base, path.dirname(base), path.join(base, 'not-a-task'), path.join(base, randomUUID(), randomUUID())]) {
        await assert.rejects(service.cleanup({ downloadDirectory: target }), /Refusing/);
    }
    await service.cleanup({ downloadDirectory: directory });
    await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
    assert.equal((await fs.stat(sibling)).isDirectory(), true);
});
