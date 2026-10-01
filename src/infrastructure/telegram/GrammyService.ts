import { Bot, GrammyError, InputFile } from 'grammy';
import { InputMediaPhoto, InputMediaVideo } from 'grammy/types';
import { extname } from 'path';
import { DeliveryOptions, INotifier } from '../../domain/interfaces';
import { MediaMetadata } from '../../domain/entities';
import { PermanentTaskError, TelegramRateLimitError } from '../../domain/taskErrors';
import { buildCaption } from './caption';

export class GrammyService implements INotifier {
    private bot: Bot;

    constructor(token: string, private channelId: string) {
        this.bot = new Bot(token);
    }

    async sendPost(metadata: MediaMetadata, originalUrl: string, options?: DeliveryOptions): Promise<void> {
        if (!metadata.filePaths.length) throw new PermanentTaskError('Cannot send a post without media');
        const start = options?.startFileIndex ?? 0;
        if (!Number.isInteger(start) || start < 0 || start > metadata.filePaths.length || start % 10 !== 0) {
            if (start === metadata.filePaths.length) return;
            throw new PermanentTaskError('Invalid delivery checkpoint');
        }
        const caption = buildCaption(metadata, originalUrl);
        const media: Array<InputMediaPhoto | InputMediaVideo> = metadata.filePaths.map((filePath, index) => ({
            type: extname(filePath).toLowerCase() === '.mp4' ? 'video' : 'photo',
            media: new InputFile(filePath),
            caption: index === 0 ? caption : undefined,
            parse_mode: index === 0 ? 'HTML' : undefined,
        }));

        for (let i = start; i < media.length; i += 10) {
            const chunk = media.slice(i, i + 10);
            await options?.onBatchStart(i);
            let messageIds: number[];
            try {
                if (chunk.length > 1) {
                    const messages = await this.bot.api.sendMediaGroup(this.channelId, chunk);
                    messageIds = messages.map(message => message.message_id);
                } else {
                    const item = chunk[0];
                    const sendOptions = { caption: item.caption, parse_mode: item.parse_mode };
                    const message = item.type === 'video'
                        ? await this.bot.api.sendVideo(this.channelId, item.media, sendOptions)
                        : await this.bot.api.sendPhoto(this.channelId, item.media, sendOptions);
                    messageIds = [message.message_id];
                }
            } catch (error) {
                // Only a definite rejection is safe to retry. Transport errors and server
                // failures may occur after Telegram accepted a request.
                if (error instanceof GrammyError && error.error_code >= 400 && error.error_code < 500) {
                    await options?.onBatchRejected();
                    if (error.error_code === 429) {
                        throw new TelegramRateLimitError(Math.max(1, error.parameters.retry_after ?? 5) * 1000);
                    }
                    throw new PermanentTaskError('Telegram rejected the media or channel permissions');
                }
                throw error;
            }
            // Keep this outside the catch: a Redis failure after a successful send must
            // leave the pending marker in place and prevent automatic duplicate delivery.
            await options?.onBatchSent(i + chunk.length, messageIds);
        }
    }

    async sendError(errorMsg: string): Promise<void> {
        console.error('Telegram Error Report:', errorMsg);
    }
}
