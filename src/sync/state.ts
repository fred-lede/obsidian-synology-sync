import { App } from 'obsidian';
import { t } from '../locales';
import { isHash, record, validPath } from './validation';

export interface LocalFileEntry {
    localMtime: number;
    localHash: string;
    syncedRev: number;
    syncedHash: string;
}

export interface LocalSyncData {
    schemaVersion: 2;
    deviceId: string;
    target: string;
    files: Record<string, LocalFileEntry>;
}

export class SyncState {
    private data: LocalSyncData;
    private path: string;

    constructor(private app: App, pluginDir: string, private target = '') {
        this.path = `${pluginDir}/sync_data.json`.replace(/\/\//g, '/');
        this.data = this.empty();
    }

    private empty(): LocalSyncData {
        return { schemaVersion: 2, deviceId: crypto.randomUUID(), target: this.target, files: {} };
    }

    async load() {
        this.data = this.empty();
        if (!await this.app.vault.adapter.exists(this.path)) return;
        const parsed: unknown = JSON.parse(await this.app.vault.adapter.read(this.path));
        if (!record(parsed)) throw new Error(t('safety.invalidManifest'));
        // Legacy and foreign target snapshots cannot authorize a deletion.
        if (parsed.schemaVersion === 1 || parsed.schemaVersion === undefined) return;
        if (parsed.schemaVersion !== 2) throw new Error(t('safety.invalidManifest'));
        if (parsed.target !== this.target) return;
        if (!record(parsed.files) || typeof parsed.deviceId !== 'string') throw new Error(t('safety.invalidManifest'));
        for (const [path, value] of Object.entries(parsed.files)) {
            if (!validPath(path) || !record(value) || !isHash(value.localHash) || !isHash(value.syncedHash)
                || !Number.isSafeInteger(value.syncedRev) || Number(value.syncedRev) < 1
                || typeof value.localMtime !== 'number' || !Number.isFinite(value.localMtime)) {
                throw new Error(t('safety.invalidManifest'));
            }
        }
        this.data = parsed as unknown as LocalSyncData;
    }

    async save() {
        // Failure must reach the caller; it must never be reported as a successful sync.
        await this.app.vault.adapter.write(this.path, JSON.stringify(this.data));
    }

    getFileState(path: string): LocalFileEntry | undefined { return this.data.files[path]; }
    updateFileState(path: string, state: LocalFileEntry) { this.data.files[path] = state; }
    removeFileState(path: string) { delete this.data.files[path]; }
    getAllPaths(): string[] { return Object.keys(this.data.files); }
    clear() { this.data.files = {}; }
    getDeviceId(): string { return this.data.deviceId; }
}
