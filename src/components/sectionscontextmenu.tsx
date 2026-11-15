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

import type { SectionsVisibility } from "config";
import React, { useCallback } from "react";
import type { ContextMenuInfo } from "./contextmenu";
import { ContextMenu, MenuDraggableRow, MenuItem, MenuSpacer } from "./contextmenu";
import type { DropResult } from "@hello-pangea/dnd";
import { DragDropContext, Draggable } from "@hello-pangea/dnd";
import { reorderElements } from "trutil";
import { StrictModeDroppable } from "./strictmodedroppable";
import * as Icon from "react-bootstrap-icons";

export function getSectionsMap<S extends string>(sections: SectionsVisibility<S>) {
    return Object.fromEntries(sections.map((section, index) => [section.section, index])) as Record<S, number>;
}

function SectionsContextMenu<S extends string>(props: React.PropsWithChildren<{
    sections: SectionsVisibility<S>,
    setSections: React.Dispatch<SectionsVisibility<S>>,
    contextMenuInfo: ContextMenuInfo,
    setContextMenuInfo: (i: ContextMenuInfo) => void,
    onSectionItemMouseEnter?: React.MouseEventHandler<HTMLDivElement>,
}>) {
    const { setSections } = props;

    const onSectionMenuItemClick = useCallback((index: number) => {
        const sections = [...props.sections];
        sections[index].visible = !sections[index].visible;
        setSections(sections);
    }, [props.sections, setSections]);

    const onDragEnd = useCallback((result: DropResult) => {
        if (result.destination != null) {
            const sections = reorderElements(props.sections, result.source.index, result.destination.index);
            setSections(sections);
        }
    }, [props.sections, setSections]);

    return (
        <ContextMenu
            contextMenuInfo={props.contextMenuInfo}
            setContextMenuInfo={props.setContextMenuInfo}
            closeOnItemClick={false}
        >
            <DragDropContext onDragEnd={onDragEnd}>
                <StrictModeDroppable droppableId="filterscontextmenu">
                    {(provided) => (
                        <div ref={provided.innerRef} {...provided.droppableProps}>
                            {props.sections.map((section, index) => {
                                return (
                                    <Draggable draggableId={section.section} index={index} key={section.section}>
                                        {(provided) => (
                                            <MenuDraggableRow provided={provided} onMouseEnter={props.onSectionItemMouseEnter}>
                                                <MenuItem
                                                    className="flex-grow"
                                                    leftSection={section.visible ? <Icon.Check size="1rem" /> : <MenuSpacer />}
                                                    onClick={() => { onSectionMenuItemClick(index); }}
                                                >
                                                    {section.section}
                                                </MenuItem>
                                                <div {...provided.dragHandleProps} className="pr-1 text-muted-foreground">
                                                    <Icon.GripVertical size="12" />
                                                </div>
                                            </MenuDraggableRow>
                                        )}
                                    </Draggable>
                                );
                            })}
                            {provided.placeholder}
                        </div>
                    )}
                </StrictModeDroppable>
            </DragDropContext>
            {props.children}
        </ContextMenu>
    );
}

export const MemoSectionsContextMenu = React.memo(SectionsContextMenu) as typeof SectionsContextMenu;
