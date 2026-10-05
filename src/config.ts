export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
    const required = (name: string): string => {
        const value = env[name]?.trim();
        if (!value) throw new Error(`Missing required environment variable: ${name}`);
        return value;
    };
    const integer = (name: string, fallback: number, maximum: number): number => {
        const raw = env[name];
        if (raw === undefined) return fallback;
        const value = Number(raw);
        if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
            throw new Error(`${name} must be an integer between 1 and ${maximum}`);
        }
        return value;
    };
    return {
        port: integer('PORT', 3000, 65535),
        authSecret: required('AUTH_SECRET'),
        telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
        telegramChannelId: required('TELEGRAM_CHANNEL_ID'),
        redisHost: env.REDIS_HOST?.trim() || 'localhost',
        redisPort: integer('REDIS_PORT', 6379, 65535),
        cookiesPath: env.COOKIES_PATH || './cookies.txt',
        downloadPath: env.DOWNLOAD_PATH || './downloads',
        downloadTimeoutMs: integer('DOWNLOAD_TIMEOUT_MS', 600_000, 2_147_483_647),
        shutdownTimeoutMs: integer('SHUTDOWN_TIMEOUT_MS', 30_000, 600_000),
        instagramMinIntervalMs: integer('INSTAGRAM_MIN_INTERVAL_MS', 60_000, 2_147_483_647),
        instagramRequestIntervalSeconds: integer('INSTAGRAM_REQUEST_INTERVAL_SECONDS', 10, 3600),
        instagramRateLimitCooldownMs: integer('INSTAGRAM_RATE_LIMIT_COOLDOWN_MS', 3_600_000, 2_147_483_647),
        instagramCookiesPollMs: integer('INSTAGRAM_COOKIES_POLL_MS', 30_000, 600_000),
    };
}
