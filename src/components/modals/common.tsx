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

import classes from "./common.module.css";
import { ConfigContext, ServerConfigContext } from "config";
import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { pathMapFromServer, pathMapToServer } from "trutil";
import * as Icon from "react-bootstrap-icons";
import { useServerSelectedTorrents, useServerTorrentData } from "rpc/torrent";
import { useHotkeysContext } from "hotkeys";
import { cn } from "lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "components/ui/dialog";
import { Button } from "components/ui/button";
import { Loader } from "components/ui/loader";
import { Separator } from "components/ui/separator";
import { TextInput } from "components/ui/fields";
import { TagsInput } from "components/ui/tags-input";
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "components/ui/dropdown-menu";
const { TAURI, dialogOpen } = await import(/* webpackChunkName: "taurishim" */"taurishim");

export interface ModalState {
    opened: boolean,
    close: () => void,
}

export type ModalSize = "lg" | "xl";

const modalSizeClasses: Record<ModalSize, string> = {
    lg: "w-[38.75rem]",
    xl: "w-[44rem]",
};

export interface HkModalProps extends React.PropsWithChildren {
    opened: boolean,
    onClose: () => void,
    title?: React.ReactNode,
    size?: ModalSize,
    fullScreen?: boolean,
    /** user can drag the bottom right corner to resize, within sensible limits */
    resizable?: boolean,
    /** inline style for the dialog, used to apply a remembered size */
    style?: React.CSSProperties,
    /** called (debounced) with the new size after the user resized the dialog */
    onResized?: (size: [number, number]) => void,
    className?: string,
    bodyClassName?: string,
}

/**
 * Dialog that suspends the application hotkeys while it is open. The first
 * element carrying `data-autofocus` receives focus when the dialog opens.
 */
export function HkModal({
    opened, onClose, title, size = "lg", fullScreen = false, resizable = false, style, onResized, className, bodyClassName, children,
}: HkModalProps) {
    const hk = useHotkeysContext();

    // Reports user resizes. The first observation is the size the dialog opened
    // with and is only used as the baseline, so opening alone stores nothing.
    const contentRef = useCallback((el: HTMLDivElement | null) => {
        if (el === null || onResized === undefined) return;
        let baseline: [number, number] | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const observer = new ResizeObserver(() => {
            const current: [number, number] = [el.offsetWidth, el.offsetHeight];
            if (baseline === undefined) {
                baseline = current;
                return;
            }
            if (current[0] === baseline[0] && current[1] === baseline[1]) return;
            clearTimeout(timer);
            timer = setTimeout(() => {
                onResized(current);
            }, 250);
        });
        observer.observe(el);
        return () => {
            clearTimeout(timer);
            observer.disconnect();
        };
    }, [onResized]);

    useEffect(() => {
        hk.active = !opened;

        return () => {
            hk.active = true;
        };
    }, [opened, hk]);

    const onOpenAutoFocus = useCallback((e: Event) => {
        const content = e.currentTarget as HTMLElement | null;
        const target = content?.querySelector<HTMLElement>("[data-autofocus]:not([data-autofocus='false'])");
        if (target != null) {
            e.preventDefault();
            target.focus();
        }
    }, []);

    return (
        <Dialog open={opened} onOpenChange={(open) => { if (!open) onClose(); }}>
            <DialogContent
                ref={contentRef}
                style={style}
                className={cn(
                    "max-h-[calc(100vh-2rem)]",
                    modalSizeClasses[size],
                    fullScreen && "top-0 left-0 h-screen max-h-none w-screen max-w-none translate-x-0 translate-y-0 rounded-none border-0",
                    resizable && !fullScreen && "resize overflow-hidden min-h-[22rem] min-w-[34rem]",
                    className,
                )}
                onOpenAutoFocus={onOpenAutoFocus}
            >
                <DialogHeader>
                    <DialogTitle className={title === undefined ? "sr-only" : undefined}>
                        {title ?? "Dialog"}
                    </DialogTitle>
                </DialogHeader>
                <div className={cn("flex min-h-0 flex-col overflow-y-auto px-3 pb-3", resizable && "grow", bodyClassName)}>
                    {children}
                </div>
            </DialogContent>
        </Dialog>
    );
}

interface SaveCancelModalProps extends HkModalProps {
    onSave: () => void,
    saveLoading?: boolean,
}

export function SaveCancelModal({ onSave, onClose, children, saveLoading, ...other }: SaveCancelModalProps) {
    return (
        <HkModal onClose={onClose} {...other}>
            <Separator className="my-1.5" />
            {/* grows when the dialog is resizable so the buttons stay at the bottom */}
            <div className="flex min-h-0 grow flex-col overflow-y-auto">
                {children}
            </div>
            <Separator className="my-1.5" />
            <div className="flex justify-center gap-2">
                <Button
                    onClick={onSave}
                    size="lg"
                    className="text-base"
                    data-autofocus
                >
                    {saveLoading === true ? <Loader size="1rem" color="currentColor" /> : "Save"}
                </Button>
                <Button
                    onClick={onClose}
                    variant="light"
                    size="lg"
                    className="text-base"
                >
                    Cancel
                </Button>
            </div>
        </HkModal>
    );
}

export function LimitedNamesList({ names, limit }: { names: string[], limit?: number }) {
    limit = limit ?? 5;
    const t = names.slice(0, limit);

    return <>
        {t.map((s, i) => <div
            key={i}
            className={`mx-2 my-1 px-1.5 ${classes.limitedNamesText}`}
        >
            {s}
        </div>)}
        {names.length > limit && <div className="mx-4 mb-2">{`... and ${names.length - limit} more`}</div>}
    </>;
}

