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

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{
    async_runtime,
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Listener, Manager, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_window_state::AppHandleExt;
use tokio::sync::oneshot;

use crate::window_state_flags;

pub const TRAY_ID: &str = "tray";

/// The tray uses a flat monochrome glyph rather than the full-colour app
/// tile. On macOS it is a black template image, which the system recolours
/// for light and dark menu bars and for the highlighted state, so the 44 px
/// file is a 2x menu bar asset. Windows and Linux have no template concept
/// and default to dark taskbars, so they get the white glyph.
fn tray_icon() -> tauri::image::Image<'static> {
    #[cfg(target_os = "macos")]
    {
        tauri::include_image!("icons/tray/tray-black-44.png")
    }
    #[cfg(not(target_os = "macos"))]
    {
        tauri::include_image!("icons/tray/tray-white-32.png")
    }
}

/// What the tray glyph should say about the active server connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayState {
    /// Connected, nothing downloading or seeding: the plain platform glyph.
    Idle,
    /// Connected and at least one transfer running: coloured centre node.
    Active,
    /// The server cannot be reached: greyed glyph.
    Disconnected,
}

impl std::str::FromStr for TrayState {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "idle" => Ok(TrayState::Idle),
            "active" => Ok(TrayState::Active),
            "disconnected" => Ok(TrayState::Disconnected),
            other => Err(format!("Unknown tray state: {other}")),
        }
    }
}

/// Same size convention as `tray_icon`: 44 px on macOS, 32 px elsewhere.
fn tray_state_icon(state: TrayState) -> tauri::image::Image<'static> {
    match state {
        TrayState::Idle => tray_icon(),
        #[cfg(target_os = "macos")]
        TrayState::Active => tauri::include_image!("icons/tray/tray-active-44.png"),
        #[cfg(not(target_os = "macos"))]
        TrayState::Active => tauri::include_image!("icons/tray/tray-active-32.png"),
        #[cfg(target_os = "macos")]
        TrayState::Disconnected => tauri::include_image!("icons/tray/tray-disconnected-44.png"),
        #[cfg(not(target_os = "macos"))]
        TrayState::Disconnected => tauri::include_image!("icons/tray/tray-disconnected-32.png"),
    }
}

static TRAY_STATE: Mutex<TrayState> = Mutex::new(TrayState::Idle);

/// Swaps the tray glyph to match `state`. A no-op when the state is unchanged,
/// so callers may report it on every poll.
pub fn set_tray_state(app: &AppHandle, state: TrayState) {
    {
        // Not held across the tray calls below: those block on the main
        // thread, which may itself be inside this function for a command.
        let mut current = TRAY_STATE.lock().unwrap();
        if *current == state {
            return;
        }
        *current = state;
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        // The active glyph is coloured, which a macOS template image cannot
        // be: the system would flatten it to a mask. Leave template mode
        // before showing it and return to it afterwards. The other two glyphs
        // are flat and stay template images so the menu bar can recolour them.
        #[cfg(target_os = "macos")]
        if state == TrayState::Active {
            tray.set_icon_as_template(false).ok();
        }
        tray.set_icon(Some(tray_state_icon(state))).ok();
        #[cfg(target_os = "macos")]
        if state != TrayState::Active {
            tray.set_icon_as_template(true).ok();
        }
    }
}

/// Text of the show/hide menu item, kept for a tray created after it was set
/// (the window starts hidden before the frontend creates the tray).
static SHOWHIDE_TEXT: Mutex<&'static str> = Mutex::new("Hide");

pub fn create_tray(app: AppHandle) {
    let showhide_text = *SHOWHIDE_TEXT.lock().unwrap();
    let menu = create_menu(&app, showhide_text);

    // The tray can be created after the frontend has already reported a
    // state (tray icon enabled in settings), so start from that state.
    let state = *TRAY_STATE.lock().unwrap();
    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(tray_state_icon(state))
        .icon_as_template(state != TrayState::Active)
        .tooltip("Torrent Remote")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu_event);

    #[allow(clippy::single_match)]
    let builder = builder.on_tray_icon_event(|tray, event| {
        match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => {
                #[cfg(not(target_os = "macos"))]
                toggle_main_window(
                    tray.app_handle(),
                    tray.app_handle().get_webview_window("main"),
                );
            }
            _ => {}
        };
        let _ = tray;
    });

    #[cfg(target_os = "linux")]
    let builder = builder.temp_dir_path(dirs::runtime_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("tray-icon")
            .join(&app.config().identifier));

    builder.build(&app).ok();
}

