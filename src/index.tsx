/**
 * Torrent Remote - remote GUI for transmission torrent daemon
 * Copyright (C) 2023  qu1ck (mail at qu1ck.org)
 * Copyright (C) 2026  Steven Demanett
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import "css/loader.css";
import { suppressNativeContextMenu } from "trutil";
import { Config, ConfigContext } from "./config";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import React, { lazy, Suspense, useContext, useEffect } from "react";
import type { CSSProperties } from "react";
const { TAURI, appWindow, invoke } = await import(/* webpackChunkName: "taurishim" */"taurishim");

const TauriApp = lazy(async () => await import("components/app"));
const WebApp = lazy(async () => await import("components/webapp"));
const ThemeProvider = lazy(
    async () => await import("components/theme"));

async function onCloseRequested(app: Root, config: Config) {
    await config.save();
    await appWindow.emit("listener-pause", {});
    app.unmount();
    const configs = config.getOpenServers().map((serverConfig) => ({
        name: serverConfig.name,
        connection: serverConfig.connection,
        interval: serverConfig.intervals.torrentsMinimized,
    }));
    await invoke("set_poller_config", {
        configs, toast: config.values.app.toastNotifications, sound: config.values.app.toastNotificationSound,
    });
    void appWindow.emit("frontend-done");
}

async function onFocusChange(focused: boolean, config: Config) {
    if (!focused && config.values.app.onMinimize === "hide") {
        if (await appWindow.isMinimized()) {
            void appWindow.emit("window-hidden");
            void appWindow.hide();
        }
    }
}

function setupTauriEvents(config: Config, app: Root) {
    void appWindow.onCloseRequested((event) => {
        if (config.values.app.onClose === "hide") {
            event.preventDefault();
            void appWindow.emit("window-hidden");
            void appWindow.hide();
        } else if (config.values.app.onClose === "quit") {
            event.preventDefault();
            config.save().finally(() => {
                void appWindow.emit("app-exit");
            });
        } else {
            void onCloseRequested(app, config);
        }
    });

    void appWindow.listen("exit-requested", () => {
        void onCloseRequested(app, config);
    });

    void appWindow.onFocusChanged(({ payload: focused }) => {
        void onFocusChange(focused, config);
    });
}

function setupWebEvents(config: Config) {
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
            config.save().catch(() => { });
        }
    });
}

// The main window is created hidden so that the window-state plugin can
// restore its size, position and maximized state first (see tray.rs).
// Reveal it as soon as React has painted something, unless the app was
// launched on startup: then it stays in the tray, or goes to the taskbar
// when there is no tray icon to open it from.
function RevealWindow({ startMinimized }: { startMinimized: boolean }) {
    const config = useContext(ConfigContext);
    useEffect(() => {
        if (!startMinimized) {
            void appWindow.show().then(async () => await appWindow.setFocus());
        } else if (config.values.app.showTrayIcon) {
            void appWindow.emit("window-hidden");
        } else {
            void appWindow.show().then(async () => await appWindow.minimize());
        }
    }, [config, startMinimized]);
    return null;
}

function Loader() {
    const config = useContext(ConfigContext);

    const interfaceConfig = config.values.interface;
    const theme = interfaceConfig.theme;
    const backgroundColorOverride =
        interfaceConfig.styleOverrides[theme === "auto" ? "light" : theme].backgroundColor;
    const spinnerStyle: CSSProperties = {
        borderTopColor: `hsla(222, 100%, ${theme === "dark" ? "50%" : "36%"}, 0.376)`,
    };

    return (
        <div
            className="loader-container"
            style={{
                backgroundColor:
                    backgroundColorOverride?.computed
                    ?? (theme === "dark" ? "#1A1B1E" : "#fff"), // #1A1B1E comes from theme.colors.dark[7]
            }}
        >
            <div className="lds-ring">
                <div style={spinnerStyle}></div>
                <div style={spinnerStyle}></div>
                <div style={spinnerStyle}></div>
                <div style={spinnerStyle}></div>
            </div>
        </div>
    );
}

async function run(config: Config) {
    const appnode = document.getElementById("app") as HTMLElement;
    const app = createRoot(appnode);
    const startMinimized = TAURI && await invoke<boolean>("take_start_minimized").catch(() => false);

    if (TAURI) {
        suppressNativeContextMenu();
        setupTauriEvents(config, app);

        if (config.values.app.showTrayIcon) {
            void invoke("create_tray");
        }
    } else {
        setupWebEvents(config);
    }

    app.render(
        <React.StrictMode>
            <ConfigContext.Provider value={config}>
                {TAURI && <RevealWindow startMinimized={startMinimized} />}
                <Suspense fallback={<Loader />}>
                    <ThemeProvider>
                        {TAURI && <TauriApp />}
                        {!TAURI && <WebApp />}
                    </ThemeProvider>
                </Suspense>
            </ConfigContext.Provider>
        </React.StrictMode>,
    );
}

function start() {
    new Config().read().then(run).catch(console.error);
}

// The awaits above (tauri shim, proxy address) can outlast the page load,
// so do not rely on the load event still being ahead of us.
if (document.readyState === "complete") {
    start();
} else {
    window.addEventListener("load", start);
}
