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

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::{
    sync::{atomic::AtomicBool, atomic::Ordering, Arc},
    time::Duration,
};

use createtorrent::CreationRequestsHandle;
use geoip::MmdbReaderHandle;
use poller::PollerHandle;
use tauri::{async_runtime, App, AppHandle, Listener, Manager, State};
use tauri_plugin_cli::CliExt;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};
use tokio::sync::RwLock;
use torrentcache::TorrentCacheHandle;

mod args;
mod commands;
#[cfg(target_os = "windows")]
mod contextmenu;
mod createtorrent;
mod geoip;
mod integrations;
#[cfg(target_os = "macos")]
mod macos;
mod notification;
mod poller;
mod sound;
mod torrentcache;
mod tray;

struct ArgsHandle(Arc<RwLock<args::StartupArgs>>);

/// Passed by the autostart entry: the app starts in the tray, the main window
/// stays hidden until it is opened from there.
pub const START_MINIMIZED_ARG: &str = "--start-minimized";

/// Set when this launch should keep the main window hidden. The frontend
/// takes it once (take_start_minimized), so a later reload shows the window.
pub struct StartMinimized(pub AtomicBool);

#[cfg(target_os = "macos")]
fn handle_uris(app: &AppHandle, uris: Vec<String>) {
    if uris.is_empty() {
        return;
    }
    let args_state: State<ArgsHandle> = app.state();
    let args_lock = args_state.0.clone();
    let app_handle = app.clone();
    async_runtime::spawn(async move {
        {
            let mut queue = args_lock.write().await;
            if !queue.ready {
                queue.push_pending(uris);
                return;
            }
        }
        args::deliver_args(&app_handle, uris);
    });
}

/// Window state persisted by tauri-plugin-window-state: size, position and
/// maximized state. Visibility is excluded on purpose, otherwise a window
/// hidden to the tray would be restored hidden on the next launch.
pub fn window_state_flags() -> StateFlags {
    StateFlags::all() & !StateFlags::VISIBLE
}

/// Logging through tauri-plugin-log: every build writes torrent-remote.log
/// to the app log directory, dev builds also print to stdout. Third-party
/// crates (tauri, hyper, reqwest, ...) are capped at info, this crate logs
/// debug in dev builds.
fn log_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let own_level = if cfg!(debug_assertions) {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    };
    let builder = tauri_plugin_log::Builder::new()
        .clear_targets()
        .target(Target::new(TargetKind::LogDir {
            file_name: Some("torrent-remote".into()),
        }))
        .level(log::LevelFilter::Info)
        .level_for("torrent_remote", own_level)
        .rotation_strategy(RotationStrategy::KeepOne)
        .max_file_size(1024 * 1024)
        .timezone_strategy(TimezoneStrategy::UseLocal);
    #[cfg(debug_assertions)]
    let builder = builder.target(Target::new(TargetKind::Stdout));
    builder.build()
}

/// Autostart entries launch the app minimized to the tray.
fn autostart_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let builder = tauri_plugin_autostart::Builder::new().arg(START_MINIMIZED_ARG);
    #[cfg(target_os = "macos")]
    let builder = builder.macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent);
    builder.build()
}

fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    log::info!(
        "{} {} starting",
        app.package_info().name,
        app.package_info().version
    );

    let mut torrents: Vec<String> = vec![];
    let start_minimized = match app.cli().matches() {
        Ok(matches) => {
            if matches.args.contains_key("help") {
                println!("{}", matches.args["help"].value.as_str().unwrap());
                app.handle().exit(0);
                return Ok(());
            }
            if matches.args["torrent"].value.is_array() {
                torrents = matches.args["torrent"]
                    .value
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap().to_string())
                    // a notification click that started the app, the
                    // window is shown anyway
                    .filter(|a| !notification::is_activation_url(a))
                    .collect();
            }
            matches
                .args
                .get("start-minimized")
                .is_some_and(|arg| arg.value.as_bool() == Some(true))
        }
        Err(e) => {
            log::error!("Unable to read cli args: {e}");
            app.handle().exit(0);
            return Ok(());
        }
    };

    let app: AppHandle = app.handle().clone();

    integrations::migrate_autostart(&app);
    notification::init(&app);

    // torrents on the command line are shown even then
    let start_minimized = start_minimized && torrents.is_empty();
    if start_minimized {
        log::info!("Starting minimized to the tray");
    }
    app.state::<StartMinimized>()
        .0
        .store(start_minimized, Ordering::Relaxed);

    async_runtime::spawn(async move {
        let poller_state: State<PollerHandle> = app.state();
        let mut poller = poller_state.0.lock().await;
        poller.set_app_handle(&app);

        let args_state: State<ArgsHandle> = app.state();
        let args_lock = args_state.0.clone();

        let mut queue = args_lock.write().await;
        queue.init().await;

        let args_lock1 = args_lock.clone();
        let _ = app.listen("listener-start", move |_| {
            let args_lock = args_lock1.clone();
            async_runtime::spawn(async move {
                args_lock.write().await.start();
            });
        });
        let args_lock2 = args_lock.clone();
        let _ = app.listen("listener-pause", move |_| {
            let args_lock = args_lock2.clone();
            async_runtime::spawn(async move {
                args_lock.write().await.pause().await;
            });
        });
        tray::create_main_window(&app, start_minimized);

        torrents.extend(queue.take_pending());
        drop(queue);

        args::deliver_args(&app, torrents);

        let app_clone = app.clone();
        app.listen("app-exit", move |_| {
            log::info!("Exiting");
            app_clone.exit(0);
        });

        let app_clone = app.clone();
        app.listen("window-hidden", move |_| {
            let _ = app_clone.save_window_state(window_state_flags());
            tray::set_tray_showhide_text(&app_clone, "Show");
        });

        // The frontend shows the window itself when a torrent arrives while
        // it is hidden (file drop, command line), keep the tray menu in sync.
        let app_clone = app.clone();
        app.listen("window-shown", move |_| {
            tray::set_tray_showhide_text(&app_clone, "Hide");
        });
    });

    Ok(())
}