fn create_menu<R>(app: &AppHandle<R>, showhide_text: &str) -> tauri::menu::Menu<R>
where
    R: tauri::Runtime,
{
    let hide = MenuItem::with_id(app, "showhide", showhide_text, true, None::<&str>).unwrap();
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>).unwrap();
    let separator = PredefinedMenuItem::separator(app).unwrap();
    Menu::with_items(app, &[&hide, &separator, &quit]).unwrap()
}

pub fn set_tray_showhide_text(app: &AppHandle, text: &'static str) {
    *SHOWHIDE_TEXT.lock().unwrap() = text;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(create_menu(app, text))).ok();
    }
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id.as_ref() {
        "quit" => {
            exit(app.clone());
        }
        "showhide" => {
            toggle_main_window(app, app.get_webview_window("main"));
        }
        _ => {}
    }
}

pub fn toggle_main_window(app: &AppHandle, window: Option<WebviewWindow>) {
    match window {
        Some(window) => {
            if !window.is_visible().unwrap() {
                window.show().ok();
                // unminimize restores the window on Windows, which would also
                // demaximize a window that was only hidden, so keep it conditional
                if window.is_minimized().unwrap_or(false) {
                    window.unminimize().ok();
                }
                window.set_focus().ok();
                window.emit("window-shown", "").ok();
                set_tray_showhide_text(app, "Hide");
                return;
            }
            set_tray_showhide_text(app, "Show");
            async_runtime::spawn(async move {
                close_main(window).await;
            });
        }
        None => create_main_window(app, false),
    }
}

/// Creates the main window. With `start_minimized` (autostart) the frontend
/// still loads, so the tray icon and polling work, but keeps the window hidden.
pub fn create_main_window(app: &AppHandle, start_minimized: bool) {
    let window =
        WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
            .title("Torrent Remote")
            .inner_size(1024., 800.)
            .center()
            // Created hidden: the window-state plugin restores size,
            // position and maximized state on creation, then the
            // frontend shows the window once it has painted (see
            // RevealWindow in src/index.tsx). Showing it earlier gives
            // a blank flash followed by a visible resize on every launch.
            .visible(false)
            .build()
            .unwrap();
    if start_minimized {
        set_tray_showhide_text(app, "Show");
    } else {
        set_tray_showhide_text(app, "Hide");
        reveal_fallback(window);
    }
}

pub fn exit(app: AppHandle) {
    async_runtime::spawn(async move {
        if let Some(window) = app.get_webview_window("main") {
            close_main(window).await;
        }
        app.exit(0);
    });
}

/// Shows the window after a delay if the frontend has not done so, so a
/// broken frontend never leaves the app running invisibly.
fn reveal_fallback(window: WebviewWindow) {
    async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        if !window.is_visible().unwrap_or(true) {
            window.show().ok();
        }
    });
}

async fn close_main(window: WebviewWindow) {
    let (tx, rx) = oneshot::channel::<()>();
    let tx = Arc::new(Mutex::new(Some(tx)));
    window.listen("frontend-done", move |_| {
        if let Some(tx) = tx.lock().unwrap().take() {
            tx.send(()).ok();
        }
    });
    window.emit("exit-requested", ()).ok();
    // A frontend that never answers (crashed webview) must not keep the
    // window open or block quitting forever.
    if tokio::time::timeout(Duration::from_secs(5), rx).await.is_err() {
        log::warn!("Frontend did not confirm exit-requested within 5s, closing anyway");
    }
    // destroy() skips the close-requested event the plugin saves on
    let _ = window.app_handle().save_window_state(window_state_flags());
    window.destroy().ok();
}
