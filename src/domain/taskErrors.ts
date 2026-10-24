export class PermanentTaskError extends Error {}

// A 403 means Telegram definitely rejected this batch, so the task itself is
// safe to stop. QueueService can requeue it later after channel access returns.
export class TelegramChannelAccessError extends PermanentTaskError {
    static readonly messagePrefix = 'Telegram channel access unavailable';

    constructor() {
        super(TelegramChannelAccessError.messagePrefix);
    }
}

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

export type InstagramWaitReason = 'pacing' | 'rate_limited' | 'auth_required' | 'cookies_required';

export class InstagramWaitError extends Error {
    constructor(public reason: InstagramWaitReason, public delayMs: number) {
        super(`Instagram downloads are waiting: ${reason}`);
    }
}

export class InstagramRestrictionError extends Error {
    constructor(
        public reason: 'rate_limited' | 'auth_required' | 'cookies_required',
        public sessionFingerprint: string,
        public retryAfterMs = 0,
    ) {
        super(`Instagram download stopped: ${reason}`);
    }
}
