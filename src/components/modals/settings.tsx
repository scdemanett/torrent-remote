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

import classes from "./settings.module.css";
import clsx from "clsx";
import type { ServerConfig, WindowCloseOption, WindowMinimizeOption } from "config";
import { ConfigContext, WindowCloseOptions, WindowMinimizeOptions } from "config";
import React, { useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ModalState } from "./common";
import { SaveCancelModal } from "./common";
import * as Icon from "react-bootstrap-icons";
import type { UseFormReturn } from "react-hook-form";
import { Controller, useFieldArray, useForm } from "react-hook-form";
import { UAParser } from "ua-parser-js";
import type { InterfaceFormValues } from "./interfacepanel";
import { InterfaceSettigsPanel } from "./interfacepanel";
import { RhfCheckbox, RhfPassword, RhfText } from "components/formfields";
import { Button } from "components/ui/button";
import { TextareaField, TextInput } from "components/ui/fields";
import { SegmentedControl } from "components/ui/segmented-control";
import { Switch } from "components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "components/ui/tabs";
const { TAURI, invoke } = await import(/* webpackChunkName: "taurishim" */"taurishim");

interface FormValues extends InterfaceFormValues {
    servers: ServerConfig[],
    app: {
        deleteAdded: boolean,
        toastNotifications: boolean,
        toastNotificationSound: boolean,
        autoCheckUpdates: boolean,
        showTrayIcon: boolean,
        onMinimize: WindowMinimizeOption,
        onClose: WindowCloseOption,
    },
}

type Form = UseFormReturn<FormValues>;

interface ServerListPanelProps {
    form: Form,
    current: number,
    setCurrent: React.Dispatch<number>,
}

function ServerListPanel({ form, current, setCurrent }: ServerListPanelProps) {
    const { append, remove, move } = useFieldArray({ control: form.control, name: "servers" });
    const servers = form.watch("servers");

    return (
        <div className="flex w-1/4 min-w-[12rem] max-w-[20rem] shrink-0 flex-col gap-2">
            <div className={clsx("scrollable", classes.serverListContainer)}>
                <div>
                    {servers.map((s, i) => {
                        let isDuplicate = false;
                        servers.forEach((other, otherIndex) => {
                            if (otherIndex !== i && other.name === s.name) isDuplicate = true;
                        });
                        return <div
                            key={i}
                            className={`px-1.5 ${i === current ? "selected" : ""}`}
                            style={{ textDecoration: isDuplicate ? "red wavy underline" : undefined }}
                            onClick={() => { setCurrent(i); }}
                        >
                            {s.name}
                        </div>;
                    })}
                </div>
            </div>
            <div className="grid grid-cols-4 gap-2">
                <Button
                    className="h-7 w-full px-0 hover:bg-primary/70"
                    title="Add server"
                    onClick={() => {
                        append({
                            connection: { url: "", username: "", password: "", acceptInvalidCerts: false },
                            name: "new",
                            pathMappings: [],
                            expandedDirFilters: [],
                            lastSaveDirs: [],
                            intervals: { session: 60, torrents: 5, torrentsMinimized: 60, details: 5 },
                        });
                        void form.trigger();
                        setCurrent(servers.length);
                    }}
                >
                    <Icon.PlusLg className="size-[1.4rem]" stroke="currentColor" strokeWidth={0.6} />
                </Button>
                <Button
                    className="h-7 w-full px-0 hover:bg-primary/70"
                    title="Remove server"
                    onClick={() => {
                        if (current < 0) return;
                        if (current >= servers.length - 1) {
                            setCurrent(servers.length - 2);
                        }
                        remove(current);
                    }}
                >
                    <Icon.DashLg className="size-[1.4rem]" stroke="currentColor" strokeWidth={0.6} />
                </Button>
                <Button
                    className="h-7 w-full px-0 hover:bg-primary/70"
                    title="Move up"
                    onClick={() => {
                        if (current > 0) {
                            move(current, current - 1);
                            setCurrent(current - 1);
                        }
                    }}
                >
                    <Icon.ArrowUp className="size-[1.4rem]" stroke="currentColor" strokeWidth={0.6} />
                </Button>
                <Button
                    className="h-7 w-full px-0 hover:bg-primary/70"
                    title="Move down"
                    onClick={() => {
                        if (current < servers.length - 1) {
                            move(current, current + 1);
                            setCurrent(current + 1);
                        }
                    }}
                >
                    <Icon.ArrowDown className="size-[1.4rem]" stroke="currentColor" strokeWidth={0.6} />
                </Button>
            </div>
        </div>
    );
}

