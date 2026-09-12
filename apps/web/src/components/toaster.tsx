"use client";

import { CircleAlert, CircleCheck, Info, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import type { NoticeTone } from "@/components/ui";
import { cn } from "@/lib/cn";
import { useToastStore, type Toast } from "@/stores/toast.store";

/**
 * The toast stack, mounted once in the root layout.
 *
 * A manual popover rather than a fixed div. Every dialog in the console is a real `<dialog>`
 * opened with `showModal()`, which lives in the browser's top layer above everything in the
 * document — including a fixed element — so a failure raised from inside a dialog was drawn
 * behind the dialog's own backdrop and never seen. A popover shown while a dialog is open
 * joins the top layer above it, which is the only place a toast can be sure to be seen.
 *
 * Each toast says what kind of thing it is before what happened: a glyph and a two-word
 * title in the tone's colour, the sentence under it, and a bar draining over the time it
 * stays — so a person can tell at a glance whether to read it now. Solid, not glass: it
 * sits over whatever is behind it and has to be legible on anything.
 *
 * `aria-live="polite"` sits on the container rather than on each toast: the region has to
 * exist in the document before a message is added to it, or a screen reader has nothing to
 * watch and announces nothing. Mounting the region empty is the point.
 */
const KINDS: Record<NoticeTone, { readonly Icon: LucideIcon; readonly title: string; readonly color: string; readonly bar: string }> = {
  ok: { Icon: CircleCheck, title: "Done", color: "text-[var(--ok)]", bar: "bg-[var(--ok)]" },
  error: { Icon: CircleAlert, title: "Something went wrong", color: "text-[var(--bad)]", bar: "bg-[var(--bad)]" },
  warn: { Icon: TriangleAlert, title: "Heads up", color: "text-[var(--warn)]", bar: "bg-[var(--warn)]" },
  info: { Icon: Info, title: "Note", color: "text-[var(--accent)]", bar: "bg-[var(--accent)]" },
};

const ToastCard = ({ toast, onDismiss }: { readonly toast: Toast; readonly onDismiss: () => void }) => {
  const kind = KINDS[toast.tone];
  return (
    <div
      role={toast.tone === "error" ? "alert" : "status"}
      className="ansa-toast pointer-events-auto relative w-full max-w-sm overflow-hidden rounded-xl border border-[var(--hairline)] bg-[var(--surface-solid)] shadow-[var(--shadow-l)]"
    >
      <div className="flex items-start gap-3 px-3.5 py-3">
        <kind.Icon aria-hidden className={cn("mt-0.5 size-[18px] flex-none", kind.color)} />
        <div className="min-w-0 flex-1">
          <div className={cn("text-[12.5px] font-semibold", kind.color)}>{kind.title}</div>
          <div className="mt-0.5 text-[13px] leading-snug text-[var(--ink-2)]">{toast.message}</div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-m-1 flex-none cursor-pointer rounded-md p-1 text-[var(--ink-3)] hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
        >
          <X aria-hidden className="size-3.5" />
        </button>
      </div>
      <div
        aria-hidden
        className={cn("ansa-toast-bar h-[3px] w-full opacity-70", kind.bar)}
        style={{ animationDuration: `${toast.ttlMs}ms` }}
      />
    </div>
  );
};

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
      className="pointer-events-none fixed inset-auto right-0 bottom-0 m-0 flex w-full max-w-md flex-col items-end gap-2.5 border-0 bg-transparent p-4 [&:popover-open]:flex"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
      ))}
    </div>
  );
};
