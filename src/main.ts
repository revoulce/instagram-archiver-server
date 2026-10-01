import dotenv from 'dotenv';
import { loadConfig } from './config';
import { GalleryDLService } from './infrastructure/downloader/GalleryDLService';
import { GrammyService } from './infrastructure/telegram/GrammyService';
import { QueueService } from './infrastructure/queue/QueueService';
import { createServer } from './infrastructure/api/server';

dotenv.config();

const config = loadConfig();

const downloader = new GalleryDLService(
    config.cookiesPath,
    config.downloadPath,
    config.downloadTimeoutMs
);

const notifier = new GrammyService(
    config.telegramBotToken,
    config.telegramChannelId
);

const queueService = new QueueService(
    config.redisHost,
    config.redisPort,
    downloader,
    notifier
);

const app = createServer(queueService, config.authSecret);

app.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
    console.log(`Waiting for Instagram links...`);
});