interface ServerPanelProps {
    form: Form,
    current: number,
}

function validateServerName(value: unknown, values: FormValues, index: number) {
    let found = false;
    values.servers.forEach((server, i) => {
        if (i !== index && value === server.name) {
            found = true;
        }
    });
    return found ? "Server names must be unique" : true;
}

function validateServerUrl(value: unknown) {
    try {
        const url = new URL(String(value));
        if (!["http:", "https:"].includes(url.protocol)) {
            return "Only http/https URLs are supported";
        }
    } catch {
        return "Invalid URL";
    }
    return true;
}

const DEFAULT_RPC_PATH = "/transmission/rpc";

const DEFAULT_RPC_PORT = "9091";

/** The rpc url as edited: the server address with optional port and rpc path overrides */
interface ServerUrlParts {
    address: string,
    // empty means DEFAULT_RPC_PORT
    port: string,
    // empty means DEFAULT_RPC_PATH
    path: string,
}

function portOverride(port: string): string {
    return port === DEFAULT_RPC_PORT ? "" : port;
}

function pathOverride(path: string): string {
    return path === "/" || path === DEFAULT_RPC_PATH ? "" : path;
}

/** An address typed without a scheme is taken as http */
function withScheme(address: string): string {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : `http://${address}`;
}

/** The port written out in an address, if any. URL.port can not be used, it drops 80 and 443. */
function explicitPort(address: string): string | undefined {
    return /^[a-z][a-z0-9+.-]*:\/\/[^/]*?:(\d+)(?:\/|$)/i.exec(address)?.[1];
}

function splitServerUrl(url: string): ServerUrlParts {
    try {
        const parsed = new URL(url);
        // a saved url without a port means the scheme's own port, not the Transmission default
        const port = parsed.port !== "" ? parsed.port : parsed.protocol === "https:" ? "443" : "80";
        return {
            address: `${parsed.protocol}//${parsed.hostname}`,
            port: portOverride(port),
            path: pathOverride(parsed.pathname + parsed.search),
        };
    } catch {
        return { address: url, port: "", path: "" };
    }
}

function joinServerUrl({ address, port, path }: ServerUrlParts): string {
    const trimmed = address.trim().replace(/\/+$/, "");
    if (trimmed === "") return "";
    const base = withScheme(trimmed);
    const rpcPort = port.trim() === "" ? DEFAULT_RPC_PORT : port.trim();
    const rpcPath = path.trim() === "" ? DEFAULT_RPC_PATH : path.trim();
    return base
        + (explicitPort(base) !== undefined ? "" : `:${rpcPort}`)
        + (rpcPath.startsWith("/") ? "" : "/") + rpcPath;
}

/** Moves a port or path typed or pasted into the address field over to their own fields */
function liftFromAddress(parts: ServerUrlParts): ServerUrlParts | undefined {
    const address = withScheme(parts.address.trim());
    try {
        const parsed = new URL(address);
        const hasPath = parsed.pathname !== "/" || parsed.search !== "";
        const port = explicitPort(address);
        if (!hasPath && port === undefined) return undefined;
        return {
            address: `${parsed.protocol}//${parsed.hostname}`,
            port: port !== undefined ? portOverride(port) : parts.port,
            path: hasPath ? pathOverride(parsed.pathname + parsed.search) : parts.path,
        };
    } catch {
        return undefined;
    }
}

interface PathMappingPair {
    from: string,
    to: string,
}

function parsePathMappings(text: string): PathMappingPair[] {
    return text.split("\n").map((line) => {
        const equalsPos = line.indexOf("=");
        // A line without "=" yet is a remote path still being typed
        if (equalsPos < 0) return { from: line, to: "" };
        return {
            from: line.substring(0, equalsPos),
            to: line.substring(equalsPos + 1),
        };
    });
}

function formatPathMappings(mappings: PathMappingPair[]): string {
    return mappings
        .filter((m) => m.from !== "" || m.to !== "")
        .map((m) => `${m.from}=${m.to}`)
        .join("\n");
}

function samePathMappings(a: PathMappingPair[], b: PathMappingPair[]): boolean {
    return a.length === b.length && a.every((m, i) => m.from === b[i].from && m.to === b[i].to);
}

