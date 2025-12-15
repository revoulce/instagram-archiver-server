import dotenv from 'dotenv';
import path from 'path';
import { GalleryDLService } from './infrastructure/downloader/GalleryDLService';
import { GrammyService } from './infrastructure/telegram/GrammyService';
import { QueueService } from './infrastructure/queue/QueueService';
import { createServer } from './infrastructure/api/server';

dotenv.config();

const PORT = process.env.PORT || 3000;
const AUTH_SECRET = process.env.AUTH_SECRET || 'secret';

const downloader = new GalleryDLService(
    process.env.COOKIES_PATH || './cookies.txt',
    process.env.DOWNLOAD_PATH || './downloads'
);

const notifier = new GrammyService(
    process.env.TELEGRAM_BOT_TOKEN!,
    process.env.TELEGRAM_CHANNEL_ID!
);

const queueService = new QueueService(
    process.env.REDIS_HOST || 'localhost',
    Number(process.env.REDIS_PORT) || 6379,
    downloader,
    notifier
);

const app = createServer(queueService, AUTH_SECRET);

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Waiting for Instagram links...`);
});