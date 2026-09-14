import { LocalFileEntry } from './state';
import { ManifestEntry } from './manifest';

export interface LocalFileInfo {
    hash: string;
    mtime: number;
}

export interface SyncPlan {
    uploads: Set<string>;
    downloads: Set<string>;
    deletionsLocal: Set<string>;
    deletionsRemote: Set<string>;
    conflicts: Set<string>;
    snapshotClears: Set<string>;
    snapshotUpdates: Map<string, LocalFileEntry>;
}

export function computeSyncPlan(
    localFiles: Map<string, LocalFileInfo>,
    snapshots: Map<string, LocalFileEntry>,
    manifests: Map<string, ManifestEntry>,
    confirmedDeletions: ReadonlySet<string> = new Set()
): SyncPlan {
    const plan: SyncPlan = {
        uploads: new Set(),
        downloads: new Set(),
        deletionsLocal: new Set(),
        deletionsRemote: new Set(),
        conflicts: new Set(),
        snapshotClears: new Set(),
        snapshotUpdates: new Map()
    };

    const allPaths = new Set([
        ...localFiles.keys(),
        ...snapshots.keys(),
        ...manifests.keys()
    ]);

    for (const path of allPaths) {
        const local = localFiles.get(path);
        const snapshot = snapshots.get(path);
        const manifest = manifests.get(path);

        const localExists = !!local;
        const snapshotExists = !!snapshot;
        const manifestExists = !!manifest && !manifest.deleted;

        // Boolean derived states
        const localChanged = localExists && snapshotExists && local.hash !== snapshot.localHash;
        const remoteChanged = manifestExists && snapshotExists && manifest.rev !== snapshot.syncedRev;

        const localDeleted = !localExists && snapshotExists;
        const remoteDeleted = snapshotExists && manifest && manifest.deleted === true && manifest.rev > snapshot.syncedRev;

        // An absence is not evidence of deletion on a copied, offline or partially loaded vault.
        if (localDeleted && manifestExists && !confirmedDeletions.has(path)) {
            plan.downloads.add(path);
            continue;
        }
        if (localDeleted && (!manifest || manifest.deleted)) {
            plan.snapshotClears.add(path);
            continue;
        }
        if (manifest?.deleted && local && !snapshot) {
            // Unknown local content must be preserved and explicitly resolved.
            plan.conflicts.add(path);
            continue;
        }

        if (localExists && snapshotExists && !manifest) {
            plan.uploads.add(path);
            continue;
        }

        // 1. localExists && !snapshotExists && !manifestExists -> Upload
        if (localExists && !snapshotExists && !manifestExists) {
            plan.uploads.add(path);
            continue;
        }

        // 2. !localExists && !snapshotExists && manifestExists -> Download
        if (!localExists && !snapshotExists && manifestExists) {
            plan.downloads.add(path);
            continue;
        }

        // 3. localExists && !snapshotExists && manifestExists -> First encounter
        if (localExists && !snapshotExists && manifestExists) {
            if (local.hash === manifest.hash) {
                // Same content, just record snapshot
                plan.snapshotUpdates.set(path, {
                    localMtime: local.mtime,
                    localHash: local.hash,
                    syncedRev: manifest.rev,
                    syncedHash: manifest.hash
                });
            } else {
                plan.conflicts.add(path);
            }
            continue;
        }

        // 4. localChanged && !remoteChanged && !remoteDeleted -> Upload
        if (localChanged && !remoteChanged && !remoteDeleted) {
            plan.uploads.add(path);
            continue;
        }

        // 5. !localChanged && remoteChanged && !localDeleted -> Download
        if (!localChanged && remoteChanged && !localDeleted) {
            plan.downloads.add(path);
            continue;
        }

        // 6. localChanged && remoteChanged -> Conflict or coincidental match
        if (localChanged && remoteChanged) {
            if (local.hash === manifest.hash) {
                // Coincidental match
                plan.snapshotUpdates.set(path, {
                    localMtime: local.mtime,
                    localHash: local.hash,
                    syncedRev: manifest.rev,
                    syncedHash: manifest.hash
                });
            } else {
                plan.conflicts.add(path);
            }
            continue;
        }

        // 7. localDeleted && !remoteChanged && !remoteDeleted -> Delete remote
        if (localDeleted && !remoteChanged && !remoteDeleted) {
            plan.deletionsRemote.add(path);
            continue;
        }

        // 8. !localChanged && remoteDeleted -> Delete local
        if (!localChanged && remoteDeleted && !localDeleted) {
            plan.deletionsLocal.add(path);
            continue;
        }

        // 9. localDeleted && remoteChanged -> Conflict (recover remote)
        if (localDeleted && remoteChanged) {
            plan.downloads.add(path);
            continue;
        }

        // 10. localChanged && remoteDeleted -> Conflict (recover local)
        if (localChanged && remoteDeleted) {
            plan.uploads.add(path);
            continue;
        }

        // 11. localDeleted && remoteDeleted -> Clear snapshot
        if (localDeleted && remoteDeleted) {
            plan.snapshotClears.add(path);
            continue;
        }

        // Edge case: if it exists in snapshot, but deleted in BOTH local (or never existed locally) and manifest (no record, or tombstone)
        if (!localExists && (!manifest || manifest.deleted)) {
            plan.snapshotClears.add(path);
        }
    }

    return plan;
}
