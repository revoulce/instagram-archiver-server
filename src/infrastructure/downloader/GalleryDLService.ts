import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { IDownloader } from '../../domain/interfaces';
import { MediaMetadata } from '../../domain/entities';
import { randomUUID } from 'crypto';

const execFileAsync = promisify(execFile);

export class GalleryDLService implements IDownloader {
    private cookiesPath: string;
    private downloadBasePath: string;

    constructor(cookiesPath: string, downloadBasePath: string, private timeoutMs = 600_000) {
        this.cookiesPath = cookiesPath;
        this.downloadBasePath = path.resolve(downloadBasePath);
    }

    async download(url: string): Promise<MediaMetadata> {
        const taskId = randomUUID();
        const taskDir = path.join(this.downloadBasePath, taskId);
        await fs.mkdir(taskDir, { recursive: true });

        try {
            console.log(`[GalleryDL] Fetching metadata for: ${url}`);

            const { stdout: metaStdout } = await execFileAsync('gallery-dl', [
                '--cookies', this.cookiesPath,
                '--dump-json',
                '--no-download',
                url
            ], { maxBuffer: 1024 * 1024 * 50, timeout: this.timeoutMs });

            let metaRaw: any = null;

            try {
                const fullJson = JSON.parse(metaStdout);
                metaRaw = this.findMetadataInJson(fullJson);
            } catch (e) {
                const lines = metaStdout.split('\n').filter(l => l.trim().length > 0);
                for (const line of lines) {
                    try {
                        const json = JSON.parse(line);
                        const found = this.findMetadataInJson(json);
                        if (found) {
                            metaRaw = found;
                            break;
                        }
                    } catch (ignore) {}
                }
            }

            if (!metaRaw) {
                throw new Error('Could not find valid metadata in gallery-dl output');
            }

            console.log(`[GalleryDL] Metadata found (Author: ${metaRaw.username}). Downloading...`);

            await execFileAsync('gallery-dl', [
                '--cookies', this.cookiesPath,
                '--directory', taskDir,
                url
            ], { maxBuffer: 1024 * 1024 * 50, timeout: this.timeoutMs });

            const files = await fs.readdir(taskDir, { withFileTypes: true });
            const filePaths = files
                .filter(file => file.isFile() && /\.(jpe?g|png|webp|mp4)$/i.test(file.name))
                .map(file => path.join(taskDir, file.name));

            if (filePaths.length === 0) {
                throw new Error('Gallery-dl finished but no files were found.');
            }

            const isVideo = filePaths.some(f => path.extname(f).toLowerCase() === '.mp4');
            const mediaType = filePaths.length > 1 ? 'album' : (isVideo ? 'video' : 'image');

            return {
                downloadDirectory: taskDir,
                description: metaRaw.description || metaRaw.caption || '',
                author: metaRaw.fullname || metaRaw.username || 'unknown',
                likes: metaRaw.likes || 0,
                uploadDate: metaRaw.date || new Date().toISOString(),
                filePaths: filePaths,
                mediaType: mediaType
            };

        } catch (error) {
            await fs.rm(taskDir, { recursive: true, force: true }).catch(() => {});
            throw error;
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
        } catch {
            return false;
        }
    }

    private findMetadataInJson(obj: any): any {
        if (!obj || typeof obj !== 'object') return null;

        if (obj.username && (obj.description !== undefined || obj.likes !== undefined || obj.post_id !== undefined)) {
            return obj;
        }

        if (Array.isArray(obj)) {
            for (const item of obj) {
                const found = this.findMetadataInJson(item);
                if (found) return found;
            }
        } else {
            for (const key in obj) {
                const found = this.findMetadataInJson(obj[key]);
                if (found) return found;
            }
        }

        return null;
    }
}
