import { Bot, InputFile } from 'grammy';
import { INotifier } from '../../domain/interfaces';
import { MediaMetadata } from '../../domain/entities';
import * as fs from 'fs/promises';

export class GrammyService implements INotifier {
    private bot: Bot;
    private channelId: string;

    constructor(token: string, channelId: string) {
        this.bot = new Bot(token);
        this.channelId = channelId;
    }

    async sendPost(metadata: MediaMetadata, originalUrl: string): Promise<void> {
        const caption = this.buildCaption(metadata, originalUrl);

        const safeCaption = caption.length > 1024 ? caption.substring(0, 1021) + '...' : caption;

        try {
            if (metadata.mediaType === 'album') {
                // Формируем MediaGroup
                const mediaGroup = metadata.filePaths.map((path, index) => {
                    const isVideo = path.endsWith('.mp4');
                    return {
                        type: isVideo ? 'video' : 'photo',
                        media: new InputFile(path),
                        caption: index === 0 ? safeCaption : undefined,
                        parse_mode: index === 0 ? 'HTML' : undefined
                    };
                });

                for (let i = 0; i < mediaGroup.length; i += 10) {
                    const chunk = mediaGroup.slice(i, i + 10);
                    await this.bot.api.sendMediaGroup(this.channelId, chunk as any);
                }

            } else if (metadata.mediaType === 'video') {
                await this.bot.api.sendVideo(this.channelId, new InputFile(metadata.filePaths[0]), {
                    caption: safeCaption,
                    parse_mode: 'HTML'
                });
            } else {
                await this.bot.api.sendPhoto(this.channelId, new InputFile(metadata.filePaths[0]), {
                    caption: safeCaption,
                    parse_mode: 'HTML'
                });
            }

        } finally {
            if (metadata.filePaths.length > 0) {
                const dir = metadata.filePaths[0].substring(0, metadata.filePaths[0].lastIndexOf('/'));
                if (dir.length > 10) {
                    await fs.rm(dir, { recursive: true, force: true }).catch(console.error);
                }
            }
        }
    }

    async sendError(errorMsg: string): Promise<void> {
        console.error("Telegram Error Report:", errorMsg);
    }

    private buildCaption(meta: MediaMetadata, url: string): string {
        const safeDesc = this.escapeHtml(meta.description);
        const safeAuthor = this.escapeHtml(meta.author);

        return `${safeDesc}\n\n` +
            `👤 <b>${safeAuthor}</b>\n` +
            `❤️ <b>${meta.likes}</b> likes\n` +
            `🔗 <a href="${url}">Original Link</a>`;
    }

    private escapeHtml(unsafe: string): string {
        if (!unsafe) return '';
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
}