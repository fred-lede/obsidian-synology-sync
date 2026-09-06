import { Notice, Plugin, setIcon, setTooltip, TAbstractFile, TFile } from 'obsidian';
import {
	DEFAULT_SETTINGS,
	SynologySyncSettings,
	SynologySyncSettingTab,
} from './settings';
import { t } from './locales';


import type { SyncLogger } from './sync/logger';
type SyncUIState = 
	| 'idle'
	| 'syncing' 
	| 'force-uploading' 
	| 'force-downloading' 
	| 'rebuilding' 
	| 'error';

export default class SynologySyncPlugin extends Plugin {
	settings!: SynologySyncSettings;
	public logger!: SyncLogger;
	private statusBarItem!: HTMLElement;
	private syncTimeout: number | null = null;
	private isSyncing: boolean = false;
	private currentUIState: SyncUIState = 'idle';
	private uiResetTimer: number | null = null;
	
	updateStatusBar(state: SyncUIState) {
		this.currentUIState = state;
		if (this.uiResetTimer) {
			window.clearTimeout(this.uiResetTimer);
			this.uiResetTimer = null;
		}

		this.statusBarItem.empty();
		let iconName = 'cloud';
		let tooltipText = '';

		switch (state) {
			case 'idle':
				iconName = this.settings.lastSyncTime ? 'check-circle' : 'cloud';
				if (this.settings.lastSyncTime) {
					const date = new Date(this.settings.lastSyncTime);
					const timeStr = date.getHours().toString().padStart(2, '0') + ':' + date.getMinutes().toString().padStart(2, '0');
					tooltipText = t('status.standbyWithTime', { time: timeStr });
				} else {
					tooltipText = t('status.standby');
				}
				break;
			case 'syncing':
				iconName = 'refresh-cw';
				tooltipText = t('status.syncing');
				break;
			case 'force-uploading':
				iconName = 'upload-cloud';
				tooltipText = t('status.forceUploading');
				break;
			case 'force-downloading':
				iconName = 'download-cloud';
				tooltipText = t('status.forceDownloading');
				break;
			case 'rebuilding':
				iconName = 'database';
				tooltipText = t('status.rebuilding');
				break;
			case 'error':
				iconName = 'alert-triangle';
				tooltipText = t('status.error');
				break;
		}

		setIcon(this.statusBarItem, iconName);
		setTooltip(this.statusBarItem, tooltipText, { placement: 'top' });
	}

