import dotenv from 'dotenv';
import { loadConfig } from './config';
import { GalleryDLService } from './infrastructure/downloader/GalleryDLService';
import { GrammyService } from './infrastructure/telegram/GrammyService';
import { QueueService } from './infrastructure/queue/QueueService';
import { createServer } from './infrastructure/api/server';
import { createShutdown } from './infrastructure/api/shutdown';

dotenv.config();

const config = loadConfig();

const downloader = new GalleryDLService(
    config.cookiesPath,
    config.downloadPath,
    config.downloadTimeoutMs,
    config.instagramRequestIntervalSeconds
);

const notifier = new GrammyService(
    config.telegramBotToken,
    config.telegramChannelId
);

const queueService = new QueueService(
    config.redisHost,
    config.redisPort,
    downloader,
    notifier,
    'instagram-tasks',
    {
        minIntervalMs: config.instagramMinIntervalMs,
        rateLimitCooldownMs: config.instagramRateLimitCooldownMs,
        cookiesPollMs: config.instagramCookiesPollMs,
    }
);

let stopping = false;
const app = createServer(queueService, config.authSecret, {
    isReady: () => queueService.isReady(),
    isStopping: () => stopping,
});

const server = app.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
    console.log(`Waiting for Instagram links...`);
});

const shutdown = createShutdown({
    markStopping: () => { stopping = true; },
    closeHttp: () => new Promise<void>((resolve, reject) => {
        server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
    }),
    closeQueue: () => queueService.close(),
    timeoutMs: config.shutdownTimeoutMs,
});

const stop = () => {
    shutdown().then(() => process.exit(0), error => {
        console.error('Shutdown failed:', error.message);
        process.exit(1);
    });
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
server.on('error', error => {
    console.error('HTTP server failed:', error.message);
    shutdown().finally(() => process.exit(1));
});
