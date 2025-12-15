import express from 'express';
import { ITaskQueue } from '../../domain/interfaces';

export const createServer = (queue: ITaskQueue, secret: string) => {
    const app = express();
    app.use(express.json());

    // Middleware авторизации
    app.use((req, res, next) => {
        const authHeader = req.headers['authorization'];
        if (authHeader !== secret) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        next();
    });

    app.post('/api/v1/task', async (req, res) => {
        try {
            const { url } = req.body;
            if (!url || !url.includes('instagram.com')) {
                return res.status(400).json({ error: 'Invalid URL' });
            }

            const jobId = await queue.add({
                url,
                source: 'extension'
            });

            res.json({ status: 'queued', jobId });

        } catch (e) {
            console.error(e);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    return app;
};