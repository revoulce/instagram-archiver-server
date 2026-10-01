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
