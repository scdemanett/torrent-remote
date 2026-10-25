// Torrent Remote - remote GUI for transmission torrent daemon
// Copyright (C) 2023  qu1ck (mail at qu1ck.org)
// Copyright (C) 2026  Steven Demanett
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;
#[cfg(target_os = "windows")]
use winreg::RegKey;

#[cfg(target_os = "windows")]
const APP_NAME: &str = "TorrentRemote";

#[cfg(target_os = "windows")]
fn register_app_class() -> std::io::Result<()> {
    match std::env::current_exe() {
        Ok(exe) => {
            let exe = exe.to_str().unwrap_or_default();
            let hkcu = RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
            let (key, _) =
                hkcu.create_subkey(format!("SOFTWARE\\Classes\\{APP_NAME}\\DefaultIcon"))?;
            let icon = format!("\"{exe}\",0");
            key.set_value("", &icon)?;

            let (key, _) = hkcu.create_subkey(format!(
                "SOFTWARE\\Classes\\{APP_NAME}\\shell\\open\\command"
            ))?;
            let icon = format!("\"{exe}\" \"%1\"");
            key.set_value("", &icon)?;
        }
        Err(e) => log::error!("Error getting exe path: {e}"),
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn register_torrent_class() -> std::io::Result<()> {
    let hkcu = RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    let (key, _) = hkcu.create_subkey("SOFTWARE\\Classes\\.torrent")?;
    key.set_value("", &APP_NAME)?;

    Ok(())
}

#[cfg(target_os = "windows")]
fn register_magnet_class() -> std::io::Result<()> {
    match std::env::current_exe() {
        Ok(exe) => {
            let exe = exe.to_str().unwrap_or_default();
            let hkcu = RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
            let (key, _) = hkcu.create_subkey("SOFTWARE\\Classes\\Magnet")?;
            key.set_value("", &"URL:Magnet URI")?;
            key.set_value("Content Type", &"application/x-magnet")?;
            key.set_value("URL Protocol", &"")?;

            let (key, _) = hkcu.create_subkey("SOFTWARE\\Classes\\Magnet\\DefaultIcon")?;
            let icon = format!("\"{exe}\",0");
            key.set_value("", &icon)?;

            let (key, _) = hkcu.create_subkey("SOFTWARE\\Classes\\Magnet\\shell")?;
            key.set_value("", &"open")?;

            let (key, _) = hkcu.create_subkey("SOFTWARE\\Classes\\Magnet\\shell\\open\\command")?;
            let icon = format!("\"{exe}\" \"%1\"");
            key.set_value("", &icon)?;
        }
        Err(e) => log::error!("Error getting exe path: {e}"),
    }
    Ok(())
}

/// Windows run key value name used by versions before tauri-plugin-autostart.
#[cfg(target_os = "windows")]
const LEGACY_RUN_KEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run";

/// Brings an existing autostart entry up to date:
/// - earlier versions wrote their own value to the Run key, move it over to
///   the plugin's entry once, so the app is not launched twice at logon
/// - entries written before autostart passed `--start-minimized` open the
///   window at logon, rewrite them so the app starts in the tray
pub fn migrate_autostart(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let Ok(key) = hkcu.open_subkey_with_flags(LEGACY_RUN_KEY, KEY_READ | KEY_WRITE) else {
            return;
        };
        if key.get_value::<String, &str>(APP_NAME).is_ok() {
            log::info!("Moving the legacy autostart entry to tauri-plugin-autostart");
            if let Err(e) = key.delete_value(APP_NAME) {
                log::error!("Error removing legacy autostart entry: {e}");
                return;
            }
            set_autostart(app, true);
            return;
        }
        // Only rewrite the Run key when needed, not on every launch.
        let outdated = key
            .get_value::<String, &str>(&app.package_info().name)
            .is_ok_and(|command| !command.contains(crate::START_MINIMIZED_ARG));
        if outdated && app.autolaunch().is_enabled().unwrap_or(false) {
            log::info!(
                "Adding {} to the autostart entry",
                crate::START_MINIMIZED_ARG
            );
            set_autostart(app, true);
        }
    }
    // The LaunchAgent plist and the .desktop entry are plain files, rewriting
    // them is cheap and keeps the arguments current.
    #[cfg(not(target_os = "windows"))]
    if app.autolaunch().is_enabled().unwrap_or(false) {
        set_autostart(app, true);
    }
}

fn set_autostart(app: &AppHandle, enable: bool) -> bool {
    let result = if enable {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    };
    match result {
        Ok(()) => true,
        Err(e) => {
            log::error!("Error changing autostart: {e}");
            false
        }
    }
}

pub fn app_integration_impl(app: &AppHandle, mode: &str) -> bool {
    match mode {
        "autostart" => {
            log::info!("Adding app to auto start");
            set_autostart(app, true)
        }
        "noautostart" => {
            log::info!("Removing app from auto start");
            set_autostart(app, false)
        }
        "getautostart" => app.autolaunch().is_enabled().unwrap_or_else(|e| {
            log::warn!("Error checking autostart: {e}");
            false
        }),
        _ => windows_integration(mode),
    }
}

#[cfg(target_os = "windows")]
fn windows_integration(mode: &str) -> bool {
    match mode {
        "torrent" => {
            log::info!("Associating .torrent files with the app");
            if let Err(e) = register_app_class() {
                log::error!("Error writing to registry: {e}");
            }
            if let Err(e) = register_torrent_class() {
                log::error!("Error writing to registry: {e}");
            }
        }
        "magnet" => {
            log::info!("Associating magnet links with the app");
            if let Err(e) = register_app_class() {
                log::error!("Error writing to registry: {e}");
            }
            if let Err(e) = register_magnet_class() {
                log::error!("Error writing to registry: {e}");
            }
        }
        _ => {
            log::warn!("Bad app_integration call: {mode}");
        }
    }
    false
}

#[cfg(not(target_os = "windows"))]
fn windows_integration(mode: &str) -> bool {
    log::warn!("Bad app_integration call: {mode}");
    false
}
