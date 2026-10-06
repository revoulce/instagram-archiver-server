import { Queue, Worker, Job, UnrecoverableError, DelayedError } from 'bullmq';
import { ITaskQueue, IDownloader, INotifier } from '../../domain/interfaces';
import { DownloadTask, TaskCheckpoint, TaskStatus } from '../../domain/entities';
import { normalizeInstagramUrl } from '../../domain/instagramUrl';
import { taskIdentity, requiresDeliveryReview } from '../../domain/taskIdentity';
import { PermanentTaskError, TelegramRateLimitError, InstagramRestrictionError, InstagramWaitError, InstagramWaitReason } from '../../domain/taskErrors';
import { ProcessTask } from '../../application/ProcessTask';
import { InstagramSessionGate, InstagramQueueOptions } from './InstagramSessionGate';
import { randomUUID } from 'crypto';

type TaskData = Pick<DownloadTask, 'url' | 'source'> & {
    checkpoint?: TaskCheckpoint;
    instagramWait?: { reason: InstagramWaitReason; checkAt: number };
};

export class QueueService implements ITaskQueue {
    private queue: Queue<TaskData>;
    private worker: Worker<TaskData>;
    private startup: Promise<void>;
    private metadataRetryIntervalMs: number;
    private retryTimer?: NodeJS.Timeout;
    private retrySweep?: Promise<number>;
    private closing = false;

    constructor(redisHost: string, redisPort: number, downloader: IDownloader, notifier: INotifier, namespace = 'instagram-tasks', options: InstagramQueueOptions & { metadataRetryIntervalMs?: number } = {}) {
        this.metadataRetryIntervalMs = options.metadataRetryIntervalMs ?? 3_600_000;
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
        const gate = new InstagramSessionGate(() => this.queue.client, this.queue.toKey('instagram-session'), options);
        const processTask = new ProcessTask({
            download: async url => {
                const fingerprint = downloader.getSessionFingerprint ? await downloader.getSessionFingerprint() : 'anonymous';
                await gate.reserve(fingerprint);
                try { return await downloader.download(url, fingerprint ?? undefined); }
                catch (error) {
                    if (error instanceof InstagramRestrictionError) {
                        const waiting = await gate.restrict(error);
                        console.warn(`[Instagram] Downloads paused: ${error.reason}. ${error.reason === 'rate_limited' ? 'Waiting for cooldown.' : 'Replace cookies.txt with a new login session.'}`);
                        throw waiting;
                    }
                    throw error;
                }
            },
            cleanup: metadata => downloader.cleanup(metadata),
            isAvailable: metadata => downloader.isAvailable(metadata),
        }, notifier);
        this.worker = new Worker<TaskData>(namespace, async (job: Job<TaskData>, token?: string) => {
            try {
                if (job.data.instagramWait) await job.updateData({ ...job.data, instagramWait: undefined });
                await processTask.execute(job.data.url, {
                    checkpoint: job.data.checkpoint,
                    finalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
                    save: async checkpoint => {
                        await job.updateData({ ...job.data, checkpoint });
                    },
                });
                return { success: true };
            } catch (error) {
                if (error instanceof InstagramWaitError) {
                    const checkAt = Date.now() + error.delayMs;
                    await job.updateData({ ...job.data, instagramWait: { reason: error.reason, checkAt } });
                    await job.moveToDelayed(checkAt, token);
                    throw new DelayedError();
                }
                console.error(`[Job ${job.id}] Failed:`, error instanceof Error ? error.message : 'Unknown error');
                if (error instanceof PermanentTaskError) throw new UnrecoverableError(error.message);
                throw error;
            }
        }, {
            connection: { ...connection, maxRetriesPerRequest: null },
            autorun: false,
            concurrency: 1,
            settings: {
                backoffStrategy: (attemptsMade, _type, error) =>
                    error instanceof TelegramRateLimitError ? error.retryAfterMs : Math.min(60_000, 5000 * 2 ** (attemptsMade - 1)),
            },
        });
        this.queue.on('error', error => console.error('Queue connection error:', error.message));
        this.worker.on('error', error => console.error('Worker error:', error.message));
        // Serialise replicas sharing this queue, not just this worker process.
        this.startup = this.worker.client.then(async client => {
            // The worker connection keeps reconnecting if Redis is unavailable
            // at startup; the HTTP queue connection intentionally fails fast.
            await client.hset(this.queue.toKey('meta'), { concurrency: 1 });
            await this.queue.waitUntilReady();
            await this.retryMetadataFailures();
            if (this.closing) return;
            if (this.metadataRetryIntervalMs > 0) {
                this.retryTimer = setInterval(() => { void this.retryMetadataFailures(); }, this.metadataRetryIntervalMs);
                this.retryTimer.unref();
            }
            void this.worker.run().catch(error => console.error('Worker stopped:', error.message));
        });
        this.startup.catch(error => console.error('Queue startup failed:', error.message));
    }

