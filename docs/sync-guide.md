# Sync behavior and recovery

[中文](sync-guide-zh.md) · [Project overview](../README.md)

## Sync safety and upgrading

Update **all devices together** and stop old plugin instances before using this version. The locking protocol has changed; mixed versions and another program modifying the same NAS folder are not coordinated writers.

- New devices and copied plugin snapshots cannot propagate deletions merely because local files are missing. A local delete/rename is propagated only if this running plugin previously observed the file during a successful sync. Deletions made while the plugin was off are recovered from the NAS; this intentionally favors keeping data.
- A batch of at least 10 remote deletions, or more than one deletion affecting at least 20% of the snapshot, stops before file changes. Restore the removed files, then review smaller deliberate deletions. There is no automatic bypass.
- Force upload/download overwrites matching paths while preserving different content. It **does not mirror-delete files existing only on the other side**. Rebuild compares actual content and rebuilds local snapshots, preserving differences.
- Edit/edit conflicts preserve the remote version under a content-hash-based name before publishing the local version. Delete/edit conflicts retain the live edit. Unknown local content against an existing deletion is preserved as a separate conflict file rather than silently reviving the original.
- Quick sync uses the manifest, verifies bytes before replacing remote files, and hashes local content even when timestamps do not change. Full sync also discovers and hashes remote files created or edited outside the plugin. A missing remote file without a deletion record is not treated as permission to delete local data; a requested download will fail instead.
- Files above 50 MB stop the sync with an error instead of silently disappearing from a deletion plan. Hidden/configuration paths remain excluded. Tombstones are retained for offline peers.

## Interrupted sync and lock recovery

The NAS `.sync_lock` is now an exclusive directory created with `conflict_action=stop`. It has no automatic expiration: a suspended device must never lose its lock to a second writer that it can later overwrite. The directory is removed after an ordinary completion or handled error. Acquisition failures may leave it in place when the server result is uncertain.

If a crash leaves a lock:

1. Stop the plugin on **every device**, including suspended/mobile devices. Do not clear a lock while any operation may still be running.
2. Preserve the remote `.sync_manifest.json`, `.sync_pending.json`, `.sync_pending_data`, and device `sync_data.json` for diagnosis. Do not delete the pending files.
3. Remove only the stale `.sync_lock` file/directory in the NAS sync folder.
4. Start one updated device. It replays the pending operation before planning another sync. After that device succeeds, resume the other updated devices.

The pending files contain the current operation's target path, manifest and staged file bytes; they stay on your NAS. The last staged payload is retained and overwritten by a later upload. If the journal/payload is corrupted, recovery stops rather than guessing; restore consistent metadata and data from backup before continuing.
