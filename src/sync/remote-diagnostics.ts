import { SynologyClient } from '../api/client';
import { t } from '../locales';
import { ensureSyncFolder } from './remote-folders';

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

/** Sync-specific folder safety and context, using the existing API request implementations. */
export function withRemoteDiagnostics(client: SynologyClient): SynologyClient {
    return new Proxy(client, {
        get(target, property, receiver): unknown {
            switch (property) {
                case 'createFolder': return (path: string, action: 'overwrite' | 'stop' = 'overwrite') =>
                    run(action === 'stop' ? 'createLock' : 'createFolder', path, () => target.createFolder(path, action));
                case 'ensureRemoteFolder': return (path: string) => run('prepareFolder', path, () => ensureSyncFolder(target, path));
                case 'uploadFile': return (path: string, buffer: ArrayBuffer) => run('upload', path, async () => {
                    await ensureSyncFolder(target, path.slice(0, path.lastIndexOf('/')));
                    // Parents are ready. Suppress the legacy code-1000 fallback which recreates
                    // all ancestors with overwrite, including the root holding our lock.
                    return target.uploadFile(path, buffer, true);
                });
                case 'downloadFile': return (path: string) => run('download', path, () => target.downloadFile(path));
                case 'deleteFile': return (path: string) => run('delete', path, () => target.deleteFile(path));
                case 'listFiles': return (path: string) => run('list', path, () => target.listFiles(path));
                default: return Reflect.get(target, property, receiver) as unknown;
            }
        }
    });
}
