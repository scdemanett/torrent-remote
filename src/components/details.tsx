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

import React, { memo, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Torrent, TrackerStats } from "../rpc/torrent";
import { bytesToHumanReadableStr, ensurePathDelimiter, fileSystemSafeName, secondsToHumanReadableStr, timestampToDateString, torrentProgressbarStyle } from "../trutil";
import { FileTreeTable, useUnwantedFiles } from "./tables/filetreetable";
import { PiecesCanvas } from "./piecescanvas";
import { ProgressBar } from "./progressbar";
import { DateField, LabelsField, StatusField, TrackerField } from "./tables/torrenttable";
import { TrackersTable } from "./tables/trackertable";
import { PeersTable } from "./tables/peerstable";
import { Status, type SessionStatEntry } from "rpc/transmission";
import * as Icon from "react-bootstrap-icons";
import classes from "./details.module.css";
import { CachedFileTree } from "cachedfiletree";
import { useFileTree, useMutateTorrent, useSessionStats, useTorrentDetails } from "queries";
import { ConfigContext } from "config";
import { useResizeObserver } from "hooks";
import { MemoSectionsContextMenu, getSectionsMap } from "./sectionscontextmenu";
import { useContextMenu } from "./contextmenu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { LoadingOverlay } from "./ui/loader";
import type { ModalCallbacks } from "./modals/servermodals";

interface DetailsProps {
    torrentId?: number,
    updates: boolean,
    modals: React.RefObject<ModalCallbacks | null>,
}

function DownloadBar(props: { torrent: Torrent }) {
    let prefix = "";
    let percent = props.torrent.percentDone as number;
    if (props.torrent.status === Status.verifying) {
        prefix = "Verified";
        percent = props.torrent.recheckProgress;
    } else if (props.torrent.status === Status.downloading && props.torrent.pieceCount === 0) {
        prefix = "Downloading metadata";
        percent = props.torrent.metadataPercentComplete;
    } else if (props.torrent.status === Status.stopped) {
        prefix = "Stopped";
    } else {
        prefix = "Downloaded";
    }

    const config = useContext(ConfigContext);
    const now = Math.floor(percent * 1000);
    const nowStr = `${prefix}: ${now / 10}%`;
    const progressbarStyle = torrentProgressbarStyle(props.torrent, config);

    return (
        <div className="my-2 w-full">
            <ProgressBar
                key={props.torrent.hashString}
                now={now}
                max={1000}
                label={nowStr}
                {...progressbarStyle}
            />
        </div>
    );
}

interface DetailItemProps extends React.PropsWithChildren {
    name: string,
}

function DetailItem({ name, children }: DetailItemProps) {
    return (
        <div className={classes.detailItemCol}>
            <div className="flex">
                <div className={classes.detailItemLabel}>{name}</div>
                {children}
            </div>
        </div>
    );
}

function Wasted(props: { torrent: Torrent }) {
    const hashfails = props.torrent.pieceSize > 0 ? props.torrent.corruptEver / props.torrent.pieceSize : 0;
    return <>{`${bytesToHumanReadableStr(props.torrent.corruptEver)} (${hashfails} hashfails)`}</>;
}

function DownloadSpeed(props: { torrent: Torrent }) {
    const secondsDownloading = props.torrent.secondsDownloading;
    const speed = `${bytesToHumanReadableStr(props.torrent.rateDownload)}/s`;
    if (secondsDownloading > 0) {
        return <>{`${speed} (average: ${bytesToHumanReadableStr(props.torrent.downloadedEver / secondsDownloading)}/s)`}</>;
    } else {
        return <>{speed}</>;
    }
}

function SpeedLimit(props: { torrent: Torrent, field: "download" | "upload" }) {
    const limited = props.field === "download" ? props.torrent.downloadLimited : props.torrent.uploadLimited;
    if (limited !== true) return <>-</>;
    const limit = props.field === "download" ? props.torrent.downloadLimit : props.torrent.uploadLimit;
    if (limit < 0) return <>∞</>;
    return <>{`${bytesToHumanReadableStr(limit * 1024)}/s`}</>;
}

