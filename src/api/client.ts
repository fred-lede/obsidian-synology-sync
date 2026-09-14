import { requestUrl, RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { t } from '../locales';

interface ApiResponse {
	success?: boolean;
	error?: { 
		code?: number | string;
		errors?: { message?: string; line?: number };
	};
	data?: Record<string, unknown>;
}

export class SynologyClient {
	private baseUrl: string;
	private username: string;
	private password?: string;
	private otpCode?: string; // 2FA 双重验证码
	private sid?: string; // Session ID
	private _debugMode: boolean = false;

	constructor(baseUrl: string, username: string, password?: string, otpCode?: string) {
		// 确保不以斜杠结尾
		this.baseUrl = baseUrl.replace(/\/+$/, '');
		this.username = username;
		this.password = password;
		this.otpCode = otpCode;
	}

	getSyncTarget(folder: string): string {
		return JSON.stringify([this.baseUrl, this.username, folder.replace(/\/+$/, '')]);
	}

	set debugMode(value: boolean) {
		this._debugMode = value;
	}

	private debugLog(...args: unknown[]) {
		if (this._debugMode) {
			console.debug('[SynologySync:DEBUG]', ...args);
		}
	}

	/**
	 * 安全请求包装，修复 64 位整形 js 解析精度丢失问题，内置 1~3 次请求防抖和重试
	 */
	private async safeRequestUrl(req: RequestUrlParam, retries = 3): Promise<{ status: number, text: string, json: unknown, headers: Record<string, string>, arrayBuffer: ArrayBuffer }> {
		let res: RequestUrlResponse | null = null;
		let lastErr: unknown;
		
		for (let i = 0; i < retries; i++) {
			try {
				res = await requestUrl(req);
				// 如果遭遇速率限制或服务端错误 (5xx)，稍作等待后重试
				if (res.status === 429 || res.status >= 500) {
					lastErr = new Error(`HTTP ${res.status}: ${res.text}`);
					await new Promise(r => window.setTimeout(r, 1000 * (i + 1))); 
					continue;
				}
				break; // 常见 200 或者不可恢复的 400 会跳出，由调用方继续处理
			} catch (e: unknown) {
				lastErr = e;
				await new Promise(r => window.setTimeout(r, 1000 * (i + 1))); 
			}
		}
		
		if (!res || (res.status === 429 || res.status >= 500)) {
			const errToThrow = lastErr instanceof Error ? lastErr : new Error(String(lastErr) || "Request failed after retries");
			throw errToThrow;
		}
		
		let parsedJson: unknown = null;
		if (res.text && typeof res.text === 'string') {
			try {
				const patchedText = res.text
					.replace(/"file_id"\s*:\s*(\d+)/g, '"file_id":"$1"')
					.replace(/"id"\s*:\s*(\d+)/g, '"id":"$1"')
					.replace(/"revision_id"\s*:\s*(\d+)/g, '"revision_id":"$1"');
				parsedJson = JSON.parse(patchedText);
			} catch { /* ignore */ }
		}
		return {
			status: res.status,
			text: res.text,
			json: parsedJson,
			headers: res.headers,
			arrayBuffer: res.arrayBuffer
		};
	}

	/**
	 * 通用的请求封装
	 */
	private async request(
		endpoint: string,
		params: unknown,
		method: 'GET' | 'POST' = 'GET',
		contentType: string = 'application/json'
	): Promise<{ status: number, text: string, json: unknown, headers: Record<string, string>, arrayBuffer: ArrayBuffer }> {
		const url = new URL(this.baseUrl + endpoint);
		
		let req: RequestUrlParam = {
			url: url.toString(),
			method,
			headers: {
				'Accept': 'application/json',
			},
			throw: false // 不要让 Obsidian 在 4xx 报错时阻断我们读取 body
		};

		// 既加 Cookie，也加 URL 参数，双保险，防止部分客户端屏蔽 Cookie Header
		if (this.sid) {
			req.headers!['Cookie'] = `id=${this.sid};`;
			url.searchParams.append('_sid', this.sid);
		}

		if (method === 'GET') {
			Object.entries(params as Record<string, unknown>).forEach(([key, value]) => {
				url.searchParams.append(key, value as string);
			});
			req.url = url.toString();
		} else {
			req.url = url.toString(); // 保存可能追加了 _sid 的 URL
			req.headers!['Content-Type'] = contentType;
			if (contentType === 'application/json') {
				req.body = JSON.stringify(params);
			} else if (contentType === 'application/x-www-form-urlencoded') {
				const formParams = new URLSearchParams();
				Object.entries(params as Record<string, unknown>).forEach(([key, value]) => {
					formParams.append(key, value as string);
				});
				req.body = formParams.toString();
			}
		}

		// 这里会统一校验抛出 400 以上的异常，不再由于 404/401 提供幽灵数据
		const res = await this.safeRequestUrl(req);
		if (res.status >= 400) {
			let errorDetail = '';
			const json = res.json as ApiResponse | null;
			if (json && json.error) {
				errorDetail = `API Error Code: ${json.error.code}`;
			} else {
				errorDetail = res.text;
			}
			throw new Error(`HTTP ${res.status}: ${errorDetail}`);
		}
		
		const json = res.json as ApiResponse | null;
		if (json && json.success === false) {
			const code = json.error?.code || 'Unknown';
			throw new Error(`API Error Code: ${code}`);
		}
		
		if (json?.success !== true) throw new Error(t('safety.invalidResponse'));
		return res;
	}

	/**
	 * 获取鉴权 (Sign in)
	 */
	async login(): Promise<string> {
		if (!this.baseUrl || !this.username || !this.password) {
			throw new Error("请先填写完整 NAS 地址、用户名和密码");
		}

		const endpoint = '/api/SynologyDrive/default/v2/login';
		const payload: Record<string, string> = {
			format: 'sid',
			account: this.username,
			passwd: this.password
		};

		if (this.otpCode) {
			payload.otp_code = this.otpCode;
		}

		try {
			const res = await this.request(endpoint, payload, 'POST', 'application/json');
			const result = res.json as { success?: boolean; data?: { sid?: string }; error?: { code?: string | number } };

			if (result && result.success) {
				this.sid = result.data?.sid;
				return this.sid as string;
			} else {
				throw new Error(result?.error?.code ? `Error Code: ${result.error.code}` : "登录失败，请检查账号密码");
			}
		} catch (error: unknown) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			throw new Error(errorMsg || "请求异常，请检查 NAS 地址是否可达");
		}
	}

	/**
	 * 测试连接 (使用 login 接口验证)
	 */
	async testConnection(): Promise<boolean> {
		const sid = await this.login();
		return !!sid;
	}

	/**
	 * 获取文件或目录的元数据
	 */
	async getMetadata(path: string): Promise<unknown> {
		const endpoint = '/api/SynologyDrive/default/v2/files';
		const params = { path };
		try {
			const res = await this.request(endpoint, params, 'GET');
			return res.json;
		} catch (e: unknown) {
			const errorMsg = e instanceof Error ? e.message : String(e);
			if (errorMsg.includes('1003')) return null;
			throw e;
		}
	}

	/**
	 * 列出目录下的文件和文件夹
	 */
	async listFiles(path: string): Promise<unknown> {
		this.debugLog('listFiles', { path });
		const endpoint = '/api/SynologyDrive/default/v2/files/list';
		
		let allFiles: unknown[] = [];
		let offset = 0;
		const limit = 200; // 降低 limit 避免移动端 JSON 过大被截断抛出 Parse Error
		let hasMore = true;
		
		type ListResponse = ApiResponse & { data?: { items?: unknown[], has_more?: boolean } };
		let lastResponse: ListResponse | null = null;

		while (hasMore) {
			const url = new URL(this.baseUrl + endpoint);
			url.searchParams.append('path', path);
			url.searchParams.append('limit', limit.toString());
			url.searchParams.append('offset', offset.toString());
			if (this.sid) url.searchParams.append('_sid', this.sid);

			let req: RequestUrlParam = {
				url: url.toString(),
				method: 'POST',
				headers: {
					'Accept': 'application/json',
					'Content-Type': 'application/json'
				},
				throw: false
			};
			if (this.sid) req.headers!['Cookie'] = `id=${this.sid};`;
			req.body = "{}"; // 没有额外的 body

			const res = await this.safeRequestUrl(req);
			this.debugLog('listFiles response', { status: res.status, itemCount: (res.json as {data?: {items?: unknown[]}})?.data?.items?.length });
			if (res.status >= 400) {
				const json = res.json as ApiResponse | null;
				const errText = (json && json.error ? `API Error Code: ${json.error.code}` : res.text) || `HTTP ${res.status}`;
				throw new Error(`HTTP ${res.status}: ${errText}`);
			}
			
			const json = res.json as ListResponse | null;
			if (json && json.success === false) {
				const code = json.error?.code || 'Unknown';
				throw new Error(`API Error Code: ${code} - ${json.error?.errors?.message || 'list node failed'}`);
			}
			
			if (json?.success !== true || !json.data || !Array.isArray(json.data.items)) throw new Error(t('safety.invalidResponse'));
			if (json.data.items.some(item => !item || typeof item !== 'object' || !('name' in item) || typeof item.name !== 'string')) throw new Error(t('safety.invalidResponse'));
			lastResponse = json;
			
			if (json?.data?.items && Array.isArray(json.data.items)) {
				allFiles.push(...json.data.items);
			}
			
			if (json.data.has_more === true || (json.data.has_more === undefined && json.data.items.length === limit)) {
				hasMore = true;
				offset += limit;
			} else {
				hasMore = false;
			}
		}
		
		if (lastResponse && lastResponse.data) {
			lastResponse.data.items = allFiles;
		}
		
		return lastResponse;
	}

	async hasFile(path: string): Promise<boolean> {
        const slash = path.lastIndexOf('/');
        const name = path.slice(slash + 1);
        const response = await this.listFiles(path.slice(0, slash)) as { data: { items: Array<{ name: string }> } };
        return response.data.items.some(item => item.name === name);
    }

	/**
	 * 创建文件夹
	 */
	async createFolder(path: string, conflictAction: 'overwrite' | 'stop' = 'overwrite'): Promise<unknown> {
		const endpoint = '/api/SynologyDrive/default/v2/files';
		const url = new URL(this.baseUrl + endpoint);
		url.searchParams.append('type', 'folder');
		url.searchParams.append('path', path);
		url.searchParams.append('conflict_action', conflictAction);
		if (this.sid) url.searchParams.append('_sid', this.sid);

		let req: RequestUrlParam = {
			url: url.toString(),
			method: 'POST',
			headers: {
				'Accept': 'application/json',
				'Content-Type': 'application/json'
			},
			throw: false
		};
		if (this.sid) req.headers!['Cookie'] = `id=${this.sid};`;
		req.body = "{}"; // 创建文件夹不需要 body

		const res = await this.safeRequestUrl(req, conflictAction === 'stop' ? 1 : 3);
		if (res.status >= 400) {
			const json = res.json as ApiResponse | null;
			const errText = (json && json.error ? `API Error Code: ${json.error.code}` : res.text) || `HTTP ${res.status}`;
			throw new Error(`HTTP ${res.status}: ${errText}`);
		}
		
		const json = res.json as ApiResponse | null;
		if (json && json.success === false) {
			const code = json.error?.code || 'Unknown';
			throw new Error(`API Error Code: ${code}`);
		}
		
		if (json?.success !== true) throw new Error(t('safety.invalidResponse'));
		return res.json;
	}

	/**
	 * 递归确保远程目录存在
	 */
	async ensureRemoteFolder(path: string): Promise<void> {
		const parts = path.split('/').filter(p => p);
		let current = '';
		for (let i = 0; i < parts.length; i++) {
			current += '/' + parts[i];
			if (current === '/mydrive' || current === '/team-folders' || (parts[0] === 'team-folders' && i === 1)) {
				continue;
			}
			try {
				await this.createFolder(current);
			} catch {
				// Ignore errors, if it truly fails, the subsequent upload will fail anyway
			}
		}
	}

	/**
	 * 创建或覆盖文件 (通过 multipart/form-data 上传，支持大文件)
	 */
	async uploadFile(path: string, buffer: ArrayBuffer, isRetry: boolean = false): Promise<unknown> {
		this.debugLog('uploadFile', { path, size: buffer.byteLength, isRetry });
		const endpoint = '/api/SynologyDrive/default/v2/files/upload';
		const url = new URL(this.baseUrl + endpoint);
		
		if (this.sid) url.searchParams.append('_sid', this.sid);

		const boundary = '----WebKitFormBoundarySynoSync' + Math.random().toString(36).substring(2);
		const encoder = new TextEncoder();
		const parts: Uint8Array[] = [];

		const appendField = (name: string, value: string) => {
			parts.push(encoder.encode(`--${boundary}\r\n`));
			parts.push(encoder.encode(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
			parts.push(encoder.encode(`${value}\r\n`));
		};

		appendField('type', 'file');
		appendField('path', path);
		appendField('conflict_action', 'overwrite');

		parts.push(encoder.encode(`--${boundary}\r\n`));
		const filename = path.split('/').pop() || 'upload.bin';
		parts.push(encoder.encode(`Content-Disposition: form-data; name="file"; filename="${encodeURIComponent(filename)}"\r\n`));
		parts.push(encoder.encode(`Content-Type: application/octet-stream\r\n\r\n`));
		parts.push(new Uint8Array(buffer));
		parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));

		const totalLength = parts.reduce((acc, part) => acc + part.length, 0);
		const body = new Uint8Array(totalLength);
		let offset = 0;
		for (const part of parts) {
			body.set(part, offset);
			offset += part.length;
		}

		let req: RequestUrlParam = {
			url: url.toString(),
			method: 'PUT',
			headers: {
				'Accept': 'application/json',
				'Content-Type': `multipart/form-data; boundary=${boundary}`
			},
			throw: false,
			body: body.buffer
		};
		if (this.sid) req.headers!['Cookie'] = `id=${this.sid};`;

		const res = await this.safeRequestUrl(req);
		this.debugLog('uploadFile response', { status: res.status, success: (res.json as ApiResponse | null)?.success, errorCode: (res.json as ApiResponse | null)?.error?.code });
		if (res.status >= 400) {
			const json = res.json as ApiResponse | null;
			const errText = (json && json.error ? `API Error Code: ${json.error.code}` : res.text) || `HTTP ${res.status}`;
			throw new Error(`HTTP ${res.status}: ${errText}`);
		}
		
		const json = res.json as ApiResponse | null;
		if (json && json.success === false) {
			const code = json.error?.code;
			if (code === 1000 && !isRetry) {
				const parentPath = path.substring(0, path.lastIndexOf('/'));
				if (parentPath && parentPath !== '/mydrive' && parentPath !== '') {
					await this.ensureRemoteFolder(parentPath);
					return this.uploadFile(path, buffer, true);
				}
			}
			throw new Error(`API Error Code: ${code || 'Unknown'} (File: ${path})`);
		}
		
		if (json?.success !== true) throw new Error(t('safety.invalidResponse'));
		return res.json;
	}

	/**
	 * 下载文件
	 * 单个文件下载返回的应该是文件的 buffer (Content-Type 为对应的 mime)
	 */
	async downloadFile(path: string): Promise<ArrayBuffer> {
		this.debugLog('downloadFile', { path });
		const endpoint = '/api/SynologyDrive/default/v2/files/download';
		const url = new URL(this.baseUrl + endpoint);
		if (this.sid) {
			url.searchParams.append('_sid', this.sid);
		}

		let req: RequestUrlParam = {
			url: url.toString(),
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			throw: false,
			body: JSON.stringify({ files: [path] })
		};
		if (this.sid) req.headers!['Cookie'] = `id=${this.sid};`;

		const res = await this.safeRequestUrl(req);
		this.debugLog('downloadFile response', { status: res.status, hasDisposition: !!(res.headers?.['content-disposition']), bodyLen: res.arrayBuffer?.byteLength });
		if (res.status >= 400) {
			const json = res.json as ApiResponse | null;
			const errText = (json && json.error ? `API Error Code: ${json.error.code}` : res.text) || `HTTP ${res.status}`;
			throw new Error(`HTTP ${res.status}: ${errText}`);
		}

		// 如果没有 content-disposition 且返回了 JSON 失败响应，说明下载出错（如文件不存在等）
		const json = res.json as ApiResponse | null;
		const disposition = res.headers?.['content-disposition'] || '';
		if (!disposition && json && json.success === false) {
			const code = json.error?.code || 'Unknown';
			throw new Error(`API Error Code: ${code}`);
		}

		return res.arrayBuffer;
	}

	/**
	 * 删除文件或目录
	 */
	async deleteFile(path: string): Promise<unknown> {
		const endpoint = '/api/SynologyDrive/default/v2/files/delete';
		const res = await this.request(endpoint, { files: [path], permanent: false }, 'POST', 'application/json');
		return res.json;
	}

	/**
	 * 搜索自 start_date (Unix 时间戳，秒) 以来被修改过的文件或文件夹
	 */
	async search(location: string, fileType: 'file' | 'folder' | 'dir', startDateUnix?: number): Promise<unknown> {
		const endpoint = '/api/SynologyDrive/default/v2/files/search';
		
		let allFiles: unknown[] = [];
		let offset = 0;
		const limit = 200; // 降低 limit，避免移动端 JSON 截断
		let hasMore = true;
		
		type SearchResponse = {
			success?: boolean;
			data?: {
				items?: unknown[];
				has_more?: boolean;
			}
		};

		let lastResponse: SearchResponse | null = null;

		while (hasMore) {
			const url = new URL(this.baseUrl + endpoint);
			if (this.sid) url.searchParams.append('_sid', this.sid);

			let req: RequestUrlParam = {
				url: url.toString(),
				method: 'POST',
				headers: {
					'Accept': 'application/json',
					'Content-Type': 'application/json'
				},
				throw: false
			};
			if (this.sid) req.headers!['Cookie'] = `id=${this.sid};`;
			
			const body: Record<string, unknown> = {
				location: location,
				file_type: fileType,
				limit: limit,
				offset: offset
			};
			if (startDateUnix) {
				body.start_date = startDateUnix;
				body.time = 'modified_time';
			}
			req.body = JSON.stringify(body);

			const res = await this.safeRequestUrl(req);
			if (res.status >= 400) {
				const json = res.json as ApiResponse | null;
				const errText = (json && json.error ? `API Error Code: ${json.error.code}` : res.text) || `HTTP ${res.status}`;
				throw new Error(`HTTP ${res.status}: ${errText}`);
			}
			
			const json = res.json as SearchResponse | null;
			if (json && json.success === false) {
				const apiRes = json as ApiResponse;
				const code = apiRes.error?.code || 'Unknown';
				throw new Error(`API Error Code: ${code} - ${apiRes.error?.errors?.message || 'search failed'}`);
			}
			
			if (json?.success !== true || !json.data || !Array.isArray(json.data.items)) throw new Error(t('safety.invalidResponse'));
			if (json.data.items.some(item => !item || typeof item !== 'object' || !('name' in item) || typeof item.name !== 'string')) throw new Error(t('safety.invalidResponse'));
			lastResponse = json;
			
			if (json?.data?.items && Array.isArray(json.data.items)) {
				allFiles = allFiles.concat(json.data.items);
			}

			// 如果服务端指示有下一页，或者刚好返回满 limit 的元素，就可以继续往下翻页
			if (json?.data?.has_more === true || (json?.data?.items && json.data.items.length === limit)) {
				offset += limit;
			} else {
				hasMore = false;
			}
		}

		if (lastResponse && lastResponse.data) {
			lastResponse.data.items = allFiles;
		}
		return lastResponse || { data: { items: [] } };
	}

}
