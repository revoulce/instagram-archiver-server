import { createHash } from 'crypto';
import { InstagramRestrictionError } from '../../domain/taskErrors';

// Only a new login session unlocks an authentication pause. Editing comments,
// expiry dates or unrelated cookies must not restart the blocked session.
export function sessionFingerprint(contents: string, now = Date.now()): string | null {
    for (let line of contents.split(/\r?\n/)) {
        if (line.startsWith('#HttpOnly_')) line = line.slice(10);
        else if (line.startsWith('#')) continue;
        const fields = line.split('\t');
        if (fields.length !== 7) continue;
        const [domain, , cookiePath, , expires, name, value] = fields;
        if (!['.instagram.com', 'instagram.com', 'www.instagram.com'].includes(domain.toLowerCase()) ||
            cookiePath !== '/' || name !== 'sessionid' || !value.trim()) continue;
        const expiry = Number(expires);
        if (!Number.isFinite(expiry) || (expiry !== 0 && expiry * 1000 <= now)) continue;
        return createHash('sha256').update(value).digest('hex');
    }
    return null;
}

export function classifyInstagramFailure(stderr: string, fingerprint: string): InstagramRestrictionError | null {
    // gallery-dl 1.32.14 logs these messages for redirects and API failures.
    // Authentication takes priority over 429 when both are present.
    if (/challenge[_ -]?required|checkpoint[_ -]?required|login[_ -]?required|consent[_ -]?required|feedback[_ -]?required|HTTP redirect to (?:login|challenge|home) page|please (?:log|sign) in|login required|authentication|automated (?:behavior|behaviour)|account.{0,40}(?:suspend|disabled)|\b401\b|\b403\b|KeyError:\s*['"](?:items|data|user)['"]/i.test(stderr)) {
        return new InstagramRestrictionError('auth_required', fingerprint);
    }
    if (/\b429\b|too many requests|rate.?limit|please wait a few minutes|slow down/i.test(stderr)) {
        const seconds = /retry[-_ ]after\s*[:=]\s*["']?(\d+)/i.exec(stderr)?.[1];
        const parsed = seconds ? Number(seconds) * 1000 : 0;
        return new InstagramRestrictionError('rate_limited', fingerprint,
            Number.isSafeInteger(parsed) && parsed <= 2_147_483_647 ? parsed : 0);
    }
    return null;
}
