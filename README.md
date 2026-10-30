# Torrent Remote
**A Transmission remote client for Windows, macOS and Linux, and a web UI for the Transmission daemon**

[![Latest release](https://img.shields.io/github/v/release/scdemanett/torrent-remote?label=Release)](https://github.com/scdemanett/torrent-remote/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/scdemanett/torrent-remote/total?label=Downloads)](https://github.com/scdemanett/torrent-remote/releases)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Web-blue)
[![License](https://img.shields.io/github/license/scdemanett/torrent-remote?label=License)](LICENSE.txt)
![Lint status](https://img.shields.io/github/actions/workflow/status/scdemanett/torrent-remote/lint.yml?label=Lint&event=push)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/logo/mark-on-dark.svg">
  <img src="docs/logo/mark-on-light.svg" alt="Torrent Remote logo" width="160">
</picture>

Torrent Remote is a desktop and web GUI for remotely controlling the
[Transmission](https://transmissionbt.com/) BitTorrent daemon. Run it as a native app on
Windows, macOS or Linux, or let Transmission serve it in place of the built-in web interface
by pointing `$TRANSMISSION_WEB_HOME` at the Torrent Remote web assets.

It is a fork of [TrguiNG](https://github.com/openscopeproject/TrguiNG) by qu1ck, itself a
[tauri](https://tauri.app) rewrite of [transgui](https://github.com/transmission-remote-gui/transgui)
(Transmission Remote GUI). The frontend is TypeScript with [react.js](https://react.dev/) and
[shadcn/ui](https://ui.shadcn.com/) components on [Tailwind CSS](https://tailwindcss.com/);
the backend is [rust](https://www.rust-lang.org/).

Some differentiating features:

* Multi tabbed interface for concurrent server connections (native app only)
* Torrent creation with fast multi threaded hashing (native app only)
* Powerful torrent filtering options
* Latest transmission features support: labels, bandwidth groups, sequential download
* Notifications and a sound when a download completes, a tray icon and in-app updates
  (native app only)
* Light and dark themes, or follow the system setting

Transmission v2.40 or later is required.

## Coming from TrguiNG or transgui

Torrent Remote is a drop-in replacement for TrguiNG. Your TrguiNG settings file
(`trguing.json` in your OS config folder) is imported automatically the first time Torrent
Remote starts, so servers, filters and interface settings carry over. The two modes are the
same too: a native app, or a web interface served by Transmission. What changed is the
interface, rebuilt on shadcn/ui and Tailwind CSS, and the ongoing maintenance.

transgui users get the same remote-control feature set with a current UI toolkit, native
Apple silicon and Windows ARM builds, and signed Windows installers.

## Screenshots

### Main window

![Main window with the status, directory and label filters, the torrent list and the details panel](docs/screenshots/main.webp)

### Settings

<p>
  <img src="docs/screenshots/settings-integrations.webp" alt="Settings, Integrations tab: notifications, sound, updates, startup, file associations and tray behavior" width="49%">
  <img src="docs/screenshots/settings-interface.webp" alt="Settings, Interface tab: theme, font, colors, progress bars and date format" width="49%">
</p>

### Create torrent

<img src="docs/screenshots/create-torrent.webp" alt="Create torrent window with file selection, piece size, comment, source, private flag, trackers and web seeds" width="415">

## Install

Releases are published on the
[releases page](https://github.com/scdemanett/torrent-remote/releases):

* Windows: `x64-setup.exe` or `arm64-setup.exe` installer, or the `.msi`
* Linux: `.AppImage`, `.deb` or `.rpm`
* macOS: `aarch64.app.tar.gz` for Apple silicon, `x86_64.app.tar.gz` for Intel
* Web interface: `torrent-remote-web-<version>.zip`, see below

Installs from the Windows `setup.exe`, the AppImage and the macOS app update themselves. For
the other packages, download the new version from the releases page.

Maintainers can also run the
[build workflow](https://github.com/scdemanett/torrent-remote/actions/workflows/build.yml)
by hand to build the current development version. Open the latest successful run and scroll
down to the artifacts section.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to report bugs, the branch and pull request
workflow, and the checks CI runs.

## Compiling

Prerequisites:
- [Node.js 22](https://nodejs.org/) or later
- [rust 1.92](https://www.rust-lang.org/) or later
- Geoip lookup database in mmdb format, put it in `src-tauri`
   ```
   wget -nv -O src-tauri/dbip.mmdb "https://github.com/scdemanett/torrent-remote/releases/latest/download/dbip.mmdb"
   ```
   You can get latest db from [db-ip.com](https://db-ip.com/db/download/ip-to-country-lite),
   which is what `ci/fetch_latest_dbip.sh` does for release builds.

To compile simply run

```
$ npm install
$ npm run build
```

This will generate optimized bundle in `dist` and a release binary in `src-tauri/target/release` folder.
Also installer package will be available in `src-tauri/target/release/bundle/...`.

The binary is statically linked and embeds all necessary assets except for the geoip database.
It is completely self sufficient and can be used as a portable executable, but peer country lookup
needs `dbip.mmdb` in the app's resource folder, which the installers set up (next to the exe on
Windows).

For development run

```
$ npm run tauri-dev
```

It starts the webpack dev server on port 8787 first. Webpack will automatically watch changes in
`src/` and refresh the app view, tauri will watch changes in `src-tauri/` and rebuild/restart the
app as needed.

## Releasing

The steps for tagging a release are in [CONTRIBUTING.md](CONTRIBUTING.md#releases).

Tagged releases (`v*`) are built by `.github/workflows/build.yml`, which signs the updater
bundles with a minisign key and publishes `latest.json` for the in-app updater. The public key is
in `src-tauri/tauri.conf.json`; the private key lives in the gitignored `.tauri/torrent-remote.key`
and its password in 1Password. GitHub Actions needs the repository secrets
`TAURI_SIGNING_PRIVATE_KEY` (the key file contents) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

For a local release build, load both into the shell first:

```powershell
. .\scripts\signing-key.ps1; Initialize-SigningKey -WorkspaceRoot (Get-Location)
npm run build
```

### Code signing

Windows builds are Authenticode-signed through Azure Artifact Signing (account `scdemanett-signing`,
certificate profile `scdemanett-public-trust`, named in `src-tauri/artifact-signing.json`). The
overlay `src-tauri/tauri.signed.conf.json` sets `bundle.windows.signCommand` to the Windows SDK's
signtool with Microsoft's Artifact Signing dlib, and Tauri runs it on the app exe, the NSIS
installer and uninstaller, and the MSI, before the updater signatures are made. The workflow
logs in with `azure/login` through OIDC (no client secret): the Entra app registration
`github-artifact-signing` holds the Artifact Signing Certificate Profile Signer role on the account
and a federated credential for this repository's `release` environment, which the Windows build
jobs run in. Its IDs are the repository variables `AZURE_TENANT_ID` and `AZURE_CLIENT_ID`; without
them (forks) the overlay is skipped and builds stay unsigned.

## How to use Torrent Remote as a web interface

Transmission supports custom web interfaces, all you have to do is run the daemon with
`$TRANSMISSION_WEB_HOME` variable pointing to the web assets that transmission will serve
over its `.../transmission/web/` endpoint.

Example steps for debian:
1. Download the latest `torrent-remote-web-<version>.zip` from the
   [releases](https://github.com/scdemanett/torrent-remote/releases) page.
2. Unpack it anywhere, make sure that the user transmission runs under (by default `debian-transmission`)
   has read permissions.
3. Add an override for the transmission daemon service with
   `sudo systemctl edit transmission-daemon` and put this in it:
   ```
   [Service]
   Environment=TRANSMISSION_WEB_HOME=/path/to/extracted/torrent-remote/zip
   ```
   An override survives package upgrades, unlike edits to the unit file itself.
4. Restart the service with `sudo systemctl restart transmission-daemon`

## License
Project is distributed under GNU Affero General Public License v3, see `LICENSE.txt` for details.

Copyright (C) 2023 qu1ck (original TrguiNG author), Copyright (C) 2026 Steven Demanett.
