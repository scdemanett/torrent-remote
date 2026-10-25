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

import type { EventCallback } from "@tauri-apps/api/event";
import type { CloseRequestedEvent } from "@tauri-apps/api/window";
import type { DragDropEvent } from "@tauri-apps/api/webview";

// __TAURI_INTERNALS__ is what @tauri-apps/api itself talks to and is always
// present in a Tauri webview, unlike the optional global API (withGlobalTauri).
export const TAURI = Object.prototype.hasOwnProperty.call(window, "__TAURI_INTERNALS__");
const realAppWindow = TAURI ? (await import(/* webpackMode: "lazy-once" */ "@tauri-apps/api/window")).getCurrentWindow() : undefined;
const WebviewWindow = TAURI
    ? (await import(/* webpackMode: "lazy-once" */ "@tauri-apps/api/webviewWindow")).WebviewWindow
    : undefined;
const fs = TAURI
    ? (await import(/* webpackMode: "lazy-once" */ "@tauri-apps/plugin-fs"))
    : undefined;
const clipboard = TAURI
    ? (await import(/* webpackMode: "lazy-once" */ "@tauri-apps/plugin-clipboard-manager"))
    : undefined;

export const appWindow = {
    emit: async (event: string, payload?: unknown) => await realAppWindow?.emit(event, payload),
    listen: async <T>(event: string, handler: EventCallback<T>) =>
        await realAppWindow?.listen(event, handler) ?? (() => { }),
    once: async <T>(event: string, handler: EventCallback<T>) => await realAppWindow?.once(event, handler),
    onDragDropEvent: async (handler: EventCallback<DragDropEvent>) =>
        await realAppWindow?.onDragDropEvent(handler) ?? (() => { }),
    onCloseRequested: async (handler: (event: CloseRequestedEvent) => void | Promise<void>) =>
        await realAppWindow?.onCloseRequested(handler),
    onFocusChanged: async (handler: EventCallback<boolean>) =>
        await realAppWindow?.onFocusChanged(handler),
    isMinimized: async () => await realAppWindow?.isMinimized() ?? false,
    hide: async () => await realAppWindow?.hide(),
    show: async () => await realAppWindow?.show(),
    minimize: async () => await realAppWindow?.minimize(),
    unminimize: async () => await realAppWindow?.unminimize(),
    setFocus: async () => await realAppWindow?.setFocus(),
    setTitle: async (title: string) => await realAppWindow?.setTitle(title),
};

// Whether the main window is hidden in the tray. Kept here for components
// that mount while it is (e.g. after starting minimized), the window-hidden
// and window-shown events only reach listeners that already exist.
let mainWindowHidden = false;
export const isMainWindowHidden = () => mainWindowHidden;
void realAppWindow?.listen("window-hidden", () => {
    mainWindowHidden = true;
});
void realAppWindow?.listen("window-shown", () => {
    mainWindowHidden = false;
});

export const invoke = TAURI
    ? (await import(/* webpackMode: "lazy-once" */ "@tauri-apps/api/core")).invoke
    : async <T>() =>
        await Promise.reject<T>(new Error("Running outside of tauri app"));

// fetch through the Rust side (tauri-plugin-http): no CORS, any header,
// and per-request acceptance of invalid certificates.
export const tauriFetch = TAURI
    ? (await import(/* webpackMode: "lazy-once" */ "@tauri-apps/plugin-http")).fetch
    : undefined;

export const dialogOpen = TAURI
    ? (await import(/* webpackMode: "lazy-once" */ "@tauri-apps/plugin-dialog")).open
    : async () =>
        await Promise.reject<string[] | string | null>(new Error("Running outside of tauri app"));

export const dialogSave = TAURI
    ? (await import(/* webpackMode: "lazy-once" */ "@tauri-apps/plugin-dialog")).save
    : async () =>
        await Promise.reject<string | null>(new Error("Running outside of tauri app"));

