export function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function validPath(path: string): boolean {
    return path.length > 0 && !path.includes('\\') && !path.split('/').some(part =>
        !part || part === '.' || part === '..' || part.startsWith('.') || part === '__proto__' || part === 'constructor' || part === 'prototype');
}

export function isHash(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
