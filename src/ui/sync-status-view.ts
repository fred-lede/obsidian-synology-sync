import { ItemView, WorkspaceLeaf, setIcon } from 'obsidian';
import type SynologySyncPlugin from '../main';
import { SyncState } from '../sync/state';
import { t } from '../locales';
import { normalizeRemoteFolder, remoteFilePath } from '../api/paths';
import { syncTarget } from '../sync/remote-access';
import { ManifestManager, SyncManifest } from '../sync/manifest';

interface RemoteMetadata {
    data?: {
        mtime?: number;
        modified_time?: number;
        version_id?: string;
        size?: number;
        file_id?: string;
        revision_id?: string;
    }
}

export const VIEW_TYPE_SYNC_STATUS = 'synology-sync-status-view';

export class SyncStatusView extends ItemView {
    private plugin: SynologySyncPlugin;
    private syncState: SyncState;

    constructor(leaf: WorkspaceLeaf, plugin: SynologySyncPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.syncState = new SyncState(this.app, this.plugin.manifest.dir!);
    }

    getViewType(): string {
        return VIEW_TYPE_SYNC_STATUS;
    }

    getDisplayText(): string {
        return t('ui.statusView.title');
    }

    getIcon(): string {
        return 'cloud';
    }

    async onOpen() {
        this.registerEvent(
            this.app.workspace.on('file-open', () => {
                void this.render();
            })
        );
        this.registerEvent(
            this.app.workspace.on('synology-sync:sync-completed' as 'file-open', () => {
                void this.render();
            })
        );
        void this.render();
    }

    async onClose() {
        // Events are automatically cleaned up by registerEvent
    }

    async render() {
        const { contentEl } = this;
        contentEl.empty();
        
        contentEl.addClass('synology-sync-status-view');

        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
            contentEl.createDiv({ text: t('ui.statusView.noFile'), cls: 'sync-status-no-file' });
            return;
        }

        contentEl.createDiv({ text: activeFile.name, cls: 'sync-status-header' });

        const loadingEl = contentEl.createDiv({ text: t('ui.statusView.loading'), cls: 'sync-status-loading' });

        this.syncState = new SyncState(this.app, this.plugin.manifest.dir!, syncTarget(this.plugin.settings.nasUrl, this.plugin.settings.username, this.plugin.settings.syncFolder));
        try { await this.syncState.load(); } catch {
            loadingEl.setText(t('safety.invalidManifest'));
            return;
        }
        const localEntry = this.syncState.getFileState(activeFile.path);
        
        const localMtime = activeFile.stat.mtime;
        const localSize = activeFile.stat.size;

        let remoteManifest: SyncManifest | null = null;
        let remoteMetadata: RemoteMetadata | null = null;
        let remoteError = '';
        try {
            const client = await this.plugin.getClient();
            const { syncFolder } = this.plugin.settings;
            if (syncFolder) {
                const manager = new ManifestManager(client, normalizeRemoteFolder(syncFolder));
                remoteManifest = await manager.downloadManifest();

                const targetPath = remoteFilePath(syncFolder, activeFile.path);
                remoteMetadata = (await client.getMetadata(targetPath)) as RemoteMetadata | null;
                if (remoteMetadata === null) remoteError = t('ui.statusView.remoteQueryFailed');
            }
        } catch (e) {
            remoteError = e instanceof Error ? e.message : String(e);
            console.error('Failed to fetch remote metadata', e);
        }
        
        loadingEl.remove();

        const dataObj = remoteMetadata?.data;
        const modifiedTime = dataObj?.modified_time ?? dataObj?.mtime;
        const remoteMtime = modifiedTime ? modifiedTime * 1000 : null;
        const remoteSize = dataObj?.size;

