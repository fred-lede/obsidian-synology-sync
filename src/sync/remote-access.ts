import { SynologyClient } from '../api/client';
import { t } from '../locales';

export function syncTarget(nasUrl: string, username: string, folder: string): string {
    return JSON.stringify([nasUrl.replace(/\/+$/, ''), username, folder.replace(/\/+$/, '')]);
}

/** Validate the legacy client's result at the sync boundary without changing its requests. */
export async function listRemoteFiles(client: SynologyClient, path: string) {
    try {
        const result = await client.listFiles(path) as { success?: boolean; data?: { total?: number; items?: Array<{ name: string; path: string; type?: string; isdir?: boolean }> } };
        const items = result?.data?.items;
        if (result?.success === false || !Array.isArray(items)
            || items.some(item => !item || typeof item.name !== 'string')
            || !Number.isSafeInteger(result.data?.total) || result.data?.total !== items.length) {
            throw new Error(t('safety.invalidResponse'));
        }
        return items;
    } catch (error) {
        throw new Error(t('api.listFailed', { path, error: error instanceof Error ? error.message : String(error) }));
    }
}

export async function hasRemoteFile(client: SynologyClient, path: string): Promise<boolean> {
    const slash = path.lastIndexOf('/');
    return (await listRemoteFiles(client, path.slice(0, slash))).some(item => item.name === path.slice(slash + 1));
}

/** Read existing records directly, as before the refactor. Only absence needs a listing. */
export async function readRemoteRecord(client: SynologyClient, path: string): Promise<ArrayBuffer | null> {
    try { return await client.downloadFile(path); }
    catch (error) {
        // Download/metadata error codes alone cannot prove absence. Preserve both errors for diagnosis.
        try {
            if (!await hasRemoteFile(client, path)) return null;
        } catch (listingError) {
            throw new Error(t('safety.recordReadFailed', { path, error: listingError instanceof Error ? listingError.message : String(listingError) }));
        }
        throw error;
    }
}
