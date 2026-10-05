import { DownloadTask, MediaMetadata, TaskCheckpoint, TaskStatus } from './entities';

export interface IDownloader {
    download(url: string, expectedSessionFingerprint?: string): Promise<MediaMetadata>;
    getSessionFingerprint?(): Promise<string | null>;
    cleanup(metadata: MediaMetadata): Promise<void>;
    isAvailable(metadata: MediaMetadata): Promise<boolean>;
}

export interface DeliveryOptions {
    startFileIndex: number;
    onBatchStart(fileIndex: number): Promise<void>;
    onBatchSent(nextFileIndex: number, messageIds: number[]): Promise<void>;
    onBatchRejected(): Promise<void>;
}

export interface TaskExecutionContext {
    checkpoint?: TaskCheckpoint;
    save(checkpoint: TaskCheckpoint): Promise<void>;
    finalAttempt: boolean;
}

export interface INotifier {
    sendPost(metadata: MediaMetadata, originalUrl: string, options?: DeliveryOptions): Promise<void>;

    sendError(error: string): Promise<void>;
}

export interface ITaskQueue {
    add(task: Omit<DownloadTask, 'id' | 'status' | 'createdAt'>): Promise<string>;
    getStatus(id: string): Promise<TaskStatus | null>;
    retry(id: string): Promise<'queued' | 'not_found' | 'conflict' | 'requires_review'>;
}