function Seeds(props: { torrent: Torrent }) {
    const sending = props.torrent.peersSendingToUs as number;
    const totalSeeds = props.torrent.cachedSeedsTotal;
    if (totalSeeds < 0) {
        return <>{sending}</>;
    } else {
        return <>{`${sending} of ${totalSeeds} connected`}</>;
    }
}

function Peers(props: { torrent: Torrent }) {
    const getting = props.torrent.peersGettingFromUs as number;
    const totalPeers = props.torrent.cachedPeersTotal;
    if (totalPeers < 0) {
        return <>{getting}</>;
    } else {
        return <>{`${getting} of ${totalPeers} connected`}</>;
    }
}

function TrackerUpdate(props: { torrent: Torrent }) {
    const config = useContext(ConfigContext);
    if (props.torrent.trackerStats.length === 0) return <></>;
    const tracker = props.torrent.trackerStats[0] as TrackerStats;
    const state = tracker.announceState;
    return <>{(state === 2 || state === 3) ? "-" : timestampToDateString(tracker.nextAnnounceTime, config)}</>;
}

function DetailsGrid({ columns, children, gridRef }: React.PropsWithChildren<{
    columns: number,
    gridRef: React.RefObject<HTMLDivElement | null>,
}>) {
    return (
        <div className="px-2">
            <div
                ref={gridRef}
                className={`my-1.5 grid gap-x-2 ${classes.grid}`}
                style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
            >
                {children}
            </div>
        </div>
    );
}

function TransferTable(props: { torrent: Torrent }) {
    const seedingTime = secondsToHumanReadableStr(props.torrent.secondsSeeding);
    const shareRatio = `${(props.torrent.uploadRatio as number).toFixed(5)} ${seedingTime !== "" ? `(${seedingTime})` : ""}`;

    const [ref, rect] = useResizeObserver<HTMLDivElement>();

    return (
        <DetailsGrid gridRef={ref} columns={rect.width > 850 ? 3 : 1}>
            <DetailItem name="Status:"><StatusField {...props} fieldName="status" /></DetailItem>
            <DetailItem name="Error:">{props.torrent.cachedError}</DetailItem>
            <DetailItem name="Remaining:">{`${secondsToHumanReadableStr(props.torrent.eta)} (${bytesToHumanReadableStr(props.torrent.leftUntilDone)})`}</DetailItem>
            <DetailItem name="Downloaded:">{bytesToHumanReadableStr(props.torrent.downloadedEver)}</DetailItem>
            <DetailItem name="Uploaded:">{bytesToHumanReadableStr(props.torrent.uploadedEver)}</DetailItem>
            <DetailItem name="Wasted:"><Wasted {...props} /></DetailItem>
            <DetailItem name="Download speed:"><DownloadSpeed {...props} /></DetailItem>
            <DetailItem name="Upload speed:">{`${bytesToHumanReadableStr(props.torrent.rateUpload)}/s`}</DetailItem>
            <DetailItem name="Share ratio:">{shareRatio}</DetailItem>
            <DetailItem name="Download limit:"><SpeedLimit {...props} field="download" /></DetailItem>
            <DetailItem name="Upload limit:"><SpeedLimit {...props} field="upload" /></DetailItem>
            <DetailItem name="Bandwidth group:">{props.torrent.group}</DetailItem>
            <DetailItem name="Seeds:"><Seeds {...props} /></DetailItem>
            <DetailItem name="Peers:"><Peers {...props} /></DetailItem>
            <DetailItem name="Max peers:">{props.torrent.maxConnectedPeers}</DetailItem>
            <DetailItem name="Tracker:"><TrackerField {...props} fieldName="trackerStats" /></DetailItem>
            <DetailItem name="Tracker update on:"><TrackerUpdate {...props} /></DetailItem>
            <DetailItem name="Last active:"><DateField {...props} fieldName="activityDate" /></DetailItem>
        </DetailsGrid>
    );
}

function TotalSize(props: { torrent: Torrent }) {
    if (props.torrent.totalSize <= 0) return <>?</>;
    const size = bytesToHumanReadableStr(props.torrent.totalSize);
    const done = bytesToHumanReadableStr(props.torrent.sizeWhenDone - props.torrent.leftUntilDone);
    return <>{`${size} (${done} done)`}</>;
}

