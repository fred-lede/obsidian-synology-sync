import { SynologyClient } from '../api/client';
import { ManifestManager, SyncManifest, validateManifest } from './manifest';
import { calculateSHA256 } from './utils';
import { record, validPath } from './validation';
import { t } from '../locales';

/** One write-ahead remote operation at a time, replayable after any network/process failure. */
export class RemoteTransaction {
    constructor(private client: SynologyClient, private manager: ManifestManager, private folder: string) {}
    private path(name: string) { return `${this.folder}/${name}`; }

    async recover(deviceId: string): Promise<void> {
        await this.manager.assertLock();
        if (!await this.client.hasFile(this.path('.sync_pending.json'))) return;
        const journal: unknown = JSON.parse(new TextDecoder().decode(await this.client.downloadFile(this.path('.sync_pending.json'))));
        if (!record(journal) || typeof journal.path !== 'string' || !validPath(journal.path)) throw new Error(t('safety.invalidManifest'));
        validateManifest(journal.manifest);
        const entry = journal.manifest.files[journal.path];
        if (!entry) throw new Error(t('safety.invalidManifest'));
        await this.manager.assertLock();
        if (entry.deleted) {
            if (await this.client.hasFile(this.path(journal.path))) await this.client.deleteFile(this.path(journal.path));
        } else {
            const buffer = await this.client.downloadFile(this.path('.sync_pending_data'));
            if (await calculateSHA256(buffer) !== entry.hash) throw new Error(t('safety.hashMismatch'));
            await this.client.uploadFile(this.path(journal.path), buffer);
        }
        await this.manager.uploadManifest(journal.manifest, deviceId);
        await this.manager.assertLock();
        await this.client.deleteFile(this.path('.sync_pending.json'));
    }

    async commit(path: string, manifest: SyncManifest, deviceId: string, buffer?: ArrayBuffer): Promise<void> {
        validateManifest(manifest);
        await this.manager.assertLock();
        if (await this.client.hasFile(this.path('.sync_pending.json'))) throw new Error(t('safety.pending'));
        if (buffer) await this.client.uploadFile(this.path('.sync_pending_data'), buffer);
        await this.manager.assertLock();
        await this.client.uploadFile(this.path('.sync_pending.json'), new TextEncoder().encode(JSON.stringify({ path, manifest })).buffer);
        await this.recover(deviceId);
    }
}
