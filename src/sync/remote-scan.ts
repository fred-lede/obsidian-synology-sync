import { SynologyClient } from '../api/client';
import { SyncManifest } from './manifest';
import { calculateSHA256 } from './utils';
import { validPath } from './validation';
import { t } from '../locales';

/** A failed or malformed traversal never produces a partial authoritative result. */
export async function scanRemote(client: SynologyClient, root: string, manifest: SyncManifest, deviceId: string): Promise<void> {
    const queue = [root];
    const visited = new Set<string>();
    while (queue.length) {
        const folder = queue.shift()!;
        if (visited.has(folder)) throw new Error(t('safety.invalidManifest'));
        visited.add(folder);
        const res = await client.listFiles(folder) as { success?: boolean; data?: { items?: Array<{ name: string; path: string; isdir?: boolean; type?: string }> } };
        if (res.success === false || !Array.isArray(res.data?.items)) throw new Error(t('safety.invalidManifest'));
        for (const item of res.data.items) {
            if (typeof item.name !== 'string' || item.name.includes('/') || item.name.includes('\\')) throw new Error(t('safety.invalidManifest'));
            if (item.name.startsWith('.')) continue;
            const remotePath = `${folder}/${item.name}`;
            const path = remotePath.slice(root.length + 1);
            if (!validPath(path)) throw new Error(t('safety.invalidManifest'));
            if (item.type === 'dir' || item.isdir === true) { queue.push(remotePath); continue; }
            // Existing tombstones remain authoritative, including after long offline periods.
            if (manifest.files[path]?.deleted) continue;
            const buffer = await client.downloadFile(remotePath);
            const hash = await calculateSHA256(buffer);
            const previous = manifest.files[path];
            if (previous?.hash !== hash) manifest.files[path] = {
                rev: (previous?.rev ?? 0) + 1, hash, size: buffer.byteLength,
                updatedBy: deviceId, updatedAt: Date.now()
            };
        }
    }
    // Missing files without a tombstone are unknown, not permission to delete local data.
}
