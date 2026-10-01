import { createHash } from 'crypto';
import { TaskCheckpoint } from './entities';

export function taskIdentity(canonicalUrl: string): string {
    const parts = new URL(canonicalUrl).pathname.split('/').filter(Boolean);
    const identity = `${parts[0] === 'stories' ? 'story' : 'post'}:${parts[parts.length - 1]}`;
    return `instagram-${createHash('sha256').update(identity).digest('hex')}`;
}

export function requiresDeliveryReview(checkpoint?: TaskCheckpoint): boolean {
    return checkpoint?.pendingFileIndex !== undefined ||
        Boolean(checkpoint?.filesDiscarded && checkpoint.nextFileIndex > 0 &&
            checkpoint.nextFileIndex < (checkpoint.metadata?.filePaths.length ?? Infinity));
}
