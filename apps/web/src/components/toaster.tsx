"use client";

import { X } from "lucide-react";
import { useEffect, useRef } from "react";

import { Notice } from "@/components/ui";
import { useToastStore } from "@/stores/toast.store";

/**
 * The toast stack, mounted once in the workspace layout.
 *
 * A manual popover rather than a fixed div. Every dialog in the console is a real `<dialog>`
 * opened with `showModal()`, which lives in the browser's top layer above everything in the
 * document — including a fixed element — so a failure raised from inside a dialog was drawn
 * behind the dialog's own backdrop and never seen. A popover shown while a dialog is open
 * joins the top layer above it, which is the only place a toast can be sure to be seen.
 *
 * `aria-live="polite"` sits on the container rather than on each toast: the region has to
 * exist in the document before a message is added to it, or a screen reader has nothing to
 * watch and announces nothing. Mounting the region empty is the point.
 */
export const Toaster = () => {
  const toasts = useToastStore((store) => store.toasts);
  const dismiss = useToastStore((store) => store.dismiss);
  const region = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = region.current;
    if (el === null || typeof el.showPopover !== "function") return;
    try {
      if (toasts.length > 0 && !el.matches(":popover-open")) el.showPopover();
      if (toasts.length === 0 && el.matches(":popover-open")) el.hidePopover();
    } catch {
      // A browser without the popover API keeps the region as an ordinary fixed element.
    }
  }, [toasts.length]);

  return (
    <div
      ref={region}
      popover="manual"
      aria-live="polite"
      className="pointer-events-none fixed inset-auto right-0 bottom-0 m-0 flex w-full max-w-md flex-col items-end gap-2 border-0 bg-transparent p-4 [&:popover-open]:flex"
    >
      {toasts.map((toast) => (
        <Notice
          key={toast.id}
          tone={toast.tone}
          className="pointer-events-auto w-full max-w-sm shadow-lg"
        >
          <div className="flex items-start justify-between gap-3">
            <span>{toast.message}</span>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss"
              className="-m-1 shrink-0 cursor-pointer p-1 opacity-60 hover:opacity-100"
            >
              <X aria-hidden className="size-3.5" />
            </button>
          </div>
        </Notice>
      ))}
    </div>
  );
};