static APP_USER_AGENT: &str = concat!(env!("CARGO_PKG_NAME"), "/", env!("CARGO_PKG_VERSION"));

pub struct HttpClients {
    pub default: reqwest::Client,
    pub insecure: reqwest::Client,
}

fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .user_agent(APP_USER_AGENT)
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(40))
        .timeout(Duration::from_secs(60))
        .http1_only()
        .http1_title_case_headers()
}

fn http_clients() -> HttpClients {
    let default = client_builder()
        .build()
        .expect("Failed to initialize http client");

    let insecure = client_builder()
        .danger_accept_invalid_certs(true)
        .build()
        .expect("Failed to initialize insecure http client");

    HttpClients { default, insecure }
}

fn main() {
    let context = tauri::generate_context!();

    let app_builder = tauri::Builder::default()
        // must be the first plugin. The lock is keyed by the app identifier,
        // so other Tauri apps never collide with it. A second launch exits
        // right away and its arguments arrive here in the running instance.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // an autostart launch while the app already runs leaves it as it is
            if argv.iter().any(|a| a == START_MINIMIZED_ARG) {
                return;
            }
            let args: Vec<String> = argv
                .into_iter()
                .skip(1)
                // a notification click only asks for the main window
                .filter(|a| !a.starts_with('-') && !notification::is_activation_url(a))
                .collect();
            if args.is_empty() {
                match app.get_webview_window("main") {
                    Some(window) if window.is_visible().unwrap_or(false) => {
                        if window.is_minimized().unwrap_or(false) {
                            window.unminimize().ok();
                        }
                        window.set_focus().ok();
                    }
                    window => tray::toggle_main_window(app, window),
                }
            } else {
                args::deliver_args(app, args);
            }
        }))
        .plugin(log_plugin())
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(autostart_plugin())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(window_state_flags())
                // only the main window, the create torrent windows have random labels
                .with_filter(|label| label == "main")
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::remove_file,
            commands::shell_open,
            commands::set_poller_config,
            commands::app_integration,
            commands::get_file_stats,
            commands::create_torrent,
            commands::check_create_torrent,
            commands::cancel_create_torrent,
            commands::save_create_torrent,
            commands::pass_to_window,
            commands::list_system_fonts,
            commands::create_tray,
            commands::set_tray_state,
            commands::save_text_file,
            commands::load_text_file,
            commands::process_torrents,
            commands::lookup_ips,
            commands::take_start_minimized,
        ])
        .manage(ArgsHandle(Arc::new(RwLock::new(args::StartupArgs::new()))))
        .manage(StartMinimized(AtomicBool::new(false)))
        .manage(TorrentCacheHandle::default())
        .manage(PollerHandle::default())
        .manage(MmdbReaderHandle::default())
        .manage(CreationRequestsHandle::default())
        .manage(http_clients())
        .setup(setup);

    #[cfg(target_os = "macos")]
    let app_builder = app_builder
        .menu(macos::make_menu)
        .on_menu_event(|app, event| if event.id().as_ref() == "appquit" {
            tray::exit(app.clone());
        });

    #[cfg(target_os = "windows")]
    let app_builder = app_builder.plugin(contextmenu::init());

    let app = app_builder
        .build(context)
        .expect("error while running tauri application");

    #[allow(clippy::single_match)]
    app.run(move |app_handle, event| match event {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Opened { urls } => {
            let urls: Vec<String> = urls.into_iter().map(|url| url.to_string()).collect();
            handle_uris(app_handle, urls);
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { has_visible_windows, .. }
        if !has_visible_windows => {
            tray::toggle_main_window(app_handle, app_handle.get_webview_window("main"));
        }
        // Closing the last window must not end the app, it keeps running in
        // the tray. An explicit app.exit() carries a code and goes through so
        // that the regular Tauri exit hooks run (window state is saved there).
        tauri::RunEvent::ExitRequested { api, code: None, .. } => {
            api.prevent_exit();
            tray::set_tray_showhide_text(app_handle, "Show");
        }
        _ => {}
    });
}
