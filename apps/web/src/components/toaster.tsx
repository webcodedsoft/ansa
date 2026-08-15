"use client";

import { X } from "lucide-react";

import { Notice } from "@/components/ui";
import { useToastStore } from "@/stores/toast.store";

/**
 * The toast stack, mounted once in the workspace layout.
 *
 * `aria-live="polite"` sits on the container rather than on each toast: the region has to
 * exist in the document before a message is added to it, or a screen reader has nothing to
 * watch and announces nothing. Mounting the region empty is the point.
 */
export const Toaster = () => {
  const toasts = useToastStore((store) => store.toasts);
  const dismiss = useToastStore((store) => store.dismiss);

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end"
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