function ServerPanel(props: ServerPanelProps) {
    const [mappingsString, setMappingsString] = useState("");
    const pathMappings = props.form.watch(`servers.${props.current}.pathMappings`);

    useEffect(() => {
        // Keep the text exactly as typed while it still describes the form value,
        // only rewrite it when the mappings changed from outside (e.g. another server selected)
        setMappingsString((current) =>
            samePathMappings(parsePathMappings(current), pathMappings)
                ? current
                : formatPathMappings(pathMappings));
    }, [pathMappings]);

    const url = props.form.watch(`servers.${props.current}.connection.url`);
    const [urlParts, setUrlParts] = useState(() => splitServerUrl(url));

    useEffect(() => {
        // same as the mappings: keep what was typed, follow changes from outside
        setUrlParts((current) => joinServerUrl(current) === url ? current : splitServerUrl(url));
    }, [url]);

    return (
        <div className="flex flex-grow flex-col gap-2">
            <RhfText
                control={props.form.control}
                name={`servers.${props.current}.name`}
                rules={{ validate: (value, values) => validateServerName(value, values, props.current) }}
                label="Name"
                autoCorrect="off"
                autoCapitalize="off"
            />

            <Controller
                control={props.form.control}
                name={`servers.${props.current}.connection.url`}
                rules={{ validate: validateServerUrl }}
                render={({ field, fieldState }) => {
                    const update = (parts: ServerUrlParts) => {
                        setUrlParts(parts);
                        field.onChange(joinServerUrl(parts));
                    };
                    return <>
                        <div className="flex items-start gap-2">
                            <TextInput
                                ref={field.ref}
                                wrapperClassName="grow"
                                label="Server address"
                                placeholder="http://192.168.1.3"
                                value={urlParts.address}
                                onChange={(e) => { update({ ...urlParts, address: e.target.value }); }}
                                onBlur={() => {
                                    // a complete rpc url typed or pasted here is split into the three fields
                                    const lifted = liftFromAddress(urlParts);
                                    if (lifted !== undefined) update(lifted);
                                    field.onBlur();
                                }}
                                error={fieldState.error?.message}
                                autoComplete="off"
                                autoCorrect="off"
                                autoCapitalize="off"
                                spellCheck="false"
                            />
                            <TextInput
                                wrapperClassName="w-28 shrink-0"
                                label="Port"
                                placeholder={DEFAULT_RPC_PORT}
                                inputMode="numeric"
                                maxLength={5}
                                value={urlParts.port}
                                onChange={(e) => { update({ ...urlParts, port: e.target.value.replace(/\D/g, "") }); }}
                                onBlur={field.onBlur}
                                autoComplete="off"
                            />
                        </div>
                        <TextInput
                            label={`RPC path (leave empty for ${DEFAULT_RPC_PATH})`}
                            placeholder={DEFAULT_RPC_PATH}
                            value={urlParts.path}
                            onChange={(e) => { update({ ...urlParts, path: e.target.value }); }}
                            onBlur={field.onBlur}
                            autoComplete="off"
                            autoCorrect="off"
                            autoCapitalize="off"
                            spellCheck="false"
                        />
                    </>;
                }}
            />

            <RhfCheckbox
                control={props.form.control}
                name={`servers.${props.current}.connection.acceptInvalidCerts`}
                className="my-2"
                label="Accept invalid SSL certificates"
            />

            <div className="grid min-h-0 grow grid-cols-12 grid-rows-[auto_minmax(0,1fr)] gap-2">
                <div className="col-span-6">
                    <RhfText
                        control={props.form.control}
                        name={`servers.${props.current}.connection.username`}
                        label="User name"
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck="false"
                    />
                </div>
                <div className="col-span-6">
                    <RhfPassword
                        control={props.form.control}
                        name={`servers.${props.current}.connection.password`}
                        label="Password"
                    />
                </div>

                <div className="col-span-12 flex min-h-0 flex-col">
                    <TextareaField
                        wrapperClassName="min-h-0 grow"
                        className="grow"
                        label={"Path mappings in \"remote=local\" format, one per line"}
                        onChange={(e) => {
                            const mappings = parsePathMappings(e.target.value);
                            props.form.setValue(`servers.${props.current}.pathMappings`, mappings);
                            setMappingsString(e.target.value);
                        }}
                        value={mappingsString}
                        minRows={8}
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck="false"
                    />
                </div>
            </div>
        </div>
    );
}

