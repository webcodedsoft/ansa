"use client";

import { useEffect, useRef, type ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * A modal, on the platform's own `<dialog>`.
 *
 * The console already had a hand-rolled overlay in the command palette, and copying it would
 * have meant hand-rolling the parts missing from it too: a focus trap, Escape, and making the
 * page behind unreachable by keyboard. `showModal()` supplies all three, puts the dialog in
 * the top layer so no stacking context can bury it, and gives `::backdrop` to style. Every
 * one of those is easy to write badly and impossible to notice being wrong with a mouse.
 *
 * Controls inside may belong to a form elsewhere on the page through the `form` attribute.
 * That still works from the top layer — form ownership is by id, not by ancestry — which is
 * what lets a dialog collect one last field for a form it does not contain.
 */
export const Modal = ({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  readonly open: boolean;
  /** Called for Escape and for a click on the backdrop, as well as for a programmatic close. */
  readonly onClose: () => void;
  readonly title: string;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  /** The actions. Kept out of `children` so they sit on one row against the bottom edge. */
  readonly footer?: ReactNode;
}) => {
  const ref = useRef<HTMLDialogElement>(null);

  /*
   * Deliberately on every render rather than on `[open]`.
   *
   * A `<dialog>` is opened and shut by method call, so the DOM holds a second copy of a state
   * React also holds, and the two can drift — a `close` event that never reaches `onClose`
   * leaves `open` true against a shut dialog, and from then on the button that opens it does
   * nothing at all, silently. Reconciling on every render means any later render repairs it.
   * Both branches are guarded, so the common case is two boolean reads and no work.
   */
  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    // `showModal()` on an open dialog throws, and `close()` on a shut one fires a spurious
    // second `close` event.
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  });

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      /* The backdrop is part of the dialog's own box, so a click landing on the element
         itself rather than on anything inside it is a click outside the panel. */
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      aria-labelledby="modal-title"
      className={cn(
        "m-auto w-[min(100%-2rem,520px)] rounded-xl border border-[var(--hairline)] p-0",
        "bg-[var(--glass-hi)] text-[var(--ink)] shadow-[var(--shadow-l),var(--spec)]",
        "backdrop-blur-[40px] backdrop-saturate-200",
        "backdrop:bg-[rgb(4_10_12/42%)] backdrop:backdrop-blur-[3px]",
        "open:ansa-enter",
      )}
    >
      <div className="p-[18px]">
        <h2 id="modal-title" className="text-[15px] font-[650] tracking-[-0.01em]">
          {title}
        </h2>
        {description !== undefined && (
          <p className="mt-1 max-w-[52ch] text-[12.5px] leading-relaxed text-[var(--ink-3)]">
            {description}
          </p>
        )}
        <div className="mt-3.5">{children}</div>
      </div>
      {footer !== undefined && (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--hairline)] px-[18px] py-3">
          {footer}
        </div>
      )}
    </dialog>
  );
};
