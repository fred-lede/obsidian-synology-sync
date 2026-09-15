import { SynologyClient } from '../api/client';
import { listRemoteFiles } from './remote-access';
import { t } from '../locales';

/** Never use overwrite to ensure a directory: it can contain another writer's lock and data. */
export async function ensureSyncFolder(client: SynologyClient, path: string): Promise<void> {
    const parts = path.split('/').filter(Boolean);
    let current = '';
    for (let i = 0; i < parts.length; i++) {
        const parent = current;
        current += '/' + parts[i];
        if (current === '/mydrive' || current === '/team-folders' || (parts[0] === 'team-folders' && i === 1)) continue;
        try {
            const result = await client.createFolder(current, 'stop') as { success?: boolean } | null;
            if (result?.success !== true) throw new Error(t('safety.invalidResponse'));
        } catch (error) {
            // A conflict and an ambiguous create are acceptable only if a complete listing
            // confirms the exact entry is a directory. Never overwrite a same-named file.
            const items = await listRemoteFiles(client, parent);
            const entry = items.find(item => item.name === parts[i]);
            if (!entry || !(entry.type === 'dir' || entry.type === 'folder' || entry.isdir === true)) throw error;
        }
    }
}
