import { IDownloader, INotifier } from '../domain/interfaces';

export class ProcessTask {
    constructor(private downloader: IDownloader, private notifier: INotifier) {}

    async execute(url: string): Promise<void> {
        const metadata = await this.downloader.download(url);
        try {
            await this.notifier.sendPost(metadata, url);
        } finally {
            // A cleanup failure must not cause a successfully published post to be retried.
            await this.downloader.cleanup(metadata).catch(error => {
                console.error('Failed to clean task files:', error);
            });
        }
    }
}
