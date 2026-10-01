import { Bot, InputFile } from 'grammy';
import { InputMediaPhoto, InputMediaVideo } from 'grammy/types';
import { extname } from 'path';
import { INotifier } from '../../domain/interfaces';
import { MediaMetadata } from '../../domain/entities';
import { buildCaption } from './caption';

export class GrammyService implements INotifier {
    private bot: Bot;

    constructor(token: string, private channelId: string) {
        this.bot = new Bot(token);
    }

    async sendPost(metadata: MediaMetadata, originalUrl: string): Promise<void> {
        if (!metadata.filePaths.length) throw new Error('Cannot send a post without media');
        const caption = buildCaption(metadata, originalUrl);
        const media: Array<InputMediaPhoto | InputMediaVideo> = metadata.filePaths.map((filePath, index) => ({
            type: extname(filePath).toLowerCase() === '.mp4' ? 'video' : 'photo',
            media: new InputFile(filePath),
            caption: index === 0 ? caption : undefined,
            parse_mode: index === 0 ? 'HTML' : undefined,
        }));

        for (let i = 0; i < media.length; i += 10) {
            const chunk = media.slice(i, i + 10);
            if (chunk.length > 1) {
                await this.bot.api.sendMediaGroup(this.channelId, chunk);
            } else {
                const item = chunk[0];
                const options = { caption: item.caption, parse_mode: item.parse_mode };
                if (item.type === 'video') {
                    await this.bot.api.sendVideo(this.channelId, item.media, options);
                } else {
                    await this.bot.api.sendPhoto(this.channelId, item.media, options);
                }
            }
        }
    }

    async sendError(errorMsg: string): Promise<void> {
        console.error('Telegram Error Report:', errorMsg);
    }
}
