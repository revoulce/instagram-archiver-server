export function normalizeInstagramUrl(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > 2048) return null;
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.port ||
            !['instagram.com', 'www.instagram.com', 'm.instagram.com'].includes(url.hostname)) {
            return null;
        }
        const post = url.pathname.match(/^\/(p|reels?)\/([\w-]+)\/?$/);
        if (post) {
            return `https://www.instagram.com/${post[1] === 'p' ? 'p' : 'reel'}/${post[2]}/`;
        }
        const story = url.pathname.match(/^\/stories\/([\w.]+)\/(\d+)\/?$/);
        return story ? `https://www.instagram.com/stories/${story[1]}/${story[2]}/` : null;
    } catch {
        return null;
    }
}