export async function makeCreateTorrentView() {
    if (WebviewWindow !== undefined) {
        const webview = new WebviewWindow(`createtorrent-${Math.floor(Math.random() * 2 ** 30)}`, {
            url: "createtorrent.html",
            width: 550,
            height: 730,
            // shown by the create torrent page once it has painted, see src/createtorrent.tsx
            visible: false,
            center: true,
            maximizable: false,
            title: "Create torrent",
        });
        await webview.once("tauri://error", (e) => {
            console.log("Webview error", e);
        });
    }
}

const configFile = "torrent-remote.json";
const configStorageKey = "torrent-remote-config";
// Settings of the TrguiNG app this project was forked from.
// They are imported once if no Torrent Remote config exists yet.
const legacyConfigFile = "trguing.json";
const legacyConfigStorageKey = "trguing-config";

export async function readConfigText() {
    if (fs !== undefined) {
        try {
            return await fs.readTextFile(configFile, { baseDir: fs.BaseDirectory.Config });
        } catch (e) {
            // No config of our own yet, try to import the legacy one.
            // If that is missing too, rethrow the original error so defaults are used.
            let legacy: string;
            try {
                legacy = await fs.readTextFile(legacyConfigFile, { baseDir: fs.BaseDirectory.Config });
            } catch {
                throw e;
            }
            console.log(`Importing settings from ${legacyConfigFile}`);
            await writeConfigText(legacy);
            return legacy;
        }
    } else {
        const stored = localStorage.getItem(configStorageKey);
        if (stored !== null) return stored;
        const legacy = localStorage.getItem(legacyConfigStorageKey);
        if (legacy !== null) {
            localStorage.setItem(configStorageKey, legacy);
            return legacy;
        }
        return "{}";
    }
}

export async function writeConfigText(contents: string) {
    if (fs !== undefined) {
        await fs.writeTextFile(configFile, contents, { baseDir: fs.BaseDirectory.Config });
    } else {
        localStorage.setItem(configStorageKey, contents);
    }
}

export function copyToClipboard(text: string) {
    if (TAURI) void clipboard?.writeText(text);
    else {
        const textArea = document.createElement("textarea");
        textArea.value = text;

        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();

        try {
            document.execCommand("copy");
        } catch (err) {
            console.error("Can not copy to clipboard.", err);
        }

        document.body.removeChild(textArea);
    }
}

export async function saveJsonFile(contents: string, filename: string) {
    if (fs !== undefined) {
        dialogSave({
            title: "Save interface settings",
            defaultPath: filename,
            filters: [{
                name: "JSON",
                extensions: ["json"],
            }],
        }).then((path) => {
            if (path != null) {
                void invoke("save_text_file", { contents, path });
            }
        }).catch(console.error);
    } else {
        const blob = new Blob([contents], { type: "application/json" });
        const link = document.createElement("a");
        const objurl = URL.createObjectURL(blob);
        link.download = filename;
        link.href = objurl;
        link.click();
    }
}

export async function loadJsonFile(): Promise<string> {
    if (fs !== undefined) {
        return await new Promise((resolve, reject) => {
            dialogOpen({
                title: "Select interface settings file",
                filters: [{
                    name: "JSON",
                    extensions: ["json"],
                }],
            }).then((path) => {
                if (path != null) {
                    invoke<string>("load_text_file", { path }).then(resolve).catch(reject);
                }
            }).catch(reject);
        });
    } else {
        return await new Promise((resolve, reject) => {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = ".json";
            input.onchange = () => {
                const files = input.files;
                if (files == null) reject(new Error("file not chosen"));
                else {
                    const reader = new FileReader();
                    reader.onload = () => {
                        resolve(reader.result as string);
                    };
                    reader.onerror = () => {
                        reject(new Error("Unable to read file"));
                    };
                    reader.readAsText(files[0], "UTF-8");
                }
            };
            input.click();
        });
    }
}
