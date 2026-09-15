import { App, Notice } from 'obsidian';
import { SynologyClient } from '../api/client';
import { SyncState, LocalFileEntry } from './state';
import { calculateSHA256 } from './utils';
import { SyncLogger } from './logger';
import { t } from '../locales';
import { ManifestManager } from './manifest';
import { computeSyncPlan, LocalFileInfo } from './differ';
import { DeletionTracker } from './deletions';
import { RemoteTransaction } from './transaction';
import { PlanExecutor } from './executor';
import { scanRemote } from './remote-scan';
import { validPath } from './validation';
import { normalizeRemoteFolder } from '../api/paths';
import { withRemoteDiagnostics } from './remote-diagnostics';

type Mode = 'sync' | 'upload' | 'download' | 'rebuild';

export class SyncEngine {
    private manager: ManifestManager;
    private transaction: RemoteTransaction;
    private executor: PlanExecutor;
    private isSyncing = false;

    constructor(private app: App, private client: SynologyClient, private state: SyncState,
        private logger: SyncLogger, private remoteFolder: string, private deletions = new DeletionTracker()) {
        this.client = withRemoteDiagnostics(client);
        this.remoteFolder = normalizeRemoteFolder(remoteFolder);
        this.manager = new ManifestManager(this.client, this.remoteFolder);
        this.transaction = new RemoteTransaction(this.client, this.manager, this.remoteFolder);
        this.executor = new PlanExecutor(app, this.client, state, logger, this.manager, this.transaction, this.remoteFolder);
    }

    async runSync(fullScan = false, showNotice = false): Promise<boolean> {
        const notice = showNotice ? new Notice(t('notice.engine.syncing'), 0) : null;
        try { return await this.run('sync', undefined, fullScan); } finally { notice?.hide(); }
    }
    async forceUpload(): Promise<boolean> { return this.run('upload', undefined, true); }
    async forceDownload(): Promise<boolean> { return this.run('download', undefined, true); }
    async rebuildSyncState(): Promise<boolean> { return this.run('rebuild', undefined, true); }
    async syncFile(path: string, direction: 'upload' | 'download'): Promise<boolean> { return this.run(direction, path, true); }

    private async run(mode: Mode, onlyPath?: string, fullScan = false): Promise<boolean> {
        if (this.isSyncing) throw new Error(t('safety.busy'));
        this.isSyncing = true;
        let locked = false;
        let deviceId = '';
        let failed = false;
        let failure: unknown;
        let result = false;
        try {
            await this.state.load();
            deviceId = this.state.getDeviceId();
            locked = await this.manager.acquireLock(deviceId);
            if (!locked) throw new Error(t('safety.locked'));
            await this.transaction.recover(deviceId);
            const manifest = await this.manager.downloadManifest();
            const beforeScan = JSON.stringify(manifest);
            // Verify remote contents rather than trusting an out-of-date manifest or mtime.
            if (fullScan || Object.keys(manifest.files).length === 0) await scanRemote(this.client, this.remoteFolder, manifest, deviceId);
            if (mode === 'rebuild') this.state.clear();
            const local = await this.detectLocalChanges();
            const snapshots = new Map<string, LocalFileEntry>();
            for (const path of this.state.getAllPaths()) {
                const entry = this.state.getFileState(path);
                if (entry) {
                    if (manifest.files[path] && manifest.files[path].rev < entry.syncedRev) throw new Error(t('safety.invalidManifest'));
                    snapshots.set(path, entry);
                }
            }
            const plan = computeSyncPlan(local, snapshots, new Map(Object.entries(manifest.files)), this.deletions.pending);
            // Force means overwrite matching files, never mirror-delete absent files.
            if (mode === 'upload' || mode === 'download') {
                for (const value of [plan.uploads, plan.downloads, plan.deletionsLocal, plan.deletionsRemote, plan.conflicts, plan.snapshotClears, plan.snapshotUpdates]) value.clear();
                const paths = onlyPath ? [onlyPath] : mode === 'upload' ? [...local.keys()] : Object.keys(manifest.files);
                for (const path of paths) {
                    if (!validPath(path)) throw new Error(t('safety.invalidManifest'));
                    if (onlyPath && (mode === 'upload' ? !local.has(path) : !manifest.files[path] || manifest.files[path].deleted)) throw new Error(t('safety.localChanged', { path }));
                    if (mode === 'upload' && local.has(path)) {
                        // Preserve a divergent remote version before replacing it.
                        if (manifest.files[path] && !manifest.files[path].deleted && manifest.files[path].hash !== local.get(path)?.hash) plan.conflicts.add(path);
                        else plan.uploads.add(path);
                    } else if (mode === 'download' && manifest.files[path] && !manifest.files[path].deleted) plan.downloads.add(path);
                }
            }
            if (plan.deletionsRemote.size >= 10 || (plan.deletionsRemote.size > 1 && plan.deletionsRemote.size / Math.max(snapshots.size, 1) >= 0.2)) {
                throw new Error(t('safety.massDelete'));
            }
            const changed = await this.executor.execute(plan, manifest, deviceId, local, mode === 'download');
            if (JSON.stringify(manifest) !== beforeScan) await this.manager.uploadManifest(manifest, deviceId);
            await this.state.save();
            for (const path of [...plan.deletionsRemote, ...plan.deletionsLocal, ...plan.downloads, ...plan.snapshotClears]) this.deletions.complete(path);
            this.deletions.observe(local.keys());
            this.deletions.observe(plan.downloads);
            result = changed || JSON.stringify(manifest) !== beforeScan;
        } catch (error) {
            failed = true;
            failure = error;
            await this.recordError(error);
        } finally {
            try {
                if (locked) await this.manager.releaseLock(deviceId);
            } catch (releaseError) {
                await this.recordError(releaseError);
                // Cleanup must not replace the error that actually interrupted synchronization.
                if (!failed) { failed = true; failure = releaseError; }
            } finally { this.isSyncing = false; }
        }
        if (failed) throw failure;
        return result;
    }

    private async recordError(error: unknown): Promise<void> {
        try {
            await this.logger.addLog({ action: 'Error', file: '', details: error instanceof Error ? error.message : String(error) });
            await this.logger.flush();
        } catch (loggingError) {
            console.error('[SynologySync] Failed to persist error log', loggingError);
        }
    }

    private async detectLocalChanges(): Promise<Map<string, LocalFileInfo>> {
        const files = new Map<string, LocalFileInfo>();
        for (const file of this.app.vault.getFiles()) {
            if (file.path.startsWith(this.app.vault.configDir + '/') || file.path.split('/').some(part => part.startsWith('.'))) continue;
            if (!validPath(file.path)) throw new Error(t('safety.invalidManifest'));
            if (file.stat.size > 50 * 1024 * 1024) throw new Error(t('safety.largeFile', { path: file.path }));
            const buffer = await this.app.vault.readBinary(file);
            files.set(file.path, { hash: await calculateSHA256(buffer), mtime: file.stat.mtime });
        }
        return files;
    }
}
