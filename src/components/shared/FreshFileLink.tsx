"use client";

// An <a> to a stored file that opens through a fresh 15-minute link on each
// click (tracker ID 166). Usable from server components, which cannot attach
// an onClick themselves. Ctrl/Cmd-click and right-click behave like a normal
// link to the stored path, which still needs a login that may see the file.

import type { AnchorHTMLAttributes, ReactNode } from "react";

import { onFreshFileClick } from "@/lib/storage/freshFileLink";

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
    href: string | null | undefined;
    children?: ReactNode;
};

export default function FreshFileLink({ href, onClick, target = "_blank", rel = "noopener noreferrer", children, ...rest }: Props) {
    return (
        <a
            {...rest}
            href={href ?? undefined}
            target={target}
            rel={rel}
            onClick={(e) => {
                onClick?.(e);
                if (!e.defaultPrevented) onFreshFileClick(e, href);
            }}
        >
            {children}
        </a>
    );
}