    async add(taskData: Pick<DownloadTask, 'url' | 'source'>): Promise<string> {
        const url = normalizeInstagramUrl(taskData.url);
        if (!url) throw new Error('Invalid Instagram URL');
        const job = await this.queue.add('download-post', { ...taskData, url }, { jobId: taskIdentity(url) });
        if (!job.id) throw new Error('Queue did not return a task ID');
        return job.id;
    }

    async getStatus(id: string): Promise<TaskStatus | null> {
        let job = await this.queue.getJob(id);
        if (!job) return null;
        const state = await job.getState();
        // The worker can persist its final checkpoint after getJob but before getState.
        // Once a terminal state is observed, reload the snapshot that preceded it.
        if (state === 'completed' || state === 'failed') {
            job = await this.queue.getJob(id);
            if (!job) return null;
        }
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
            ...(status === 'retrying' && job.data.instagramWait ? {
                waitingReason: job.data.instagramWait.reason,
                nextCheckAt: new Date(job.data.instagramWait.checkAt).toISOString(),
            } : {}),
            ...(status === 'failed' ? { error: requiresReview ? 'Check Telegram before sending this post again.' : 'Task failed. Check server logs or retry.' } : {}),
        };
    }

    async retry(id: string): Promise<'queued' | 'not_found' | 'conflict' | 'requires_review'> {
        let job = await this.queue.getJob(id);
        if (!job) return 'not_found';
        if (await job.getState() !== 'failed') return 'conflict';
        // Do not decide whether delivery is safe using a snapshot read while the
        // previous attempt was still running.
        job = await this.queue.getJob(id);
        if (!job) return 'not_found';
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

    private canAutomaticallyRetry(job: Job<TaskData>): boolean {
        const checkpoint = job.data.checkpoint;
        return job.failedReason?.startsWith('Gallery-dl returned incomplete or inconsistent post metadata') === true &&
            !requiresDeliveryReview(checkpoint) &&
            (checkpoint?.nextFileIndex ?? 0) === 0 && !(checkpoint?.messageIds?.length);
    }

    // Startup and timer scans share a Redis cooldown across replicas/restarts.
    // A fresh generation and delivery checkpoint are checked before each retry.
    private async retryMetadataFailures(): Promise<number> {
        if (this.closing || !this.metadataRetryIntervalMs) return 0;
        if (this.retrySweep) return this.retrySweep;
        this.retrySweep = this.sweepMetadataFailures().catch(() => {
            console.error('[Queue] Automatic metadata retry scan failed; will try again next interval');
            return 0;
        }).finally(() => { this.retrySweep = undefined; });
        return this.retrySweep;
    }

    private async sweepMetadataFailures(): Promise<number> {
        const candidates = (await this.queue.getFailed(0, 4999)).filter(job => this.canAutomaticallyRetry(job));
        if (!candidates.length || this.closing) return 0;
        const client = await this.queue.client;
        const key = this.queue.toKey('metadata-auto-retry');
        const token = randomUUID();
        client.defineCommand('archiverMetadataRetryClaim', { numberOfKeys: 1,
            lua: "return redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX')" });
        client.defineCommand('archiverMetadataRetryRelease', { numberOfKeys: 1,
            lua: "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0" });
        const expiresAt = Date.now() + this.metadataRetryIntervalMs;
        if (!await client.runCommand('archiverMetadataRetryClaim', [key, token, this.metadataRetryIntervalMs])) return 0;
        let retried = 0;
        try {
            for (const candidate of candidates) {
                if (this.closing || Date.now() >= expiresAt) break;
                const current = await this.queue.getJob(candidate.id!);
                if (!current || current.finishedOn !== candidate.finishedOn || !this.canAutomaticallyRetry(current) ||
                    await current.getState() !== 'failed') continue;
                try {
                    await current.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true });
                    retried++;
                } catch (error) {
                    // A manual retry or removal may win the atomic state transition.
                    const remaining = await this.queue.getJob(candidate.id!);
                    if (remaining && await remaining.getState() === 'failed') throw error;
                }
            }
        } catch (error) {
            // Release only our claim so a later startup can recover after a Redis error.
            await client.runCommand('archiverMetadataRetryRelease', [key, token]).catch(() => {});
            throw error;
        }
        if (retried) console.log(`[Queue] Automatically requeued ${retried} metadata-failed task(s)`);
        return retried;
    }

    async isReady(): Promise<boolean> {
        if (!this.worker.isRunning()) return false;
        const [client, workerClient] = await Promise.all([this.queue.client, this.worker.client]);
        if (client.status !== 'ready' || workerClient.status !== 'ready') return false;
        await this.queue.getJobCounts('waiting');
        return true;
    }

    async close(): Promise<void> {
        this.closing = true;
        if (this.retryTimer) clearInterval(this.retryTimer);
        await this.retrySweep;
        await this.startup.catch(() => {});
        await this.worker.close();
        await this.queue.close();
    }

    async waitUntilReady(): Promise<void> {
        await this.startup;
        await Promise.all([this.queue.waitUntilReady(), this.worker.waitUntilReady()]);
    }
}
