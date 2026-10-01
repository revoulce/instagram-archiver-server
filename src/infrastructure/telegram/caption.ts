import { MediaMetadata } from '../../domain/entities';

function escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function truncate(value: string, limit: number): string {
    if (value.length <= limit) return value;
    if (limit <= 0) return '';
    let result = '';
    for (const character of value) {
        if (result.length + character.length > limit - 1) break;
        result += character;
    }
    return result + '…';
}

export function buildCaption(meta: MediaMetadata, url: string): string {
    const author = truncate(meta.author, 200);
    const likes = Number.isFinite(meta.likes) && meta.likes >= 0 ? String(meta.likes) : '0';
    const footerText = `👤 ${author}\n❤️ ${likes} likes\n🔗 Original Link`;
    const description = truncate(meta.description, 1024 - footerText.length - 2);
    const footer = `👤 <b>${escapeHtml(author)}</b>\n❤️ <b>${likes}</b> likes\n` +
        `🔗 <a href="${escapeHtml(url)}">Original Link</a>`;
    return description ? `${escapeHtml(description)}\n\n${footer}` : footer;
}
