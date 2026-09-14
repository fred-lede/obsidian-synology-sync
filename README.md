# Obsidian Synology Sync

[![Release](https://github.com/my3rs/obsidian-synology-sync/actions/workflows/release.yml/badge.svg)](https://github.com/my3rs/obsidian-synology-sync/actions/workflows/release.yml)

[中文](README-zh.md)

> **Disclaimer**: This plugin is an independent community project and is not affiliated with, funded, or endorsed by Synology Inc.

Sync your Obsidian vault with your Synology NAS via the **Official Synology Drive API**. This plugin provides a secure and reliable way to backup and synchronize your Obsidian notes directly to your Synology Drive without relying on any third-party cloud services.

### Features

- Direct synchronization leveraging the **Official Synology WebAPI** for maximum security and native compatibility.
- Support for two-way sync, upload only, and download only modes.
- Secure connection using your Synology credentials (your credentials communicate directly with your NAS; no third-party servers are involved).
- Multi-language support (English and Chinese).

### Configuration

1. Go to the "Synology Sync" settings tab.
2. Enter your Synology NAS URL (e.g., `https://your-nas-ip:5001`).
3. Enter your Synology username and password.
4. Test the connection and start syncing!

See the [sync and recovery guide](docs/sync-guide.md) for usage details, or the [development guide](docs/development.md) to build and test the plugin.

### Disclaimer

**Important Notice & Trademark Disclaimer**:

- **Disclaimer**: This plugin is an independent community project and is not affiliated with, funded, or endorsed by Synology Inc. Synology, Synology Drive, and other Synology product names/logos are trademarks or registered trademarks of Synology Inc.
- This plugin is an open-source, third-party tool designed to synchronize Obsidian notes with your Synology NAS via the Synology WebAPI. By using this plugin, you acknowledge and agree to the following:

1. **Safety First**: While reasonable efforts have been made to ensure the reliability and security of this plugin, unexpected bugs, environmental differences, network fluctuations, or improper NAS configurations may result in synchronization errors, file corruption, or permanent data loss. **We strongly recommend that you make complete backups of your vault** (for example, using local copies or Synology Hyper Backup) before using this plugin, especially when running synchronization tasks.
2. **No Warranty**: The software is provided "AS IS", without warranty of any kind, express or implied. In no event shall the authors or copyright holders be liable for any claim, damages, or other liability, whether in an action of contract, tort, or otherwise, arising from, out of, or in connection with the software or the use or other dealings in the software.
3. **Data Privacy**: Your Synology account credentials and plugin configurations are saved securely on your local device only. This plugin communicates directly with your self-hosted NAS, and no data is ever transmitted to or stored on any third-party servers.

By installing or using this plugin, you acknowledge that you have read, understood, and accepted this disclaimer.
