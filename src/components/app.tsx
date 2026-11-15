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

import { ConfigContext, ServerConfigContext } from "../config";
import type { ServerConfig } from "../config";
import React, { useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Server } from "../components/server";
import { ClientManager } from "../clientmanager";
import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { queryClient } from "queries";
import { ClientContext } from "rpc/client";
import type { ServerTabsRef } from "./servertabs";
import { ServerTabs } from "./servertabs";
import { useDisclosure, useHotkeys } from "hooks";
import * as Icon from "react-bootstrap-icons";
import { modKeyString } from "trutil";
import { ColorSchemeToggle, FontSizeToggle, ShowVersion } from "./miscbuttons";
import { AppSettingsModal } from "./modals/settings";
import { ToolbarButton } from "./toolbar";
import { checkForUpdates } from "updater";
import { useComputedColorScheme } from "./theme";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Toaster } from "./ui/sonner";
import "css/custom.css";

const { appWindow, invoke, makeCreateTorrentView } = await import(/* webpackChunkName: "taurishim" */"taurishim");

interface PassEventData {
    from: string,
    payload: string,
}

function CreateTorrentButton() {
    const config = useContext(ConfigContext);
    const colorScheme = useComputedColorScheme();

    useEffect(() => {
        const unlisten = appWindow.listen<PassEventData>("pass-from-window", ({ payload: data }) => {
            if (data.payload === "ready") {
                void invoke("pass_to_window", {
                    to: data.from,
                    payload: JSON.stringify({ colorScheme, defaultTrackers: config.values.interface.defaultTrackers }),
                });
            }
        });
        return () => {
            void unlisten.then((u) => {
                u();
            });
        };
    }, [colorScheme, config]);

    const onClick = useCallback(() => {
        void makeCreateTorrentView();
    }, []);

    useHotkeys([
        ["mod + T", onClick],
    ]);

    return (
        <Button
            variant="outline"
            size="icon-lg"
            onClick={onClick}
            title={`Create new torrent file (${modKeyString()} + T)`}
            className="my-auto"
        >
            <Icon.Stars size="1.1rem" />
        </Button>
    );
}

export function App(props: React.PropsWithChildren) {
    return (
        <QueryClientProvider client={queryClient}>
            <Toaster />
            {props.children}
            <ReactQueryDevtools />
        </QueryClientProvider>
    );
}

export default function TauriApp() {
    const config = useContext(ConfigContext);
    const clientManager = useMemo(() => {
        const cm = new ClientManager(config);
        config.getOpenTabs().forEach((tab) => {
            cm.open(tab, config.values.app.toastNotifications, config.values.app.toastNotificationSound);
        });
        return cm;
    }, [config]);

    const tabsRef = useRef<ServerTabsRef>(null);

    const [currentServer, setCurrentServer] = useState<ServerConfig | undefined>(
        config.getServer(config.getLastOpenTab()));
    const [servers, setServers] = useState(config.getServers());

    const [showServerConfig, serverConfigHandlers] = useDisclosure(false);

    const [serverKey, incServerKey] = useReducer((x) => x + 1, 0);

    // Look for a newer release once the window has settled and then once a
    // day, since the app can sit in the tray for weeks. An available update is
    // offered in a notification, failures are only logged. The setting is read
    // on every tick so a change in Settings applies without a restart.
    useEffect(() => {
        const checkIfEnabled = () => {
            if (config.values.app.autoCheckUpdates) void checkForUpdates(false);
        };
        const timer = setTimeout(checkIfEnabled, 5000);
        const interval = setInterval(checkIfEnabled, 24 * 60 * 60 * 1000);
        return () => {
            clearTimeout(timer);
            clearInterval(interval);
        };
    }, [config]);

    const onServerSave = useCallback((servers: ServerConfig[]) => {
        setServers(servers);
        config.setServers(servers);
        // force remount of server component to make sure interface settings are applied
        incServerKey();
        void config.save();
    }, [config]);

    const [showTabStrip, setShowTabStrip] = useState(config.values.app.showTabStrip);

    const toggleTabStrip = useCallback(() => {
        config.values.app.showTabStrip = !showTabStrip;
        setShowTabStrip(!showTabStrip);
    }, [config, showTabStrip]);

    const onCreateTorrent = useCallback(() => {
        void makeCreateTorrentView();
    }, []);

    return (
        <App>
            <AppSettingsModal
                onSave={onServerSave}
                opened={showServerConfig}
                close={serverConfigHandlers.close}
            />
            <div className="flex h-full w-full flex-col">
                <ServerTabs
                    ref={tabsRef}
                    clientManager={clientManager}
                    servers={servers}
                    setCurrentServer={setCurrentServer}
                    visible={showTabStrip}
                >
                    <div className="my-auto ml-auto flex items-center gap-2">
                        <CreateTorrentButton />
                        <ColorSchemeToggle btn="lg" />
                        <FontSizeToggle />
                        <Button
                            size="icon-lg"
                            variant="outline"
                            className="my-auto"
                            title="Configure servers"
                            onClick={serverConfigHandlers.open}
                        >
                            <Icon.GearFill size="1.1rem" />
                        </Button>
                        <ShowVersion btn="lg" />
                    </div>
                </ServerTabs>
                {currentServer !== undefined
                    ? <ServerConfigContext.Provider value={currentServer}>
                        <ClientContext.Provider value={clientManager.getClient(currentServer.name)}>
                            <Server
                                key={serverKey}
                                hostname={clientManager.getHostname(currentServer.name)}
                                tabsRef={tabsRef}
                                toolbarExtra={!showTabStrip && <>
                                    <ToolbarButton title={`Create torrent (${modKeyString()} + T)`} onClick={onCreateTorrent}>
                                        <Icon.Stars size="1.5rem" />
                                    </ToolbarButton>
                                    <ToolbarButton title="Configure servers" onClick={serverConfigHandlers.open}>
                                        <Icon.GearFill size="1.5rem" />
                                    </ToolbarButton>
                                    {tabsRef.current?.getOpenTabs() !== undefined && tabsRef.current?.getOpenTabs()?.length > 1
                                        && <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <ToolbarButton title="Switch server">
                                                    <Icon.Diagram2 size="1.5rem" />
                                                </ToolbarButton>
                                            </DropdownMenuTrigger>

                                            <DropdownMenuContent className="w-48" align="start">
                                                {tabsRef.current?.getOpenTabs().map((tab, index) =>
                                                    <DropdownMenuItem key={index} onClick={() => { tabsRef.current?.switchTab(index); }}>
                                                        {tab}
                                                    </DropdownMenuItem>)}
                                            </DropdownMenuContent>
                                        </DropdownMenu>}
                                </>}
                                toggleTabStrip={toggleTabStrip}
                            />
                        </ClientContext.Provider>
                    </ServerConfigContext.Provider>
                    : <div className="flex h-full w-full items-center justify-center">
                        <div className="flex flex-col gap-2">
                            {servers.map((s, i) => {
                                return <Button
                                    key={i}
                                    variant="ghost"
                                    onClick={() => tabsRef.current?.openTab(s.name)}
                                >
                                    {s.name}
                                </Button>;
                            })}
                            <Button
                                className={`h-[4.5rem] rounded-lg px-10 text-[1.75rem] ${servers.length > 0 ? "mt-4" : ""}`}
                                onClick={serverConfigHandlers.open}
                            >
                                Configure Servers
                            </Button>
                        </div>
                    </div>}
            </div>
        </App>
    );
}
