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

    app.get('/api/v1/task/:id', async (req: Request, res: Response) => {
        const id = req.params.id as string;
        if (!/^[\w-]{1,128}$/.test(id)) {
            res.status(400).json({ error: 'Invalid task ID' });
            return;
        }
        const status = await queue.getStatus(id);
        if (!status) {
            res.status(404).json({ error: 'Task not found' });
            return;
        }
        res.json(status);
    });

    app.post('/api/v1/task/:id/retry', async (req: Request, res: Response) => {
        const id = req.params.id as string;
        if (!/^[\w-]{1,128}$/.test(id)) {
            res.status(400).json({ error: 'Invalid task ID' });
            return;
        }
        const result = await queue.retry(id);
        if (result === 'not_found') res.status(404).json({ error: 'Task not found' });
        else if (result === 'requires_review') res.status(409).json({ error: 'Review Telegram delivery before retrying', requiresReview: true });
        else if (result === 'conflict') res.status(409).json({ error: 'Only failed tasks can be retried' });
        else res.json({ status: 'queued', jobId: id });
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
