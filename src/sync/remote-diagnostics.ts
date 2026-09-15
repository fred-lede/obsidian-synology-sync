import { SynologyClient } from '../api/client';
import { t } from '../locales';

type Operation = 'createFolder' | 'createLock' | 'prepareFolder' | 'upload' | 'download' | 'delete' | 'list';

export class SyncOperationError extends Error {
    constructor(readonly operation: Operation, readonly path: string, readonly originalError: unknown) {
        const detail = originalError instanceof Error ? originalError.message : String(originalError);
        // The legacy client can repeat the HTTP status when the response body is the same status.
        const message = detail.replace(/\bHTTP\s*[:：]?\s*(\d{3})\s*[:：]?\s*HTTP\s*[:：]?\s*\1\b/gi, 'HTTP $1');
        super(t('sync.operationFailed', { operation: t(`sync.operation.${operation}`), path, error: message }));
        this.name = 'SyncOperationError';
    }
}

async function run<T>(operation: Operation, path: string, task: () => Promise<T>): Promise<T> {
    try { return await task(); }
    catch (error) {
        if (error instanceof SyncOperationError) throw error;
        throw new SyncOperationError(operation, path, error);
    }
}

/** Adds context at the sync boundary. Requests, retries and API responses remain unchanged. */
export function withRemoteDiagnostics(client: SynologyClient): SynologyClient {
    return new Proxy(client, {
        get(target, property, receiver): unknown {
            switch (property) {
                case 'createFolder': return (path: string, action: 'overwrite' | 'stop' = 'overwrite') =>
                    run(action === 'stop' ? 'createLock' : 'createFolder', path, () => target.createFolder(path, action));
                case 'ensureRemoteFolder': return (path: string) => run('prepareFolder', path, () => target.ensureRemoteFolder(path));
                case 'uploadFile': return (path: string, buffer: ArrayBuffer, retry = false) => run('upload', path, () => target.uploadFile(path, buffer, retry));
                case 'downloadFile': return (path: string) => run('download', path, () => target.downloadFile(path));
                case 'deleteFile': return (path: string) => run('delete', path, () => target.deleteFile(path));
                case 'listFiles': return (path: string) => run('list', path, () => target.listFiles(path));
                default: return Reflect.get(target, property, receiver) as unknown;
            }
        }
    });
}