function Pieces(props: { torrent: Torrent }) {
    if (props.torrent.totalSize <= 0) return <>?</>;
    const pieceSize = bytesToHumanReadableStr(props.torrent.pieceSize);
    let have = 0;
    if (props.torrent.totalSize === props.torrent.haveValid) {
        have = props.torrent.pieceCount;
    } else {
        have = props.torrent.haveValid / (props.torrent.pieceSize > 0 ? props.torrent.pieceSize : 1);
    }

    return <>{`${props.torrent.pieceCount as number} x ${pieceSize} (have ${Math.round(have)})`}</>;
}

const httpRe = /https?:\/\//;
const urlRe = /(https?:\/\/[^\s]+)/;

function Urlize(props: { text: string }) {
    if (!httpRe.test(props.text)) return <>{props.text}</>;
    const matches = props.text.split(urlRe).filter((match) => match.length > 0);
    return <>
        {matches.map((match, index) => {
            if (!httpRe.test(match)) return <span key={index}>{match}</span>;
            return <a
                key={index}
                href={match}
                target="_blank"
                rel="noreferrer"
            >
                {match}
            </a>;
        })}
    </>;
}

function ReadonlyInput({ value }: { value: string }) {
    return (
        <input
            className={classes.readonlyInput}
            readOnly
            value={value}
            autoComplete="off"
            spellCheck="false"
        />
    );
}

function TorrentDetails(props: { torrent: Torrent }) {
    const config = useContext(ConfigContext);

    const fullPath = ensurePathDelimiter(props.torrent.downloadDir) + fileSystemSafeName(props.torrent.name);

    const [ref, rect] = useResizeObserver<HTMLDivElement>();

    return (
        <DetailsGrid gridRef={ref} columns={rect.width > 850 ? 2 : 1}>
            <DetailItem name="Full path:">
                <ReadonlyInput value={fullPath} />
            </DetailItem>
            <DetailItem name="Created:">
                <div>
                    <span>
                        {props.torrent.dateCreated > 0
                            ? timestampToDateString(props.torrent.dateCreated, config)
                            : ""}
                    </span>
                    <span>
                        {(props.torrent.creator === undefined || props.torrent.creator === "")
                            ? ""
                            : ` by ${props.torrent.creator as string}`}
                    </span>
                </div>
            </DetailItem>
            <DetailItem name="Total size:"><TotalSize {...props} /></DetailItem>
            <DetailItem name="Pieces:"><Pieces {...props} /></DetailItem>
            <DetailItem name="Hash:">
                <ReadonlyInput value={props.torrent.hashString} />
            </DetailItem>
            <DetailItem name="Comment:"><Urlize text={props.torrent.comment} /></DetailItem>
            <DetailItem name="Added on:"><DateField {...props} fieldName="addedDate" /></DetailItem>
            <DetailItem name="Completed on:"><DateField {...props} fieldName="doneDate" /></DetailItem>
            <DetailItem name="Magnet link:">
                <ReadonlyInput value={props.torrent.magnetLink} />
            </DetailItem>
            <DetailItem name="Labels:"><LabelsField {...props} fieldName="labels" /></DetailItem>
        </DetailsGrid>
    );
}

function TableNameRow(props: { children: React.ReactNode }) {
    return (
        <div className="flex">
            <div className={`flex-grow px-2 ${classes.tableNameRowBox}`}>
                {props.children}
            </div>
        </div>
    );
}

function GeneralPane(props: { torrent: Torrent }) {
    return (
        <div className="flex h-full w-full flex-col">
            <div className="px-2">
                <DownloadBar {...props} />
            </div>
            <div style={{ flexGrow: 1 }}>
                <div className="scrollable">
                    <div className="px-2">
                        <TableNameRow>Transfer</TableNameRow>
                        <TransferTable {...props} />
                        <TableNameRow>Torrent</TableNameRow>
                        <TorrentDetails {...props} />
                    </div>
                </div>
            </div>
        </div>
    );
}

