export interface ShutdownOptions {
    markStopping(): void;
    closeHttp(): Promise<void>;
    closeQueue(): Promise<void>;
    timeoutMs: number;
}

export function createShutdown(options: ShutdownOptions): () => Promise<void> {
    let operation: Promise<void> | undefined;
    return () => {
        if (operation) return operation;
        options.markStopping();
        let timer: ReturnType<typeof setTimeout>;
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Graceful shutdown timed out')), options.timeoutMs);
        });
        operation = Promise.race([
            Promise.all([
                Promise.resolve().then(options.closeHttp),
                Promise.resolve().then(options.closeQueue),
            ]).then(() => {}),
            timeout,
        ]).finally(() => clearTimeout(timer));
        return operation;
    };
}
