import { SynologyClient } from '../api/client';
import { t } from '../locales';
import { hasRemoteFile } from './remote-access';

export class LockReadError extends Error {
    constructor(readonly originalError: unknown, detail: string) {
        super(`${originalError instanceof Error ? originalError.message : String(originalError)}; ${detail}`);
        this.name = 'LockReadError';
    }
}

/** Diagnostic listing is observational only; it never authorizes replacing or releasing a lock. */
export async function diagnoseLockRead(client: SynologyClient, path: string, error: unknown): Promise<LockReadError> {
    let detail: string;
    try {
        const found = await hasRemoteFile(client, path);
        detail = t(found ? 'sync.lockRead.present' : 'sync.lockRead.notListed');
    } catch (listingError) {
        detail = t('sync.lockRead.unknown', { error: listingError instanceof Error ? listingError.message : String(listingError) });
    }
    return new LockReadError(error, detail);
}
