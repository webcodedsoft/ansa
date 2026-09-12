"use client";

import { useRouter } from "next/navigation";
import type { ComponentPropsWithoutRef, KeyboardEvent, MouseEvent } from "react";

import { cn } from "@/lib/cn";

import { Tr } from "./feedback";

/**
 * A table row that opens a page.
 *
 * Every list in the console had one cell that was a link — the number on a call, the name
 * on a person — and a whole row that looked clickable and was not. A row is a big target
 * and a word is a small one; the row should take the click. The link inside stays: it is
 * what a screen reader announces, what a middle-click opens in a new tab, and what a
 * right-click copies.
 *
 * The click is declined when it landed on a control inside the row (a link, a button, a
 * field), when the person was selecting text, and when a modifier was held — Cmd or Ctrl
 * opens the page in a new tab, the way the link itself would. Enter on a focused row opens
 * it too.
 */
export const LinkRow = ({
  href,
  className,
  children,
  ...rest
}: ComponentPropsWithoutRef<"tr"> & { readonly href: string }) => {
  const router = useRouter();

  const open = (event: MouseEvent<HTMLTableRowElement>): void => {
    const target = event.target as HTMLElement;
    if (target.closest("a, button, input, select, textarea, label, [role=button]") !== null) return;
    if ((window.getSelection()?.toString() ?? "") !== "") return;
    if (event.shiftKey || event.altKey) return;
    if (event.metaKey || event.ctrlKey) {
      window.open(href, "_blank", "noopener");
      return;
    }
    router.push(href);
  };

  const key = (event: KeyboardEvent<HTMLTableRowElement>): void => {
    if (event.target !== event.currentTarget || event.key !== "Enter") return;
    event.preventDefault();
    router.push(href);
  };

  return (
    <Tr
      {...rest}
      tabIndex={0}
      onClick={open}
      onKeyDown={key}
      className={cn(
        "cursor-pointer transition-colors hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)] focus-visible:outline-none",
        className,
      )}
    >
      {children}
    </Tr>
  );
};
