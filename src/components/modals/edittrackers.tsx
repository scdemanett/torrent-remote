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

import React, { useCallback, useContext, useEffect, useMemo } from "react";
import type { ModalState } from "./common";
import { SaveCancelModal, TorrentsNames } from "./common";
import { useForm } from "react-hook-form";
import { useMutateTorrent, useTorrentDetails } from "queries";
import { notifications } from "notifications";
import { ConfigContext } from "config";
import type { TrackerStats } from "rpc/torrent";
import { useServerRpcVersion, useServerSelectedTorrents, useServerTorrentData } from "rpc/torrent";
import { Button } from "components/ui/button";
import { LoadingOverlay } from "components/ui/loader";
import { RhfTextarea } from "components/formfields";

interface FormValues {
    trackerList: string,
}

interface EditTrackersProps extends ModalState {
    /** edit only this torrent instead of every selected one */
    torrentId?: number,
}

export function EditTrackers(props: EditTrackersProps) {
    const rpcVersion = useServerRpcVersion();
    const config = useContext(ConfigContext);
    const serverData = useServerTorrentData();
    const selected = useServerSelectedTorrents();

    const torrentId = useMemo(() => {
        if (props.torrentId !== undefined) return props.torrentId;
        if (serverData.current === undefined || !selected.has(serverData.current)) {
            return [...selected][0];
        }
        return serverData.current;
    }, [props.torrentId, selected, serverData]);

    const targetIds = useMemo(
        () => props.torrentId !== undefined ? [props.torrentId] : [...selected],
        [props.torrentId, selected]);

    const { data: torrent, isPending } = useTorrentDetails(
        torrentId ?? -1, torrentId !== undefined && props.opened, false, true);

    const form = useForm<FormValues>({ defaultValues: { trackerList: "" } });

    const { reset } = form;
    useEffect(() => {
        if (torrent === undefined) return;
        reset({
            trackerList: rpcVersion >= 17
                ? torrent.trackerList
                : torrent.trackerStats.map((s: TrackerStats) => s.announce).join("\n"),
        });
    }, [rpcVersion, reset, torrent]);

    const { mutate } = useMutateTorrent();

    const onSave = useCallback(() => {
        if (torrentId === undefined || torrent === undefined) return;
        const dedupedTrackers: string[] = [];
        for (const tracker of form.getValues("trackerList").split("\n")) {
            if (tracker !== "" && dedupedTrackers.includes(tracker)) continue;
            if (tracker === "" && dedupedTrackers.length === 0) continue;
            if (tracker === "" && dedupedTrackers[dedupedTrackers.length - 1] === "") continue;
            dedupedTrackers.push(tracker);
        }
        let toAdd;
        let toRemove;
        if (rpcVersion < 17) {
            const trackers = dedupedTrackers.filter((s) => s !== "");
            const currentTrackers = Object.fromEntries(
                torrent.trackerStats.map((s: TrackerStats) => [s.announce, s.id]));

            toAdd = trackers.filter((t) => !Object.prototype.hasOwnProperty.call(currentTrackers, t));
            toRemove = (torrent.trackerStats as TrackerStats[])
                .filter((s: TrackerStats) => !trackers.includes(s.announce))
                .map((s: TrackerStats) => s.id as number);
            if (toAdd.length === 0) toAdd = undefined;
            if (toRemove.length === 0) toRemove = undefined;
        }
        mutate(
            {
                torrentIds: targetIds,
                fields: {
                    trackerList: dedupedTrackers.join("\n"),
                    trackerAdd: toAdd,
                    trackerRemove: toRemove,
                },
            },
            {
                onError: (e) => {
                    console.error("Failed to update torrent properties", e);
                    notifications.show({
                        message: "Error updating torrent",
                        color: "red",
                    });
                },
            },
        );
        props.close();
    }, [torrentId, torrent, rpcVersion, mutate, targetIds, form, props]);

    const addDefaultTrackers = useCallback(() => {
        let list = form.getValues("trackerList");
        if (!list.endsWith("\n")) list += "\n";
        list += config.values.interface.defaultTrackers.join("\n");
        form.setValue("trackerList", list);
    }, [config, form]);

    return <>
        {props.opened
            && <SaveCancelModal
                opened={props.opened}
                size="lg"
                onClose={props.close}
                onSave={onSave}
                title="Edit torrent trackers"
                bodyClassName="relative min-h-[25rem]"
            >
                <LoadingOverlay visible={isPending} />
                <div className="grid grid-cols-12 items-center gap-2">
                    <div className="col-span-12">
                        <TorrentsNames torrentIds={props.torrentId !== undefined ? targetIds : undefined} />
                    </div>
                    <div className="col-span-8">
                        Tracker list, one per line, empty line between tiers
                    </div>
                    <div className="col-span-4">
                        <Button onClick={addDefaultTrackers}>Add default list</Button>
                    </div>
                    <div className="col-span-12">
                        <RhfTextarea
                            control={form.control}
                            name="trackerList"
                            minRows={10}
                            maxRows={25}
                            className="resize-y"
                            autoComplete="off"
                            autoCorrect="off"
                            autoCapitalize="off"
                            spellCheck="false"
                        />
                    </div>
                </div>
            </SaveCancelModal>}
    </>;
}