function BigSwitch({ checked, onChange }: { checked: boolean, onChange: (checked: boolean) => void }) {
    return (
        <Switch
            size="lg"
            onLabel="ON"
            offLabel="OFF"
            checked={checked}
            onCheckedChange={onChange}
            className="w-28"
        />
    );
}

interface IntegrationsPanelProps {
    form: Form,
    // undefined until read from the system
    autostart: boolean | undefined,
    setAutostart: (state: boolean) => void,
}

function IntegrationsPanel({ form, autostart, setAutostart }: IntegrationsPanelProps) {
    const platform = useMemo(() => UAParser().os.name ?? "unknown", []);

    const associateTorrent = useCallback(() => {
        void invoke("app_integration", { mode: "torrent" });
    }, []);
    const associateMagnet = useCallback(() => {
        void invoke("app_integration", { mode: "magnet" });
    }, []);

    const app = form.watch("app");

    return (
        <div className="flex flex-col gap-3">
            {/* centred block of a sensible width, contents left aligned */}
            <div className="mx-auto grid w-full max-w-[48rem] grid-cols-12 items-center gap-2">
                <div className="col-span-6">Delete successfully added torrent files</div>
                <div className="col-span-6">
                    <BigSwitch
                        checked={app.deleteAdded}
                        onChange={(v) => { form.setValue("app.deleteAdded", v); }}
                    />
                </div>
                <div className="col-span-6">Show notifications for completed torrents</div>
                <div className="col-span-6">
                    <BigSwitch
                        checked={app.toastNotifications}
                        onChange={(v) => { form.setValue("app.toastNotifications", v); }}
                    />
                </div>
                <div className="col-span-6">Play sound for completed torrents</div>
                <div className="col-span-6">
                    <BigSwitch
                        checked={app.toastNotificationSound}
                        onChange={(v) => { form.setValue("app.toastNotificationSound", v); }}
                    />
                </div>
                <div className="col-span-6">Automatically check for updates</div>
                <div className="col-span-6">
                    <BigSwitch
                        checked={app.autoCheckUpdates}
                        onChange={(v) => { form.setValue("app.autoCheckUpdates", v); }}
                    />
                </div>
                {TAURI && <>
                    <div className="col-span-6">Launch on startup</div>
                    <div className="col-span-6">
                        {/* not rendered off first, it would visibly slide on */}
                        {autostart !== undefined && <BigSwitch
                            checked={autostart}
                            onChange={setAutostart}
                        />}
                    </div>
                </>}
                {platform === "Windows" && <>
                    <div className="col-span-6">Associate application</div>
                    <div className="col-span-6 flex flex-wrap gap-2">
                        <Button onClick={associateTorrent}>.torrent files</Button>
                        <Button onClick={associateMagnet}>magnet links</Button>
                    </div>
                </>}
                <div className="col-span-6">Show tray icon (takes effect after restart)</div>
                <div className="col-span-6">
                    <BigSwitch
                        checked={app.showTrayIcon}
                        onChange={(checked) => {
                            form.setValue("app.showTrayIcon", checked);
                            if (!checked) {
                                form.setValue("app.onMinimize", "minimize");
                                form.setValue("app.onClose", "quit");
                            }
                        }}
                    />
                </div>
                <div className="col-span-6">When minimized</div>
                <div className="col-span-6">
                    <SegmentedControl
                        data={WindowMinimizeOptions}
                        disabled={!app.showTrayIcon}
                        value={app.onMinimize}
                        onChange={(value) => { form.setValue("app.onMinimize", value as WindowMinimizeOption); }}
                    />
                </div>
                <div className="col-span-6">When closed</div>
                <div className="col-span-6">
                    <SegmentedControl
                        data={WindowCloseOptions}
                        disabled={!app.showTrayIcon}
                        value={app.onClose}
                        onChange={(value) => { form.setValue("app.onClose", value as WindowCloseOption); }}
                    />
                </div>
            </div>
            <p className="text-sm italic">
                Hiding the window keeps frontend running, this uses more RAM but reopening the window is nearly instant.
                Closing the window shuts down the webview, in this mode reopening the window is slower.
                You can always access the window through the system tray icon.
            </p>
        </div>
    );
}

interface AppSettingsModalProps extends ModalState {
    onSave: (servers: ServerConfig[]) => void,
}

