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
