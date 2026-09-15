import { t } from '../locales';

/** Synology Drive v2 ID-system paths; never prepend /mydrive to an explicit root. */
export function normalizeRemoteFolder(value: string): string {
    const path = value.trim().replace(/\/+/g, '/').replace(/\/$/, '');
    if (/^(?:id:|link:)/.test(path)) return path;
    if (/^\/(?:mydrive|team-folders|views|volumes)(?:\/|$)/.test(path)) return path;
    return `/mydrive${path.startsWith('/') ? '' : '/'}${path}`.replace(/\/$/, '');
}

export function remoteFilePath(folder: string, relative: string): string {
    const path = normalizeRemoteFolder(folder);
    // The documented link form is a single reference, not link:token/child.
    if (/^(?:id:|link:)/.test(path)) throw new Error(t('safety.invalidResponse'));
    return `${path}/${relative}`;
}
