import { App, Modal, Notice, PluginSettingTab, Setting } from 'obsidian';
import SynologySyncPlugin from './main';
import { SynologyClient } from './api/client';
import { t } from './locales';

export interface SynologySyncSettings {
	nasUrl: string;
	username: string;
	password: string;
	otpCode: string;
	sid: string;
	syncFolder: string;
	lastSyncTime?: number;
	debugMode?: boolean;
}

export const DEFAULT_SETTINGS: SynologySyncSettings = {
	nasUrl: '',
	username: '',
	password: '',
	otpCode: '',
	sid: '',
	syncFolder: '/ObsidianSync',
	debugMode: false,
};

class ConfirmModal extends Modal {
	message: string;
	onConfirm: () => void;

	constructor(app: App, message: string, onConfirm: () => void) {
		super(app);
		this.message = message;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.setText(this.message);
		
		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText('Cancel')
					.onClick(() => {
						this.close();
					}))
			.addButton((btn) =>
				btn
					.setButtonText('Confirm')
					.setCta()
					.onClick(() => {
						this.close();
						this.onConfirm();
					}));
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class InitialSyncModal extends Modal {
	plugin: SynologySyncPlugin;

	constructor(app: App, plugin: SynologySyncPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: t('settings.initialSync.title') });
		contentEl.createEl('p', { text: t('settings.initialSync.desc') });

		new Setting(contentEl)
			.setName(t('settings.initialSync.upload.name'))
			.setDesc(t('settings.initialSync.upload.desc'))
			.addButton((btn) =>
				btn
					.setButtonText(t('settings.initialSync.upload.btn'))
					.setCta()
					.onClick(() => {
						this.close();
						void this.plugin.doForceUpload();
					})
			);

		new Setting(contentEl)
			.setName(t('settings.initialSync.download.name'))
			.setDesc(t('settings.initialSync.download.desc'))
			.addButton((btn) =>
				btn
					.setButtonText(t('settings.initialSync.download.btn'))
					.setCta()
					.onClick(() => {
						this.close();
						void this.plugin.doForceDownload();
					})
			);

		new Setting(contentEl)
			.setName(t('settings.initialSync.skip.name'))
			.setDesc(t('settings.initialSync.skip.desc'))
			.addButton((btn) =>
				btn
					.setButtonText(t('settings.initialSync.skip.btn'))
					.onClick(() => {
						this.close();
					})
			);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}


// @ts-ignore TS2515: display() is intentionally omitted as it is deprecated in Obsidian 1.13.0+ but still required by older typings
export class SynologySyncSettingTab extends PluginSettingTab {
	plugin: SynologySyncPlugin;

