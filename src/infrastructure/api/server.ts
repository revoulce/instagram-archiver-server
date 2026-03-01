import express, { Request, Response, NextFunction } from 'express';
import { ITaskQueue } from '../../domain/interfaces';

export const createServer = (queue: ITaskQueue, secret: string) => {
    const app = express();
    app.use(express.json());

    app.use((req: Request, res: Response, next: NextFunction) => {
        const authHeader = req.headers['authorization'];
        if (authHeader !== secret) {
            res.status(403).json({ error: 'Forbidden' });
            return;
        }
        next();
    });

    app.post('/api/v1/task', async (req: Request, res: Response) => {
        try {
            const { url } = req.body;
            if (!url || !url.includes('instagram.com')) {
                res.status(400).json({ error: 'Invalid URL' });
                return;
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