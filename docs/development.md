# Development and validation

[中文](development-zh.md) · [Project overview](../README.md)

Run `npm test`, `npm run build`, and `npm run lint`. The automated suite runs the actual planner, engine, transaction manager and API client with isolated filesystem/network doubles. It covers copied state, concurrent lock acquisition, conflicts, repeated syncs, failed deletion/commit/save, pagination and HTTP 200 business errors.

Before a release, validate exclusive creation and indexing visibility against a real Synology NAS, then run two desktop devices and a mobile device through sleep/resume and crash recovery in a disposable vault. Those integration checks cannot be replaced by the simulator and must be recorded separately for each release.

Text replacements use Obsidian's [atomic `Vault.process()` API](https://docs.obsidian.md/Plugins/Vault) to reject edits made immediately before replacement. Binary attachment replacement has pre-write checks but no equivalent atomic compare-and-replace API; simultaneous external editing of attachments remains a real-device validation limitation.
