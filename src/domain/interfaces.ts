import {DownloadTask, MediaMetadata} from "./entities";

export interface IDownloader {
    download(url: string): Promise<MediaMetadata>;
    cleanup(metadata: MediaMetadata): Promise<void>;
}

export interface INotifier {
    sendPost(metadata: MediaMetadata, originalUrl: string): Promise<void>;

    sendError(error: string): Promise<void>;
}

export interface ITaskQueue {
    add(task: Omit<DownloadTask, 'id' | 'status' | 'createdAt'>): Promise<string>;
}