function FileTreePane(props: { torrent: Torrent }) {
    const fileTree = useMemo(
        () => new CachedFileTree(props.torrent.hashString, props.torrent.id),
        [props.torrent.hashString, props.torrent.id]);

    const { data, refetch } = useFileTree("filetree", fileTree);

    useEffect(() => {
        if (fileTree.initialized) {
            fileTree.update(props.torrent);
        } else {
            fileTree.parse(props.torrent, false);
        }
        void refetch();
    }, [props.torrent, fileTree, refetch]);

    const { mutate } = useMutateTorrent();

    const onCheckboxChange = useUnwantedFiles(fileTree, true);
    const updateUnwanted = useCallback((entryPath: string, state: boolean) => {
        onCheckboxChange(entryPath, state);
        mutate({
            torrentIds: [props.torrent.id],
            fields: { [state ? "files-wanted" : "files-unwanted"]: fileTree.getChildFilesIndexes(entryPath) },
        });
    }, [fileTree, mutate, onCheckboxChange, props.torrent.id]);

    return <FileTreeTable
        fileTree={fileTree}
        data={data}
        downloadDir={props.torrent.downloadDir}
        onCheckboxChange={updateUnwanted}
    />;
}

function Stats(props: { stats: SessionStatEntry }) {
    return <table className={`mb-1.5 ${classes.statsTable}`}>
        <tbody>
            <tr>
                <td style={{ width: "10em" }}>Downloaded</td>
                <td>{bytesToHumanReadableStr(props.stats.downloadedBytes)}</td>
            </tr>
            <tr>
                <td>Uploaded</td>
                <td>{bytesToHumanReadableStr(props.stats.uploadedBytes)}</td>
            </tr>
            <tr>
                <td>Ratio</td>
                <td>
                    {props.stats.downloadedBytes === 0
                        ? "∞"
                        : (props.stats.uploadedBytes / props.stats.downloadedBytes).toFixed(2)}
                </td>
            </tr>
            <tr>
                <td>Files added</td>
                <td>{props.stats.filesAdded}</td>
            </tr>
            <tr>
                <td>Active</td>
                <td>{secondsToHumanReadableStr(props.stats.secondsActive)}</td>
            </tr>
            {props.stats.sessionCount > 1
                && <tr>
                    <td>Sesssion count</td>
                    <td>{props.stats.sessionCount}</td>
                </tr>}
        </tbody>
    </table>;
}

function ServerStats() {
    const { data: sessionStats } = useSessionStats(true);

    return (
        <div className="flex h-full w-full flex-col">
            <div style={{ flexGrow: 1 }}>
                <div className="scrollable">
                    {sessionStats !== undefined
                        ? <div className="px-2">
                            <TableNameRow>Session</TableNameRow>
                            <Stats stats={sessionStats["current-stats"]} />
                            <TableNameRow>Cumulative</TableNameRow>
                            <Stats stats={sessionStats["cumulative-stats"]} />
                        </div>
                        : <></>}
                </div>
            </div>
        </div>
    );
}

const DetailsPanels = React.memo(function DetailsPanels({ torrent, modals }: {
    torrent: Torrent | undefined,
    modals: React.RefObject<ModalCallbacks | null>,
}) {
    return (<>
        <TabsContent value="General" className="h-full">
            {torrent !== undefined
                ? <GeneralPane torrent={torrent} />
                : <></>}
        </TabsContent>
        <TabsContent value="Files" className="h-full">
            {torrent !== undefined
                ? <FileTreePane torrent={torrent} />
                : <></>}
        </TabsContent>
        <TabsContent value="Pieces" className="h-full">
            {torrent !== undefined
                ? <PiecesCanvas torrent={torrent} />
                : <></>}
        </TabsContent>
        <TabsContent value="Peers" className="h-full">
            {torrent !== undefined
                ? <PeersTable torrent={torrent} />
                : <></>}
        </TabsContent>
        <TabsContent value="Trackers" className="h-full">
            {torrent !== undefined
                ? <TrackersTable torrent={torrent} modals={modals} />
                : <></>}
        </TabsContent>
        <TabsContent value="Server statistics" className="h-full">
            <ServerStats />
        </TabsContent>
    </>);
});

function DetailsTab({ value, disabled, order, icon, children }: React.PropsWithChildren<{
    value: string,
    disabled?: boolean,
    order: number,
    icon: React.ReactNode,
}>) {
    return (
        <TabsTrigger
            value={value}
            disabled={disabled}
            className={classes.tabsTab}
            style={{ order }}
        >
            <span className="flex items-center gap-2">
                {icon}
                {children}
            </span>
        </TabsTrigger>
    );
}

