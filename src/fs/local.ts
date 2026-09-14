import { App, TFile } from 'obsidian';
import { t } from '../locales';

export class LocalFS {
	private app: App;

	constructor(app: App) {
		this.app = app;
	}

	/**
	 * 读取本地文件的 ArrayBuffer (方便与云端二进制对比或上传)
	 */
	async read(path: string): Promise<ArrayBuffer | null> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			return await this.app.vault.readBinary(file);
		}
		return null;
	}

	/**
	 * 写入数据到本地文件 (如果存在则覆盖，如果不存在则创建)
	 */
	async write(path: string, data: ArrayBuffer): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			await this.app.vault.modifyBinary(file, data);
		} else {
			// 需要确保父目录存在
			const parentPath = path.substring(0, path.lastIndexOf('/'));
			if (parentPath && !this.app.vault.getAbstractFileByPath(parentPath)) {
				await this.ensureFolder(parentPath);
			}
			await this.app.vault.createBinary(path, data);
		}
	}

    /** Compare and replace text inside Obsidian's atomic process callback. */
    async writeChecked(path: string, data: ArrayBuffer, expected: ArrayBuffer | null): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile && expected !== null) {
            const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
            let previous: string;
            let next: string;
            try { previous = decoder.decode(expected); next = decoder.decode(data); }
            catch {
                // Obsidian exposes no atomic binary compare-and-replace; caller checks and preserves versions.
                await this.write(path, data);
                return;
            }
            await this.app.vault.process(file, current => {
                if (current !== previous) throw new Error(t('safety.localChanged', { path }));
                return next;
            });
        } else {
            if (file || expected !== null) throw new Error(t('safety.localChanged', { path }));
            // createBinary rejects an existing path rather than overwriting it.
            const parent = path.substring(0, path.lastIndexOf('/'));
            if (parent) await this.ensureFolder(parent);
            await this.app.vault.createBinary(path, data);
        }
    }

	/**
	 * 删除本地文件或目录
	 */
	async delete(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file) {
			await this.app.fileManager.trashFile(file);
		}
	}

	/**
	 * 获取本地文件元数据 (主要用于最后修改时间和大小)
	 */
	getMetadata(path: string): { mtime: number; size: number } | null {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			return {
				mtime: file.stat.mtime,
				size: file.stat.size
			};
		}
		return null;
	}

	/**
	 * 递归创建目录
	 */
	private async ensureFolder(path: string): Promise<void> {
		const folders = path.split('/');
		let currentPath = '';

		for (const folder of folders) {
			currentPath = currentPath === '' ? folder : `${currentPath}/${folder}`;
			const abstractFile = this.app.vault.getAbstractFileByPath(currentPath);
			if (!abstractFile) {
				await this.app.vault.createFolder(currentPath);
			}
		}
	}
}
