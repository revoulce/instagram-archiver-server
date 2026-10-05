import { InstagramRestrictionError, InstagramWaitError, InstagramWaitReason } from '../../domain/taskErrors';

export interface InstagramQueueOptions {
    minIntervalMs?: number;
    rateLimitCooldownMs?: number;
    cookiesPollMs?: number;
}

interface RedisCommands {
    defineCommand(name: string, definition: { numberOfKeys: number; lua: string }): void;
    runCommand(name: string, args: (string | number)[]): Promise<unknown>;
}

const reserveScript = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
if ARGV[1] == '' then return {'cookies_required', ARGV[3]} end
if redis.call('HEXISTS', KEYS[1], 'blocked:' .. ARGV[1]) == 1 then
    return {'auth_required', ARGV[3]}
end
local cooldown = tonumber(redis.call('HGET', KEYS[1], 'cooldownUntil') or '0')
if cooldown > now then return {'rate_limited', tostring(cooldown - now)} end
local nextAt = tonumber(redis.call('HGET', KEYS[1], 'nextAt') or '0')
if nextAt > now then return {'pacing', tostring(nextAt - now)} end
redis.call('HSET', KEYS[1], 'nextAt', now + tonumber(ARGV[2]))
return {'ready', '0'}
`;

const restrictScript = `
if ARGV[1] == 'auth_required' then
    redis.call('HSET', KEYS[1], 'blocked:' .. ARGV[2], '1')
elseif ARGV[1] == 'rate_limited' then
    local t = redis.call('TIME')
    local now = t[1] * 1000 + math.floor(t[2] / 1000)
    local old = tonumber(redis.call('HGET', KEYS[1], 'cooldownUntil') or '0')
    redis.call('HSET', KEYS[1], 'cooldownUntil', math.max(old, now + tonumber(ARGV[3])))
end
return 1
`;

export class InstagramSessionGate {
    private interval: number;
    private cooldown: number;
    private poll: number;
    private registeredClient?: RedisCommands;

    constructor(private client: () => Promise<RedisCommands>, private key: string, options: InstagramQueueOptions = {}) {
        this.interval = options.minIntervalMs ?? 60_000;
        this.cooldown = options.rateLimitCooldownMs ?? 3_600_000;
        this.poll = options.cookiesPollMs ?? 30_000;
        for (const value of [this.interval, this.cooldown, this.poll]) {
            if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
                throw new Error('Instagram queue delays must be positive integers up to 2147483647');
            }
        }
    }

    async reserve(fingerprint: string | null): Promise<void> {
        const redis = await this.getClient();
        const [reason, delay] = await redis.runCommand('archiverInstagramReserveV1', [this.key,
            fingerprint ?? '', this.interval, this.poll]) as [string, string];
        if (reason !== 'ready') throw new InstagramWaitError(reason as InstagramWaitReason, Number(delay));
    }

    async restrict(error: InstagramRestrictionError): Promise<InstagramWaitError> {
        const delay = error.reason === 'rate_limited' ? Math.max(this.cooldown, error.retryAfterMs) : this.poll;
        const redis = await this.getClient();
        await redis.runCommand('archiverInstagramRestrictV1', [this.key, error.reason, error.sessionFingerprint, delay]);
        return new InstagramWaitError(error.reason, delay);
    }

    private async getClient(): Promise<RedisCommands> {
        const redis = await this.client();
        if (this.registeredClient !== redis) {
            redis.defineCommand('archiverInstagramReserveV1', { numberOfKeys: 1, lua: reserveScript });
            redis.defineCommand('archiverInstagramRestrictV1', { numberOfKeys: 1, lua: restrictScript });
            this.registeredClient = redis;
        }
        return redis;
    }
}