function Details(props: DetailsProps) {
    const config = useContext(ConfigContext);
    const peersTableVisibility = config.getTableColumnVisibility("peers");
    const countryVisible = peersTableVisibility.country ?? true;

    const { data: fetchedTorrent, isPending } = useTorrentDetails(
        props.torrentId ?? -1, props.torrentId !== undefined && props.updates, countryVisible);

    const [torrent, setTorrent] = useState<Torrent>();

    useEffect(() => {
        if (props.torrentId === undefined) setTorrent(undefined);
        else if (fetchedTorrent !== undefined) setTorrent(fetchedTorrent);
    }, [fetchedTorrent, props.torrentId]);

    const [tabs, setTabs] = useState(config.values.interface.detailsTabs);
    const [tabsMap, setTabsMap] = useState(getSectionsMap(tabs));

    useEffect(() => {
        config.values.interface.detailsTabs = tabs;
        setTabsMap(getSectionsMap(tabs));
    }, [config, tabs]);

    const defaultTab = useMemo(() => {
        return tabs.find((tab) => tab.visible)?.section ?? "";
    }, [tabs]);

    const [info, setInfo, handler] = useContextMenu();

    return (
        <Tabs
            defaultValue={defaultTab}
            className={`h-full w-full ${classes.tabsRoot}`}
        >
            <TabsList className={`px-1.5 pt-1 ${classes.tabsList}`} onContextMenu={handler}>
                <MemoSectionsContextMenu
                    sections={tabs}
                    setSections={setTabs}
                    contextMenuInfo={info}
                    setContextMenuInfo={setInfo}
                />
                {tabs[tabsMap.General].visible
                    && <DetailsTab
                        value="General"
                        disabled={torrent === undefined}
                        order={tabsMap.General}
                        icon={<Icon.InfoCircle size="1.1rem" />}
                    >
                        General
                    </DetailsTab>}
                {tabs[tabsMap.Files].visible
                    && <DetailsTab
                        value="Files"
                        disabled={torrent === undefined}
                        order={tabsMap.Files}
                        icon={<Icon.Files size="1.1rem" />}
                    >
                        {`Files${torrent !== undefined ? ` (${torrent.files.length as number})` : ""}`}
                    </DetailsTab>}
                {tabs[tabsMap.Pieces].visible
                    && <DetailsTab
                        value="Pieces"
                        disabled={torrent === undefined}
                        order={tabsMap.Pieces}
                        icon={<Icon.Grid3x2 size="1.1rem" />}
                    >
                        {`Pieces${torrent !== undefined ? ` (${torrent.pieceCount as number})` : ""}`}
                    </DetailsTab>}
                {tabs[tabsMap.Peers].visible
                    && <DetailsTab
                        value="Peers"
                        disabled={torrent === undefined}
                        order={tabsMap.Peers}
                        icon={<Icon.People size="1.1rem" />}
                    >
                        Peers
                    </DetailsTab>}
                {tabs[tabsMap.Trackers].visible
                    && <DetailsTab
                        value="Trackers"
                        disabled={torrent === undefined}
                        order={tabsMap.Trackers}
                        icon={<Icon.Wifi size="1.1rem" />}
                    >
                        Trackers
                    </DetailsTab>}
                {tabs[tabsMap["<spacer>"]].visible
                    && <div style={{ flexGrow: 1, order: tabsMap["<spacer>"] }} />}
                {tabs[tabsMap["Server statistics"]].visible
                    && <DetailsTab
                        value="Server statistics"
                        order={tabsMap["Server statistics"]}
                        icon={<Icon.ArrowDownUp size="1.1rem" />}
                    >
                        Server statistics
                    </DetailsTab>}
            </TabsList>
            <div style={{ flexGrow: 1, position: "relative", minHeight: 0 }}>
                <LoadingOverlay
                    visible={props.torrentId !== undefined && isPending}
                    loaderSize="3rem"
                    className="bg-background/35"
                />
                <DetailsPanels torrent={torrent} modals={props.modals} />
            </div>
        </Tabs>
    );
}

export const MemoizedDetails = memo(Details) as typeof Details;