export function AppSettingsModal(props: AppSettingsModalProps) {
    const config = useContext(ConfigContext);
    const form = useForm<FormValues>({
        defaultValues: {
            servers: config.getServers(),
            app: { ...config.values.app },
            interface: { ...config.values.interface },
        },
        mode: "onChange",
    });

    const [currentServerIndex, setCurrentServerIndex] = useState(-1);
    const { reset } = form;

    useEffect(() => {
        if (props.opened) {
            reset({
                servers: config.getServers(),
                app: { ...config.values.app },
                interface: { ...config.values.interface },
            });
            setCurrentServerIndex(config.getServers().length > 0 ? 0 : -1);
        }
    }, [config, props.opened, reset]);

    // Read here rather than in the integrations tab, which remounts each time
    // it is selected. Refreshed on every open, it can change outside the app.
    const [autostart, setAutostartState] = useState<boolean>();
    useEffect(() => {
        if (TAURI && props.opened) {
            invoke<boolean>("app_integration", { mode: "getautostart" })
                .then(setAutostartState)
                .catch(console.error);
        }
    }, [props.opened]);
    const setAutostart = useCallback((state: boolean) => {
        setAutostartState(state);
        void invoke("app_integration", { mode: state ? "autostart" : "noautostart" });
    }, []);

    const onSave = useCallback(() => {
        void form.trigger().then((valid) => {
            if (!valid) return;
            const values = form.getValues();
            config.setServers(values.servers);
            config.values.app = { ...config.values.app, ...values.app };
            // the dialog size is written live while the dialog is open, keep it
            const settingsDialogSize = config.values.interface.settingsDialogSize;
            config.values.interface = { ...config.values.interface, ...values.interface, settingsDialogSize };
            config.cleanup();
            props.onSave(values.servers);
            props.close();
        });
    }, [config, form, props]);

    const serverCount = form.watch("servers").length;

    const [dialogSize, setDialogSize] = useState(config.values.interface.settingsDialogSize);
    const onDialogResized = useCallback((size: [number, number]) => {
        config.values.interface.settingsDialogSize = size;
        setDialogSize(size);
    }, [config]);
    const resetDialogSize = useCallback(() => {
        config.values.interface.settingsDialogSize = undefined;
        setDialogSize(undefined);
    }, [config]);
    const dialogStyle = useMemo<React.CSSProperties | undefined>(() => dialogSize === undefined
        ? undefined
        : {
            width: `min(${dialogSize[0]}px, calc(100vw - 2rem))`,
            height: `min(${dialogSize[1]}px, calc(100vh - 2rem))`,
        }, [dialogSize]);

    return (
        <SaveCancelModal
            opened={props.opened}
            size="lg"
            resizable
            style={dialogStyle}
            onResized={onDialogResized}
            onClose={props.close}
            onSave={onSave}
            title="Application Settings"
        >
            <form className="flex min-h-0 grow flex-col" onSubmit={(e) => { e.preventDefault(); }}>
                <Tabs className="min-h-[33rem] grow" defaultValue="servers">
                    <TabsList>
                        <TabsTrigger value="servers" className="px-4 py-2.5">Servers</TabsTrigger>
                        <TabsTrigger value="integrations" className="px-4 py-2.5">Integrations</TabsTrigger>
                        {TAURI && <TabsTrigger value="interface" className="px-4 py-2.5">Interface</TabsTrigger>}
                    </TabsList>

                    <TabsContent value="servers" className="flex flex-col pt-2">
                        <div className="flex min-h-[28rem] grow gap-2">
                            <ServerListPanel form={form} current={currentServerIndex} setCurrent={setCurrentServerIndex} />
                            {currentServerIndex === -1 || currentServerIndex >= serverCount
                                ? <></>
                                : <ServerPanel key={currentServerIndex} form={form} current={currentServerIndex} />}
                        </div>
                    </TabsContent>

                    <TabsContent value="integrations" className="pt-2">
                        <IntegrationsPanel form={form} autostart={autostart} setAutostart={setAutostart} />
                    </TabsContent>

                    {TAURI && <TabsContent value="interface" className="flex flex-col pt-2">
                        <InterfaceSettigsPanel
                            form={form as unknown as UseFormReturn<InterfaceFormValues>}
                            onResetDialogSize={resetDialogSize}
                        />
                    </TabsContent>}
                </Tabs>
            </form>
        </SaveCancelModal>
    );
}