	async onload() {
		await this.loadSettings();
		
		
		const { SyncLogger } = await import('./sync/logger');
		this.logger = new SyncLogger(this.app, this.manifest.dir!);

		// 添加设置面板
		this.addSettingTab(new SynologySyncSettingTab(this.app, this));

		// 测试命令：将当前打开的文件上传到群晖
		this.addCommand({
			id: 'upload-active',
			name: t('command.uploadActive'),
			callback: async () => {
				await this.uploadActiveFile();
			}
		});

		// 测试命令：从群晖下载当前路径的文件并覆盖本地
		this.addCommand({
			id: 'download-active',
			name: t('command.downloadActive'),
			callback: async () => {
				await this.downloadActiveFile();
			}
		});

		const { SyncStatusView, VIEW_TYPE_SYNC_STATUS } = await import('./ui/sync-status-view');
		this.registerView(
			VIEW_TYPE_SYNC_STATUS,
			(leaf) => new SyncStatusView(leaf, this)
		);

		this.addCommand({
			id: 'toggle-sync-status-view',
			name: t('command.toggleStatusView'),
			callback: () => {
				void this.toggleSyncStatusView();
			}
		});

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (file instanceof TFile) {
					menu.addItem((item) => {
						item
							.setTitle(t('command.toggleStatusView'))
							.setIcon('cloud')
							.onClick(() => {
								void this.toggleSyncStatusView();
							});
					});
				}
			})
		);

		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu) => {
				menu.addItem((item) => {
					item
						.setTitle(t('command.toggleStatusView'))
						.setIcon('cloud')
						.onClick(() => {
							void this.toggleSyncStatusView();
						});
				});
			})
		);


		// 添加状态栏提示
		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.classList.add('mod-clickable');
		this.updateStatusBar('idle');
		this.statusBarItem.onClickEvent(() => {
			void this.runEngineSync(false, true);
		});
		
		const ribbonIconEl = this.addRibbonIcon('refresh-cw', t('plugin.name'), (evt: MouseEvent) => {
			void this.runEngineSync(false, true);
		});
		if (ribbonIconEl.parentNode) {
			ribbonIconEl.parentNode.insertBefore(ribbonIconEl, ribbonIconEl.parentNode.firstChild);
		}


		// 监听本地文件变更，防抖触发同步 (3秒)
		this.registerEvent(this.app.vault.on('modify', (file) => this.triggerAutoSync(file)));
		this.registerEvent(this.app.vault.on('create', (file) => this.triggerAutoSync(file)));
		this.registerEvent(this.app.vault.on('delete', (file) => this.triggerAutoSync(file)));
		this.registerEvent(this.app.vault.on('rename', (file) => this.triggerAutoSync(file)));

		// 定时轮询远端变更 (每 30 秒一次 Quick Sync)
		this.registerInterval(
			window.setInterval(() => {
				void this.runEngineSync(false);
			}, 30 * 1000)
		);

		// 启动时执行一次全量同步 (Full Sync) 探测远端删除，为了不阻塞，延迟执行
		window.setTimeout(() => {
			void this.runEngineSync(true);
		}, 2000);
		
		// 同步引擎命令
		this.addCommand({
			id: 'run',
			name: t('command.runQuick'),
			callback: async () => {
				await this.runEngineSync(false, true);
			}
		});

		this.addCommand({
			id: 'run-full',
			name: t('command.runFull'),
			callback: async () => {
				await this.runEngineSync(true, true);
			}
		});

		this.addCommand({
			id: 'show-log',
			name: t('command.showLog'),
			callback: async () => {
				const { SyncLogModal } = await import('./ui/sync-log-modal');
				new SyncLogModal(this.app, this.logger).open();
			}
		});
	}

	async toggleSyncStatusView() {
		const { VIEW_TYPE_SYNC_STATUS } = await import('./ui/sync-status-view');
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SYNC_STATUS);
		if (leaves.length > 0) {
			this.app.workspace.detachLeavesOfType(VIEW_TYPE_SYNC_STATUS);
		} else {
			const leaf = this.app.workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({ type: VIEW_TYPE_SYNC_STATUS, active: true });
				void this.app.workspace.revealLeaf(leaf);
			}
		}
	}

	triggerAutoSync(file?: TAbstractFile) {
		// 忽略 Obsidian 自身的配置和插件产生的变更（比如我们自己的 sync_data.json），否则会陷入无限循环同步
		if (file && file.path && file.path.startsWith(this.app.vault.configDir + '/')) {
			return;
		}
		// 忽略同步本身的元数据文件
		if (file && (file.name === '.sync_manifest.json' || file.name === '.sync_lock')) {
			return;
		}

		if (this.syncTimeout) {
			window.clearTimeout(this.syncTimeout);
		}
		this.syncTimeout = window.setTimeout(() => {
			void this.runEngineSync(false);
		}, 3000); // 停止打字 3 秒后自动同步
	}

	async getClient() {
		const { nasUrl, username, password, otpCode, sid } = this.settings;
		const { SynologyClient } = await import('./api/client');
		const client = new SynologyClient(nasUrl, username, password, otpCode);
		client.debugMode = this.settings.debugMode ?? false;
		if (sid) (client as unknown as { sid: string }).sid = sid;
		return client;
	}

	async getEngine() {
		const { nasUrl, username, password, otpCode, sid, syncFolder } = this.settings;
		if (!sid || !syncFolder) {
			throw new Error(t('notice.nasParamsMissing'));
		}

		const { SynologyClient } = await import('./api/client');
		const { SyncEngine } = await import('./sync/engine');
		const { SyncState } = await import('./sync/state');

		const client = new SynologyClient(nasUrl, username, password, otpCode);
		client.debugMode = this.settings.debugMode ?? false;
		(client as unknown as { sid: string }).sid = sid;

		const state = new SyncState(this.app, this.manifest.dir!);
		return new SyncEngine(this.app, client, state, this.logger, syncFolder);
	}

	async runEngineSync(fullScan: boolean, showNotice: boolean = false) {
		if (this.isSyncing) {
			if (showNotice) new Notice(t('notice.engine.syncing'));
			return;
		}
		
		let syncNotice: Notice | null = null;
		
		try {
			this.isSyncing = true;
			this.updateStatusBar('syncing');
			
			if (showNotice) {
				syncNotice = new Notice(t('notice.engine.syncing'), 0);
			}
			
			const engine = await this.getEngine();
			const hasChanges = await engine.runSync(fullScan);
			
			if (hasChanges) {
				this.settings.lastSyncTime = Date.now();
				void this.saveSettings();
				this.updateStatusBar('idle');
				if (syncNotice) {
					syncNotice.setMessage(t('notice.engine.syncSuccess'));
					window.setTimeout(() => syncNotice!.hide(), 3000);
				}
			} else {
				this.updateStatusBar('idle');
				if (syncNotice) {
					syncNotice.setMessage(t('notice.engine.syncUpToDate'));
					window.setTimeout(() => syncNotice!.hide(), 3000);
				}
			}
			this.app.workspace.trigger('synology-sync:sync-completed');
		} catch (err: unknown) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			this.updateStatusBar('error');
			if (syncNotice) syncNotice.hide();
			new Notice(t('notice.syncException', { error: errorMsg }));
		} finally {
			this.isSyncing = false;
		}
	}


	onunload() {
		// 插件卸载时的清理逻辑
	}

	async doForceUpload() {
		if (this.isSyncing) return;
		try {
			this.isSyncing = true;
			this.updateStatusBar('force-uploading');
			const engine = await this.getEngine();
			await engine.forceUpload();
			this.settings.lastSyncTime = Date.now();
			void this.saveSettings();
			this.updateStatusBar('idle');
			new Notice(t('notice.forceUploadSuccess'));
			this.app.workspace.trigger('synology-sync:sync-completed');
		} catch (e: unknown) {
			const errorMsg = e instanceof Error ? e.message : String(e);
			console.error('[SynologySync] 强制上传失败:', e);
			this.updateStatusBar('error');
			new Notice(t('notice.forceUploadFailed', { error: errorMsg }));
		} finally {
			this.isSyncing = false;
		}
	}

	async doForceDownload() {
		if (this.isSyncing) return;
		try {
			this.isSyncing = true;
			this.updateStatusBar('force-downloading');
			const engine = await this.getEngine();
			await engine.forceDownload();
			this.settings.lastSyncTime = Date.now();
			void this.saveSettings();
			this.updateStatusBar('idle');
			new Notice(t('notice.forceDownloadSuccess'));
			this.app.workspace.trigger('synology-sync:sync-completed');
		} catch (e: unknown) {
			const errorMsg = e instanceof Error ? e.message : String(e);
			console.error('[SynologySync] 强制下载失败:', e);
			this.updateStatusBar('error');
			new Notice(t('notice.forceDownloadFailed', { error: errorMsg }));
		} finally {
			this.isSyncing = false;
		}
	}

	async doRebuildSyncState() {
		if (this.isSyncing) return;
		try {
			this.isSyncing = true;
			this.updateStatusBar('rebuilding');
			const engine = await this.getEngine();
			await engine.rebuildSyncState();
			this.settings.lastSyncTime = Date.now();
			void this.saveSettings();
			this.updateStatusBar('idle');
			new Notice(t('notice.rebuildSuccess'));
		} catch (e: unknown) {
			const errorMsg = e instanceof Error ? e.message : String(e);
			console.error('[SynologySync] 重建同步状态失败:', e);
			this.updateStatusBar('error');
			new Notice(t('notice.rebuildFailed', { error: errorMsg }));
		} finally {
			this.isSyncing = false;
		}
	}

	async uploadActiveFile() {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice(t('notice.noActiveFile'));
			return;
		}

		let notice: Notice | null = null;
		try {
			const { SynologyClient } = await import('./api/client');
			const { nasUrl, username, password, sid, syncFolder } = this.settings;
			if (!sid) {
				new Notice(t('notice.loginRequired'));
				return;
			}

			const client = new SynologyClient(nasUrl, username, password);
			client.debugMode = this.settings.debugMode ?? false;
			(client as unknown as { sid: string }).sid = sid; // 注入现有的 sid

			// 读取文件内容为二进制
			const buffer = await this.app.vault.readBinary(activeFile);

			let targetPath = `${syncFolder}/${activeFile.path}`;
			if (!targetPath.startsWith('/mydrive/') && !targetPath.startsWith('/team-folders/')) {
				targetPath = `/mydrive${targetPath.startsWith('/') ? '' : '/'}${targetPath}`;
			}
			// 移除可能存在的双斜杠
			targetPath = targetPath.replace(/\/\//g, '/');

			const n = new Notice(t('notice.uploading', { targetPath }), 0);
			notice = n;
			await client.uploadFile(targetPath, buffer);
			n.setMessage(t('notice.uploadSuccess'));
			window.setTimeout(() => n.hide(), 3000);
			this.app.workspace.trigger('synology-sync:sync-completed');
		} catch (err: unknown) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			const n = notice;
			if (n) {
				n.setMessage(t('notice.uploadFailed', { error: errorMsg }));
				window.setTimeout(() => n.hide(), 5000);
			} else {
				new Notice(t('notice.uploadFailed', { error: errorMsg }));
			}
		}
	}

	async downloadActiveFile() {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice(t('notice.noActiveFileToDefine'));
			return;
		}

		let notice: Notice | null = null;
		try {
			const { SynologyClient } = await import('./api/client');
			const { LocalFS } = await import('./fs/local');
			const { nasUrl, username, password, sid, syncFolder } = this.settings;
			if (!sid) {
				new Notice(t('notice.loginRequired'));
				return;
			}

			const client = new SynologyClient(nasUrl, username, password);
			client.debugMode = this.settings.debugMode ?? false;
			(client as unknown as { sid: string }).sid = sid;

			let targetPath = `${syncFolder}/${activeFile.path}`;
			if (!targetPath.startsWith('/mydrive/') && !targetPath.startsWith('/team-folders/')) {
				targetPath = `/mydrive${targetPath.startsWith('/') ? '' : '/'}${targetPath}`;
			}
			targetPath = targetPath.replace(/\/\//g, '/');

			const n = new Notice(t('notice.downloading', { targetPath }), 0);
			notice = n;
			const buffer = await client.downloadFile(targetPath);
			const localFs = new LocalFS(this.app);
			await localFs.write(activeFile.path, buffer);
			
			n.setMessage(t('notice.downloadSuccess'));
			window.setTimeout(() => n.hide(), 3000);
			this.app.workspace.trigger('synology-sync:sync-completed');
		} catch (err: unknown) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			const n = notice;
			if (n) {
				n.setMessage(t('notice.downloadFailed', { error: errorMsg }));
				window.setTimeout(() => n.hide(), 5000);
			} else {
				new Notice(t('notice.downloadFailed', { error: errorMsg }));
			}
		}
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<SynologySyncSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
