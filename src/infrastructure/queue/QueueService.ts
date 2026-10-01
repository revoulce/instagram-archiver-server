import { Queue, Worker, Job, UnrecoverableError } from 'bullmq';
import { ITaskQueue, IDownloader, INotifier } from '../../domain/interfaces';
import { DownloadTask, TaskCheckpoint, TaskStatus } from '../../domain/entities';
import { normalizeInstagramUrl } from '../../domain/instagramUrl';
import { taskIdentity, requiresDeliveryReview } from '../../domain/taskIdentity';
import { PermanentTaskError, TelegramRateLimitError } from '../../domain/taskErrors';
import { ProcessTask } from '../../application/ProcessTask';

type TaskData = Pick<DownloadTask, 'url' | 'source'> & { checkpoint?: TaskCheckpoint };

export class QueueService implements ITaskQueue {
    private queue: Queue<TaskData>;
    private worker: Worker<TaskData>;

    constructor(redisHost: string, redisPort: number, downloader: IDownloader, notifier: INotifier, namespace = 'instagram-tasks') {
        const connection = { host: redisHost, port: redisPort };
        // HTTP requests fail promptly while the worker keeps reconnecting in the background.
        this.queue = new Queue<TaskData>(namespace, {
            connection: { ...connection, maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 5000 },
            defaultJobOptions: {
                attempts: 3,
                backoff: { type: 'delivery', delay: 5000 },
                removeOnComplete: { age: 86400, count: 1000 },
                removeOnFail: { age: 604800, count: 5000 },
            },
        });
        const processTask = new ProcessTask(downloader, notifier);
        this.worker = new Worker<TaskData>(namespace, async (job: Job<TaskData>) => {
            console.log(`[Job ${job.id}] Processing: ${job.data.url}`);
            try {
                await processTask.execute(job.data.url, {
                    checkpoint: job.data.checkpoint,
                    finalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
                    save: async checkpoint => {
                        await job.updateData({ ...job.data, checkpoint });
                    },
                });
                return { success: true };
            } catch (error) {
                console.error(`[Job ${job.id}] Failed:`, error instanceof Error ? error.message : 'Unknown error');
                if (error instanceof PermanentTaskError) throw new UnrecoverableError(error.message);
                throw error;
            }
        }, {
            connection: { ...connection, maxRetriesPerRequest: null },
            concurrency: 1,
            settings: {
                backoffStrategy: (attemptsMade, _type, error) =>
                    error instanceof TelegramRateLimitError ? error.retryAfterMs : Math.min(60_000, 5000 * 2 ** (attemptsMade - 1)),
            },
        });
        this.queue.on('error', error => console.error('Queue connection error:', error.message));
        this.worker.on('error', error => console.error('Worker error:', error.message));
    }

    async add(taskData: Pick<DownloadTask, 'url' | 'source'>): Promise<string> {
        const url = normalizeInstagramUrl(taskData.url);
        if (!url) throw new Error('Invalid Instagram URL');
        const job = await this.queue.add('download-post', { ...taskData, url }, { jobId: taskIdentity(url) });
        if (!job.id) throw new Error('Queue did not return a task ID');
        return job.id;
    }

    async getStatus(id: string): Promise<TaskStatus | null> {
        const job = await this.queue.getJob(id);
        if (!job) return null;
        const state = await job.getState();
        const status: TaskStatus['status'] = state === 'active' ? 'processing'
            : state === 'delayed' ? 'retrying'
            : state === 'completed' || state === 'failed' ? state
            : state === 'unknown' ? 'unknown' : 'pending';
        const checkpoint = job.data.checkpoint;
        const requiresReview = status !== 'processing' && requiresDeliveryReview(checkpoint);
        return {
            id: job.id!, url: job.data.url, status,
            attemptsMade: job.attemptsMade,
            createdAt: new Date(job.timestamp).toISOString(),
            finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
            sentFiles: checkpoint?.nextFileIndex ?? 0,
            totalFiles: checkpoint?.metadata?.filePaths.length ?? null,
            messageIds: checkpoint?.messageIds ?? [],
            requiresReview,
            ...(status === 'failed' ? { error: requiresReview ? 'Check Telegram before sending this post again.' : 'Task failed. Check server logs or retry.' } : {}),
        };
    }

    async retry(id: string): Promise<'queued' | 'not_found' | 'conflict' | 'requires_review'> {
        const job = await this.queue.getJob(id);
        if (!job) return 'not_found';
        if (await job.getState() !== 'failed') return 'conflict';
        if (requiresDeliveryReview(job.data.checkpoint)) return 'requires_review';
        try {
            await job.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true });
            return 'queued';
        } catch (error) {
            // Another caller may already have retried or removed this job.
            if (!await this.queue.getJob(id)) return 'not_found';
            if (await job.getState() !== 'failed') return 'conflict';
            throw error;
        }
    }

    async isReady(): Promise<boolean> {
        if (!this.worker.isRunning()) return false;
        const client = await this.queue.client;
        if (client.status !== 'ready') return false;
        await this.queue.getJobCounts('waiting');
        return true;
    }

    async close(): Promise<void> {
        await this.worker.close();
        await this.queue.close();
    }

    async waitUntilReady(): Promise<void> {
        await Promise.all([this.queue.waitUntilReady(), this.worker.waitUntilReady()]);
    }
}
