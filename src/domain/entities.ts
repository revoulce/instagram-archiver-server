export interface DownloadTask {
    id: string;
    url: string;
    source: 'extension';
    status: 'pending' | 'processing' | 'completed' | 'failed';
    createdAt: Date;
    error?: string;
}

export interface MediaMetadata {
    downloadDirectory: string;
    description: string;
    author: string;
    likes: number;
    uploadDate: string;
    filePaths: string[];
    mediaType: 'image' | 'video' | 'album';
}

export interface TaskCheckpoint {
    metadata?: MediaMetadata;
    nextFileIndex: number;
    messageIds: number[];
    pendingFileIndex?: number;
    filesDiscarded?: boolean;
}

export interface TaskStatus {
    id: string;
    url: string;
    status: 'pending' | 'processing' | 'retrying' | 'completed' | 'failed' | 'unknown';
    attemptsMade: number;
    createdAt: string;
    finishedAt: string | null;
    sentFiles: number;
    totalFiles: number | null;
    messageIds: number[];
    requiresReview: boolean;
    error?: string;
}
