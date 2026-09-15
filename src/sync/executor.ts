import { App, TFile } from 'obsidian';
import { SynologyClient } from '../api/client';
import { LocalFS } from '../fs/local';
import { t } from '../locales';
import { LocalFileInfo, SyncPlan } from './differ';
import { ManifestManager, SyncManifest } from './manifest';
import { SyncState } from './state';
import { RemoteTransaction } from './transaction';
import { calculateSHA256 } from './utils';
import { SyncLogger } from './logger';
import { hasRemoteFile } from './remote-access';

export class PlanExecutor {
    private fs: LocalFS;
    constructor(private app: App, private client: SynologyClient, private state: SyncState,
        private logger: SyncLogger, private manager: ManifestManager, private transaction: RemoteTransaction,
        private folder: string) { this.fs = new LocalFS(app); }

    private async unchanged(path: string, expected: LocalFileInfo | undefined): Promise<void> {
        const current = await this.fs.read(path);
        if (expected ? !current || await calculateSHA256(current) !== expected.hash : current !== null) {
            throw new Error(t('safety.localChanged', { path }));
        }
    }

    private snapshot(path: string, manifest: SyncManifest) {
        const file = this.app.vault.getAbstractFileByPath(path);
        const entry = manifest.files[path];
        if (!(file instanceof TFile) || !entry || entry.deleted) throw new Error(t('safety.localChanged', { path }));
        this.state.updateFileState(path, { localMtime: file.stat.mtime, localHash: entry.hash, syncedRev: entry.rev, syncedHash: entry.hash });
    }

    private async remoteUnchanged(path: string, manifest: SyncManifest) {
        const entry = manifest.files[path];
        if (entry && !entry.deleted) {
            if (await calculateSHA256(await this.client.downloadFile(`${this.folder}/${path}`)) !== entry.hash) throw new Error(t('safety.hashMismatch'));
        } else if (await hasRemoteFile(this.client, `${this.folder}/${path}`)) {
            // A file created outside the protocol must first be discovered by a full scan.
            throw new Error(t('safety.hashMismatch'));
        }
    }

    private async upload(path: string, manifest: SyncManifest, deviceId: string, expected: LocalFileInfo | undefined) {
        await this.unchanged(path, expected);
        const buffer = await this.fs.read(path);
        if (!buffer) throw new Error(t('safety.localChanged', { path }));
        const hash = await calculateSHA256(buffer);
        const next: SyncManifest = { schemaVersion: 1, files: { ...manifest.files, [path]: {
            rev: (manifest.files[path]?.rev ?? 0) + 1, hash, size: buffer.byteLength,
            updatedBy: deviceId, updatedAt: Date.now()
        } } };
        if (!manifest.files[path] || manifest.files[path].deleted) {
            const remotePath = `${this.folder}/${path}`;
            // The original uploader creates missing parents; preflight must not list them before creation.
            await this.client.ensureRemoteFolder(remotePath.slice(0, remotePath.lastIndexOf('/')));
        }
        await this.remoteUnchanged(path, manifest);
        await this.transaction.commit(path, next, deviceId, buffer);
        manifest.files = next.files;
        this.snapshot(path, manifest);
        await this.logger.addLog({ action: 'Upload', file: path });
    }

    private async download(path: string, manifest: SyncManifest, expected: LocalFileInfo | undefined, preserveAll = false) {
        const buffer = await this.client.downloadFile(`${this.folder}/${path}`);
        if (await calculateSHA256(buffer) !== manifest.files[path]?.hash) throw new Error(t('safety.hashMismatch'));
        await this.unchanged(path, expected);
        // Preserve the replaced bytes before any asynchronous filesystem write.
        const previous = await this.fs.read(path);
        if (previous) {
            const hash = await calculateSHA256(previous);
            if (hash !== manifest.files[path]?.hash && (preserveAll || hash !== this.state.getFileState(path)?.localHash)) await this.preserve(path, previous);
        }
        await this.unchanged(path, expected);
        await this.fs.writeChecked(path, buffer, previous);
        this.snapshot(path, manifest);
        await this.logger.addLog({ action: 'Download', file: path });
    }

    private async preserve(path: string, buffer: ArrayBuffer): Promise<string> {
        const hash = await calculateSHA256(buffer);
        const slash = path.lastIndexOf('/');
        const dot = path.lastIndexOf('.');
        const split = dot > slash ? dot : path.length;
        const copy = `${path.slice(0, split)} (Conflict ${hash})${path.slice(split)}`;
        const existing = await this.fs.read(copy);
        if (existing) {
            if (await calculateSHA256(existing) !== hash) throw new Error(t('safety.copyExists', { path: copy }));
        } else await this.fs.write(copy, buffer);
        return copy;
    }

    async execute(plan: SyncPlan, manifest: SyncManifest, deviceId: string, local: Map<string, LocalFileInfo>, preserveDownloads = false): Promise<boolean> {
        // Sequential operations keep a single durable journal and stop immediately on failure.
        for (const path of plan.uploads) await this.upload(path, manifest, deviceId, local.get(path));
        for (const path of plan.downloads) await this.download(path, manifest, local.get(path), preserveDownloads);
        for (const path of plan.conflicts) {
            const entry = manifest.files[path];
            if (!entry || entry.deleted) {
                // Preserve an unknown local file against an existing deletion as a separate file.
                await this.unchanged(path, local.get(path));
                const buffer = await this.fs.read(path);
                if (buffer) await this.preserve(path, buffer);
                await this.unchanged(path, local.get(path));
                await this.fs.delete(path);
                this.state.removeFileState(path);
            } else if (!local.has(path)) {
                await this.download(path, manifest, undefined);
            } else {
                const buffer = await this.client.downloadFile(`${this.folder}/${path}`);
                if (await calculateSHA256(buffer) !== entry.hash) throw new Error(t('safety.hashMismatch'));
                const copy = await this.preserve(path, buffer);
                // Publish the preserved remote version before replacing its original path.
                const copyInfo = { hash: entry.hash, mtime: 0 };
                if (manifest.files[copy]?.hash !== entry.hash) await this.upload(copy, manifest, deviceId, copyInfo);
                await this.upload(path, manifest, deviceId, local.get(path));
            }
            await this.logger.addLog({ action: 'Conflict', file: path, details: t('safety.conflictPreserved') });
        }
        for (const path of plan.deletionsRemote) {
            await this.unchanged(path, undefined);
            const next: SyncManifest = { schemaVersion: 1, files: { ...manifest.files, [path]: {
                rev: (manifest.files[path]?.rev ?? 0) + 1, hash: '', size: 0,
                updatedBy: deviceId, updatedAt: Date.now(), deleted: true, deletedAt: Date.now()
            } } };
            await this.remoteUnchanged(path, manifest);
            await this.transaction.commit(path, next, deviceId);
            manifest.files = next.files;
            this.state.removeFileState(path);
            await this.logger.addLog({ action: 'Delete Remote', file: path });
        }
        for (const path of plan.deletionsLocal) {
            await this.manager.assertLock();
            await this.unchanged(path, local.get(path));
            await this.fs.delete(path);
            this.state.removeFileState(path);
            await this.logger.addLog({ action: 'Delete Local', file: path });
        }
        for (const path of plan.snapshotClears) this.state.removeFileState(path);
        for (const [path, entry] of plan.snapshotUpdates) {
            await this.unchanged(path, local.get(path));
            this.state.updateFileState(path, entry);
        }
        await this.logger.flush();
        return Object.values(plan).some((value: Set<string> | Map<string, unknown>) => value.size > 0);
    }
}
