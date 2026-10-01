import { IDownloader, INotifier, TaskExecutionContext } from '../domain/interfaces';
import { TaskCheckpoint } from '../domain/entities';
import { DeliveryUncertainError, PermanentTaskError } from '../domain/taskErrors';
import { requiresDeliveryReview } from '../domain/taskIdentity';

export class ProcessTask {
    constructor(private downloader: IDownloader, private notifier: INotifier) {}

    async execute(url: string, context: TaskExecutionContext = { save: async () => {}, finalAttempt: true }): Promise<void> {
        let state: TaskCheckpoint = context.checkpoint ?? { nextFileIndex: 0, messageIds: [] };
        const save = async (next: TaskCheckpoint) => {
            await context.save(next);
            state = next;
        };
        const cleanup = async () => {
            if (state.metadata) await this.downloader.cleanup(state.metadata).catch(error => {
                console.error('Failed to clean task files:', error);
            });
        };

        if (requiresDeliveryReview(state)) {
            await cleanup();
            throw new DeliveryUncertainError();
        }

        // A crash after the last confirmed batch must not publish the post again.
        if (state.metadata && state.nextFileIndex === state.metadata.filePaths.length) {
            await cleanup();
            return;
        }
        if (state.metadata && (state.filesDiscarded || !await this.downloader.isAvailable(state.metadata))) {
            if (state.nextFileIndex > 0) {
                await save({ ...state, filesDiscarded: true });
                await cleanup();
                throw new DeliveryUncertainError();
            }
            await cleanup();
            await save({ nextFileIndex: 0, messageIds: [] });
        }
        if (!state.metadata) {
            const metadata = await this.downloader.download(url);
            try {
                await save({ nextFileIndex: 0, messageIds: [], metadata });
            } catch (error) {
                await this.downloader.cleanup(metadata).catch(console.error);
                throw error;
            }
        }
        const metadata = state.metadata!;
        try {
            await this.notifier.sendPost(metadata, url, {
                startFileIndex: state.nextFileIndex,
                onBatchStart: async fileIndex => {
                    await save({ ...state, pendingFileIndex: fileIndex });
                },
                onBatchSent: async (nextFileIndex, messageIds) => {
                    await save({ ...state, nextFileIndex, messageIds: [...state.messageIds, ...messageIds], pendingFileIndex: undefined });
                },
                onBatchRejected: async () => {
                    await save({ ...state, pendingFileIndex: undefined });
                },
            });
        } catch (error) {
            const uncertain = state.pendingFileIndex !== undefined;
            if (uncertain || context.finalAttempt || error instanceof PermanentTaskError) {
                // Persist discard state before deleting files, so manual retry cannot silently
                // re-download a partially published album with a different media order.
                await save({ ...state, filesDiscarded: true }).catch(console.error);
                await cleanup();
            }
            if (uncertain) throw new DeliveryUncertainError();
            throw error;
        }
        await cleanup();
    }
}
