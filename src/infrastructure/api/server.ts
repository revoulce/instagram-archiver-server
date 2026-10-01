import express, { Request, Response, NextFunction } from 'express';
import { ITaskQueue } from '../../domain/interfaces';
import { normalizeInstagramUrl } from '../../domain/instagramUrl';

export const createServer = (queue: ITaskQueue, secret: string) => {
    const app = express();

    app.use((req: Request, res: Response, next: NextFunction) => {
        const authHeader = req.headers['authorization'];
        if (authHeader !== secret) {
            res.status(403).json({ error: 'Forbidden' });
            return;
        }
        next();
    });

    app.use(express.json({ limit: '16kb' }));

    app.post('/api/v1/task', async (req: Request, res: Response) => {
        try {
            const url = normalizeInstagramUrl(req.body?.url);
            if (!url) {
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

    app.use((error: { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
        if (error.status === 400 || error.status === 413) {
            res.status(error.status).json({ error: error.status === 413 ? 'Request body too large' : 'Invalid JSON' });
            return;
        }
        console.error(error);
        res.status(500).json({ error: 'Internal Server Error' });
    });

    return app;
};
