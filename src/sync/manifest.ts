import { SynologyClient } from '../api/client';
import { isHash, record, validPath } from './validation';
import { t } from '../locales';

export interface ManifestEntry {
    rev: number;
    hash: string;
    size: number;
    updatedBy: string;
    updatedAt: number;
    deleted?: boolean;
    deletedAt?: number;
}

export interface SyncManifest {
    schemaVersion: 1;
    files: Record<string, ManifestEntry>;
}

export function validateManifest(value: unknown): asserts value is SyncManifest {
    if (!record(value) || value.schemaVersion !== 1 || !record(value.files)) throw new Error(t('safety.invalidManifest'));
    for (const [path, entry] of Object.entries(value.files)) {
        if (!validPath(path) || !record(entry) || !Number.isSafeInteger(entry.rev) || Number(entry.rev) < 1
            || typeof entry.updatedBy !== 'string' || typeof entry.updatedAt !== 'number' || !Number.isFinite(entry.updatedAt)
            || typeof entry.size !== 'number' || entry.size < 0 || !Number.isFinite(entry.size)
            || (entry.deleted !== undefined && typeof entry.deleted !== 'boolean')
            || (entry.deleted ? entry.hash !== '' : !isHash(entry.hash))) throw new Error(t('safety.invalidManifest'));
    }
}

/** Exclusive, non-expiring directory. Never reclaim a lock from a possibly suspended writer. */
export class ManifestManager {
    private token = '';

    constructor(private client: SynologyClient, private remoteFolder: string) {}

    private path(name: string) { return `${this.remoteFolder}/${name}`; }

    async acquireLock(_deviceId: string): Promise<boolean> {
        await this.client.ensureRemoteFolder(this.remoteFolder);
        if (await this.client.hasFile(this.path('.sync_lock'))) throw new Error(t('safety.locked'));
        // Documented create conflict_action=stop; no retry after an ambiguous create result.
        await this.client.createFolder(this.path('.sync_lock'), 'stop');
        this.token = crypto.randomUUID();
        try {
            await this.client.uploadFile(this.path('.sync_lock/owner.json'), new TextEncoder().encode(this.token).buffer);
            await this.assertLock();
        } catch (error) {
            // Keep the directory on uncertain acquisition. Never delete another writer's lock.
            this.token = '';
            throw error;
        }
        return true;
    }

    async assertLock(): Promise<void> {
        if (!this.token) throw new Error(t('safety.locked'));
        const owner = new TextDecoder().decode(await this.client.downloadFile(this.path('.sync_lock/owner.json')));
        if (owner !== this.token) throw new Error(t('safety.locked'));
    }

    async releaseLock(_deviceId: string): Promise<void> {
        await this.assertLock();
        await this.client.deleteFile(this.path('.sync_lock'));
        this.token = '';
    }

    async downloadManifest(): Promise<SyncManifest> {
        if (!await this.client.hasFile(this.path('.sync_manifest.json'))) return { schemaVersion: 1, files: {} };
        const parsed: unknown = JSON.parse(new TextDecoder().decode(await this.client.downloadFile(this.path('.sync_manifest.json'))));
        validateManifest(parsed);
        return parsed;
    }

    async uploadManifest(manifest: SyncManifest, _deviceId: string): Promise<void> {
        validateManifest(manifest);
        await this.assertLock();
        // Tombstones are retained until every offline peer can be accounted for.
        await this.client.uploadFile(this.path('.sync_manifest.json'), new TextEncoder().encode(JSON.stringify(manifest)).buffer);
    }
}