export function TorrentsNames(props: { torrentIds?: number[] }) {
    const serverData = useServerTorrentData();
    const serverSelected = useServerSelectedTorrents();
    const { torrentIds } = props;

    const allNames = useMemo<string[]>(() => {
        if (torrentIds !== undefined) {
            const names = serverData.torrents.filter(
                (t) => torrentIds.includes(t.id)).map((t) => t.name);
            return names.length > 0 ? names : ["No torrent selected"];
        }
        if (serverData.current == null || serverSelected.size === 0) {
            return ["No torrent selected"];
        }
        return serverData.torrents.filter(
            (t) => serverSelected.has(t.id)).map((t) => t.name);
    }, [serverData, serverSelected, torrentIds]);

    return <LimitedNamesList names={allNames} />;
}

export interface LocationData {
    path: string,
    setPath: (s: string) => void,
    lastPaths: string[],
    addPath: (dir: string) => void,
    removePath: (dir: string) => void,
    browseHandler: () => void,
    inputLabel?: string,
    disabled?: boolean,
    focusPath?: boolean,
}

export function useTorrentLocation(): LocationData {
    const config = useContext(ConfigContext);
    const serverConfig = useContext(ServerConfigContext);
    const [lastPaths, setLastPaths] = useState([] as string[]);

    const updateLastPaths = useCallback(() => {
        const paths = [...serverConfig.lastSaveDirs];
        if (config.values.interface.sortLastSaveDirs) {
            paths.sort();
        }
        setLastPaths(paths);
    }, [config, serverConfig]);

    const [path, setPath] = useState<string>("");

    const pathRef = useRef(path);
    pathRef.current = path;

    useEffect(() => {
        updateLastPaths();
        setPath("");
    }, [updateLastPaths]);

    useEffect(() => {
        if (!lastPaths.includes(pathRef.current) && lastPaths.length > 0) {
            setPath(lastPaths[0]);
        }
    }, [lastPaths]);

    const browseHandler = useCallback(() => {
        const mappedLocation = pathMapFromServer(path, serverConfig);
        dialogOpen({
            title: "Select directory",
            defaultPath: mappedLocation === "" ? undefined : mappedLocation,
            directory: true,
        }).then((directory) => {
            if (directory === null) return;
            const mappedPath = pathMapToServer((directory as string).replace(/\\/g, "/"), serverConfig);
            setPath(mappedPath.replace(/\\/g, "/"));
        }).catch(console.error);
    }, [serverConfig, path, setPath]);

    const addPath = useCallback((dir: string) => {
        config.addSaveDir(serverConfig.name, dir);
        updateLastPaths();
    }, [config, serverConfig, updateLastPaths]);

    const removePath = useCallback((dir: string) => {
        config.removeSaveDir(serverConfig.name, dir);
        updateLastPaths();
    }, [config, serverConfig, updateLastPaths]);

    return { path, setPath, lastPaths, addPath, removePath, browseHandler };
}

export function TorrentLocation(props: LocationData) {
    const config = useContext(ConfigContext);

    return (
        <div className="flex items-end gap-2">
            <TextInput
                value={props.path}
                label={props.inputLabel}
                disabled={props.disabled}
                onChange={(e) => { props.setPath(e.currentTarget.value); }}
                wrapperClassName="flex-grow"
                data-autofocus={props.focusPath}
                rightSection={
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                title="Recent directories"
                                disabled={
                                    props.disabled === true
                                    || (props.lastPaths.length === 0
                                        && config.values.interface.preconfiguredDirs.length === 0)
                                }
                            >
                                <Icon.ClockHistory size="16" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                            align="end"
                            className="max-h-[calc(100vh-0.5rem)] min-w-[35rem] max-w-[calc(100vw-2rem)]"
                        >
                            {config.values.interface.preconfiguredDirs.map((path) => (
                                <DropdownMenuItem key={path} onClick={() => { props.setPath(path); }}>
                                    {path}
                                </DropdownMenuItem>
                            ))}
                            {config.values.interface.preconfiguredDirs.length > 0 && props.lastPaths.length > 0
                                && <DropdownMenuSeparator />}
                            {props.lastPaths.map((path) => (
                                <DropdownMenuItem
                                    key={path}
                                    onClick={() => { props.setPath(path); }}
                                >
                                    <span className="flex-grow">{path.length > 0 ? path : "<empty>"}</span>
                                    <span
                                        role="button"
                                        title="Remove path"
                                        className="list-delete-icon ml-2 items-center rounded-sm p-1 hover:bg-accent-foreground/15"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            props.removePath(path);
                                        }}
                                    >
                                        <Icon.Trash size="12" />
                                    </span>
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>
                }
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck="false"
            />
            {TAURI && <Button onClick={props.browseHandler} disabled={props.disabled}>Browse</Button>}
        </div>
    );
}

interface TorrentLabelsProps {
    labels: string[],
    setLabels: React.Dispatch<string[]>,
    inputLabel?: string,
    disabled?: boolean,
    initiallyOpened?: boolean,
}

export function TorrentLabels(props: TorrentLabelsProps) {
    const config = useContext(ConfigContext);
    const serverData = useServerTorrentData();

    const initialLabelset = useMemo(() => {
        const labels = new Set<string>(config.values.interface.preconfiguredLabels);
        serverData.torrents.forEach((t) => t.labels?.forEach((l: string) => labels.add(l)));

        return Array.from(labels).sort();
    }, [config, serverData.torrents]);

    return (
        <TagsInput
            data={initialLabelset}
            value={props.labels}
            onChange={props.setLabels}
            label={props.inputLabel}
            defaultDropdownOpened={props.initiallyOpened}
            disabled={props.disabled}
            acceptValueOnBlur
        />
    );
}
