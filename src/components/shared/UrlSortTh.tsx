"use client";

/**
 * ID 243 — a sortable header cell for a table rendered on the SERVER.
 *
 * A server page cannot hand SortableTh a click handler, so this cell holds the
 * click itself: it writes `?<prefix>sort=<key>&<prefix>dir=asc|desc` into the
 * page link (useUrlTableSort, server mode), the dynamic page renders again, and
 * the page orders its rows from those two parameters (sortRows + makeComparator
 * from tableSortCore, which has no React in it). Same click cycle and arrows as
 * every other table.
 */

import type { SortType } from "./tableSortCore";
import { SortableTh, useUrlTableSort } from "./TableSort";

export default function UrlSortTh({
    label,
    sortKey,
    type,
    prefix,
    align,
    className,
    title,
}: {
    label: string;
    sortKey: string;
    type: SortType;
    prefix?: string;
    align?: "right";
    className?: string;
    title?: string;
}) {
    const { sort, toggle } = useUrlTableSort([{ key: sortKey, type }], { prefix, mode: "server" });
    return (
        <SortableTh
            label={label}
            sortKey={sortKey}
            sort={sort}
            onToggle={toggle}
            align={align}
            className={className}
            title={title}
        />
    );
}