	constructor(app: App, plugin: SynologySyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// @ts-ignore: To support Obsidian 1.13+ setting search capabilities
	getSettingDefinitions() {
		return [
			{
				type: "group",
				heading: t('settings.connection'),
				items: [
					{
						id: "nasUrl",
						name: t('settings.nasUrl.name'),
						description: t('settings.nasUrl.desc'),
						render: (setting: Setting) => {
							setting.addText((text) =>
								text
									.setPlaceholder('HTTPS://...')
									.setValue(this.plugin.settings.nasUrl)
									.onChange(async (value) => {
										this.plugin.settings.nasUrl = value;
										await this.plugin.saveSettings();
									})
							);
						}
					},
					{
						id: "username",
						name: t('settings.username.name'),
						description: t('settings.username.desc'),
						render: (setting: Setting) => {
							setting.addText((text) =>
								text
									.setPlaceholder('Admin')
									.setValue(this.plugin.settings.username)
									.onChange(async (value) => {
										this.plugin.settings.username = value;
										await this.plugin.saveSettings();
									})
							);
						}
					},
					{
						id: "password",
						name: t('settings.password.name'),
						description: t('settings.password.desc'),
						render: (setting: Setting) => {
							setting.addText((text) => {
								text.inputEl.type = 'password';
								text.setPlaceholder('Password')
									.setValue(this.plugin.settings.password)
									.onChange(async (value) => {
										this.plugin.settings.password = value;
										await this.plugin.saveSettings();
									});
							});
						}
					},
					{
						id: "otpCode",
						name: t('settings.otp.name'),
						description: t('settings.otp.desc'),
						render: (setting: Setting) => {
							setting.addText((text) =>
								text
									.setPlaceholder('(Optional)')
									.setValue(this.plugin.settings.otpCode)
									.onChange(async (value) => {
										this.plugin.settings.otpCode = value;
										await this.plugin.saveSettings();
									})
							);
						}
					},
					{
						id: "syncFolder",
						name: t('settings.syncFolder.name'),
						description: t('settings.syncFolder.desc'),
						render: (setting: Setting) => {
							setting.addText((text) =>
								text
									.setPlaceholder('/obsidiansync')
									.setValue(this.plugin.settings.syncFolder)
									.onChange(async (value) => {
										this.plugin.settings.syncFolder = value;
										await this.plugin.saveSettings();
									})
							);
						}
					},
					{
						id: "testConn",
						name: t('settings.testConn.name'),
						description: this.plugin.settings.sid ? t('settings.testConn.desc.hasSid') : t('settings.testConn.desc.noSid'),
						render: (setting: Setting) => {
							setting.addButton((btn) => {
								btn
									.setButtonText(this.plugin.settings.sid ? t('settings.testConn.btn.relogin') : t('settings.testConn.btn.test'))
									.setCta()
									.onClick(async () => {
										const { nasUrl, username, password, otpCode } = this.plugin.settings;
										const client = new SynologyClient(nasUrl, username, password, otpCode);
										
										try {
											const isFirstLogin = !this.plugin.settings.lastSyncTime;
											const sid = await client.login();
											this.plugin.settings.sid = sid;
											this.plugin.settings.otpCode = ''; // 登录成功后清空一次性验证码
											await this.plugin.saveSettings();
											new Notice(t('notice.connSuccess'));
											
											// 强制刷新设置界面
											// 在 Obsidian 1.13+ 的声明式设置中，调用 this.update() 即可刷新
											(this as unknown as { update: () => void }).update();

											if (isFirstLogin) {
												new InitialSyncModal(this.app, this.plugin).open();
											}
										} catch (err: unknown) {
											const errorMsg = err instanceof Error ? err.message : String(err);
											new Notice(t('notice.connFailed', { error: errorMsg }));
										}
									});
							});
						}
					},
					{
						id: "debugMode",
						name: t('settings.debugMode.name'),
						description: t('settings.debugMode.desc'),
						render: (setting: Setting) => {
							setting.addToggle((toggle) =>
								toggle
									.setValue(this.plugin.settings.debugMode ?? false)
									.onChange(async (value) => {
										this.plugin.settings.debugMode = value;
										await this.plugin.saveSettings();
									})
							);
						}
					}
				]
			},
			{
				type: "group",
				heading: t('settings.dangerZone'),
				items: [
					{
						id: "dangerZoneDesc",
						render: (setting: Setting) => {
							setting.setDesc(t('settings.dangerZone.desc'));
						}
					},
					{
						id: "forceUpload",
						name: t('settings.forceUpload.name'),
						description: t('settings.forceUpload.desc'),
						render: (setting: Setting) => {
							setting.addButton((btn) => {
								btn.setButtonText(t('settings.forceUpload.btn'))
								   .setWarning()
								   .onClick(() => {
									   new ConfirmModal(this.app, t('settings.forceUpload.confirm'), () => {
										   void this.plugin.doForceUpload();
									   }).open();
								   });
							});
						}
					},
					{
						id: "forceDownload",
						name: t('settings.forceDownload.name'),
						description: t('settings.forceDownload.desc'),
						render: (setting: Setting) => {
							setting.addButton((btn) => {
								btn.setButtonText(t('settings.forceDownload.btn'))
								   .setWarning()
								   .onClick(() => {
									   new ConfirmModal(this.app, t('settings.forceDownload.confirm'), () => {
										   void this.plugin.doForceDownload();
									   }).open();
								   });
							});
						}
					},
					{
						id: "rebuild",
						name: t('settings.rebuild.name'),
						description: t('settings.rebuild.desc'),
						render: (setting: Setting) => {
							setting.addButton((btn) => {
								btn.setButtonText(t('settings.rebuild.btn'))
								   .onClick(() => {
									   new ConfirmModal(this.app, t('settings.rebuild.confirm'), () => {
										   void this.plugin.doRebuildSyncState();
									   }).open();
								   });
							});
						}
					}
				]
			}
		];
	}
}
