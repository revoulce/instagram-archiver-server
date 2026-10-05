import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { IDownloader } from '../../domain/interfaces';
import { MediaMetadata } from '../../domain/entities';
import { randomUUID } from 'crypto';
import { InstagramRestrictionError, InstagramWaitError } from '../../domain/taskErrors';
import { classifyInstagramFailure, sessionFingerprint } from './instagramSession';

const execFileAsync = promisify(execFile);
type GalleryRunner = (args: string[], options: { maxBuffer: number; timeout: number }) => Promise<{ stdout: string; stderr: string }>;

export class GalleryDLService implements IDownloader {
    private downloadBasePath: string;

    constructor(
        private cookiesPath: string,
        downloadBasePath: string,
        private timeoutMs = 600_000,
        private requestIntervalSeconds = 10,
        private runGallery: GalleryRunner = (args, options) => execFileAsync('gallery-dl', args, options),
    ) {
        this.downloadBasePath = path.resolve(downloadBasePath);
    }

    async getSessionFingerprint(): Promise<string | null> {
        try { return sessionFingerprint(await fs.readFile(this.cookiesPath, 'utf8')); }
        catch { return null; }
    }

    async download(url: string, expectedSessionFingerprint?: string): Promise<MediaMetadata> {
        const taskDir = path.join(this.downloadBasePath, randomUUID());
        const cookieSnapshot = path.join(taskDir, '.cookies.txt');
        await fs.mkdir(taskDir, { recursive: true });

        try {
            let contents: string;
            try { contents = await fs.readFile(this.cookiesPath, 'utf8'); }
            catch { throw new InstagramRestrictionError('cookies_required', ''); }
            const fingerprint = sessionFingerprint(contents) ?? '';
            if (!fingerprint) throw new InstagramRestrictionError('cookies_required', '');
            // Admit replacement cookies through the shared gate before using them.
            if (expectedSessionFingerprint && expectedSessionFingerprint !== fingerprint) {
                throw new InstagramWaitError('pacing', 1000);
            }
            await fs.writeFile(cookieSnapshot, contents, { mode: 0o600 });
            console.log(`[GalleryDL] Downloading: ${url}`);
            let stderr: string;
            try {
                ({ stderr } = await this.runGallery([
                    '--config-ignore', '--no-input', '--no-colors',
                    '--cookies', cookieSnapshot,
                    '--directory', taskDir,
                    '--filename', '{num:04}_{media_id}.{extension}',
                    '--write-metadata', '--retries', '0',
                    '--sleep-request', String(this.requestIntervalSeconds),
                    '-o', 'extractor.instagram.sleep-429=0', url,
                ], { maxBuffer: 1024 * 1024 * 50, timeout: this.timeoutMs }));
            } catch (error) {
                const failure = error as { stderr?: string; killed?: boolean };
                const restriction = classifyInstagramFailure(failure.stderr ?? '', fingerprint);
                if (restriction) throw restriction;
                // execFile errors include raw API fragments and signed URLs.
                throw new Error(failure.killed ? 'Instagram download timed out' : 'gallery-dl download failed');
            }
            const restriction = classifyInstagramFailure(stderr, fingerprint);
            if (restriction) throw restriction;

            const files = await fs.readdir(taskDir, { withFileTypes: true });
            const filePaths = files
                .filter(file => file.isFile() && /\.(jpe?g|png|webp|mp4)$/i.test(file.name))
                .map(file => path.join(taskDir, file.name)).sort();
            if (!filePaths.length) throw new Error('Gallery-dl finished but no files were found');

            // Sidecars are produced by the same extraction as their media files.
            // Require complete metadata to avoid publishing a partial album.
            const metadata = await Promise.all(filePaths.map(async file => JSON.parse(await fs.readFile(`${file}.json`, 'utf8'))));
            const first = metadata[0];
            if (!first.username || !first.post_id ||
                metadata.some(item => item.post_id !== first.post_id || item.count !== filePaths.length) ||
                new Set(metadata.map(item => item.num)).size !== filePaths.length) {
                throw new Error('Gallery-dl returned incomplete or inconsistent post metadata');
            }
            const isVideo = filePaths.some(file => path.extname(file).toLowerCase() === '.mp4');
            return {
                downloadDirectory: taskDir,
                description: first.description || first.caption || '',
                author: first.fullname || first.username || 'unknown',
                likes: first.likes || 0,
                uploadDate: first.date || new Date().toISOString(),
                filePaths,
                mediaType: filePaths.length > 1 ? 'album' : isVideo ? 'video' : 'image',
            };
        } catch (error) {
            await fs.rm(taskDir, { recursive: true, force: true }).catch(() => {});
            throw error;
        } finally {
            await fs.rm(cookieSnapshot, { force: true }).catch(() => {});
        }
    }

    async cleanup(metadata: MediaMetadata): Promise<void> {
        const directory = path.resolve(metadata.downloadDirectory);
        if (path.dirname(directory) !== this.downloadBasePath ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path.basename(directory))) {
            throw new Error('Refusing to clean a directory outside the task workspace');
        }
        await fs.rm(directory, { recursive: true, force: true });
    }

    async isAvailable(metadata: MediaMetadata): Promise<boolean> {
        const directory = path.resolve(metadata.downloadDirectory);
        if (path.dirname(directory) !== this.downloadBasePath || !metadata.filePaths.length) return false;
        try {
            for (const file of metadata.filePaths) {
                if (path.dirname(path.resolve(file)) !== directory || !(await fs.lstat(file)).isFile()) return false;
            }
            return true;
        } catch { return false; }
    }
}
