export class PermanentTaskError extends Error {}

export class DeliveryUncertainError extends PermanentTaskError {
    constructor() {
        super('Telegram delivery is uncertain. Review the channel before sending again.');
    }
}

export class TelegramRateLimitError extends Error {
    constructor(public retryAfterMs: number) {
        super('Telegram rate limit exceeded');
    }
}
