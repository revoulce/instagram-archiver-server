import { Queue, Worker, Job } from 'bullmq';
import { ITaskQueue, IDownloader, INotifier } from '../../domain/interfaces';
import { DownloadTask } from '../../domain/entities';

export class QueueService implements ITaskQueue {
    private queue: Queue;
    private worker: Worker;

    constructor(
        redisHost: string,
        redisPort: number,
        private downloader: IDownloader,
        private notifier: INotifier
    ) {
        const connection = { host: redisHost, port: redisPort };

        this.queue = new Queue('instagram-tasks', { connection });

        this.worker = new Worker('instagram-tasks', async (job: Job) => {
            const { url } = job.data;
            console.log(`[Job ${job.id}] Processing: ${url}`);

            try {
                const metadata = await this.downloader.download(url);

                await this.notifier.sendPost(metadata, url);

                console.log(`[Job ${job.id}] Completed successfully.`);
                return { success: true };

            } catch (error: any) {
                console.error(`[Job ${job.id}] Failed:`, error);
                throw error;
            }
        }, { connection });
    }

    async add(taskData: Omit<DownloadTask, 'id' | 'status' | 'createdAt'>): Promise<string> {
        const job = await this.queue.add('download-post', taskData, {
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 5000,
            }
        });
        return job.id || '';
    }
}