        // Determine Status
        let statusText = t('ui.statusView.stateUntracked');
        let statusIcon = 'help-circle';
        if (remoteError) {
            statusText = t('ui.statusView.remoteQueryFailed');
            statusIcon = 'alert-triangle';
        } else if (localEntry) {
            const isLocalModified = localEntry.localMtime < localMtime;
            const remoteEntry = remoteManifest?.files[activeFile.path];
            const isRemoteModified = remoteEntry ? remoteEntry.rev !== localEntry.syncedRev : false;
            
            if (isLocalModified && isRemoteModified) {
                statusText = t('ui.statusView.stateConflict');
                statusIcon = 'alert-triangle';
            } else if (isLocalModified) {
                statusText = t('ui.statusView.stateUpload');
                statusIcon = 'upload-cloud';
            } else if (isRemoteModified) {
                statusText = t('ui.statusView.stateDownload');
                statusIcon = 'download-cloud';
            } else {
                statusText = t('ui.statusView.stateSynced');
                statusIcon = 'check-circle';
            }
        }

        const indicatorEl = contentEl.createDiv({ cls: 'sync-status-indicator' });
        indicatorEl.createEl('strong', { text: `${t('ui.statusView.statusLabel')}: ` });
        
        const valEl = indicatorEl.createSpan({ cls: 'sync-status-value' });
        const iconEl = valEl.createSpan({ cls: 'sync-status-icon' });
        setIcon(iconEl, statusIcon);
        valEl.createSpan({ text: ` ${statusText}` });

        // Local Info
        contentEl.createDiv({ text: t('ui.statusView.localSection'), cls: 'sync-status-section-header' });
        const localInfoEl = contentEl.createEl('ul');
        localInfoEl.createEl('li', { text: `${t('ui.statusView.localMtime')}: ${new Date(localMtime).toLocaleString()}` });
        localInfoEl.createEl('li', { text: `${t('ui.statusView.localSize')}: ${this.formatBytes(localSize)}` });

        // Remote Info
        contentEl.createDiv({ text: t('ui.statusView.remoteSection'), cls: 'sync-status-section-header' });
        if (remoteError) {
            contentEl.createDiv({ text: t('ui.statusView.remoteQueryError', { error: remoteError }), cls: 'sync-status-not-found' });
        } else if (dataObj) {
            const remoteInfoEl = contentEl.createEl('ul');
            if (remoteMtime) {
                remoteInfoEl.createEl('li', { text: `${t('ui.statusView.remoteMtime')}: ${new Date(remoteMtime).toLocaleString()}` });
            }
            if (remoteSize !== undefined) {
                remoteInfoEl.createEl('li', { text: `${t('ui.statusView.remoteSize')}: ${this.formatBytes(remoteSize)}` });
            }
            if (dataObj.file_id) {
                remoteInfoEl.createEl('li', { text: `${t('ui.statusView.remoteFileId')}: ${dataObj.file_id}` });
            }
            if (dataObj.version_id ?? dataObj.revision_id) {
                remoteInfoEl.createEl('li', { text: `${t('ui.statusView.remoteRevId')}: ${dataObj.version_id ?? dataObj.revision_id}` });
            }
        } else {
            contentEl.createDiv({ text: t('ui.statusView.remoteNotFound'), cls: 'sync-status-not-found' });
        }

        // Actions
        const actionsEl = contentEl.createDiv({ cls: 'sync-status-actions' });
        const btnUpload = actionsEl.createEl('button', { text: t('ui.statusView.btnUpload') });
        btnUpload.onclick = async () => {
            if (this.plugin.uploadActiveFile) {
                await this.plugin.uploadActiveFile();
                void this.render();
            }
        };

        const btnDownload = actionsEl.createEl('button', { text: t('ui.statusView.btnDownload') });
        btnDownload.onclick = async () => {
            if (this.plugin.downloadActiveFile) {
                await this.plugin.downloadActiveFile();
                void this.render();
            }
        };
    }

    private formatBytes(bytes: number, decimals = 2) {
        if (!+bytes) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
    }
}
