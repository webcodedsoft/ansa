"use client";

import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { IconButton } from "@/components/ui";

/**
 * A flow agent's workspace: the canvas is the page, and the rest of the agent is a drawer.
 *
 * A form agent is built in tabs and a flow agent on a drawing, and the two are meant to
 * stand on their own — two ways of building an agent, chosen once, at creation. So a flow
 * author gets the canvas at the width a drawing needs, and every other panel a form agent
 * has — conversation, voice, tools, routing, versions — in a drawer beside it, opened from
 * the header or from a step that needs something set. Nothing is lost between the two:
 * the panels are the same components writing into the same form.
 *
 * The drawer stays mounted while closed, because its panels carry the fields Save and
 * Publish submit, and `Tabs` keeps every panel rendered for the same reason.
 */
export const FlowWorkspace = ({
  open,
  onOpen,
  onClose,
  canvas,
  settings,
}: {
  readonly open: boolean;
  readonly onOpen: () => void;
  readonly onClose: () => void;
  readonly canvas: ReactNode;
  readonly settings: ReactNode;
}) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  void onOpen;

  return (
    <>
      {canvas}

      {/* A backdrop only while open; the panel itself is always in the tree. */}
      {open && (
        <div
          aria-hidden
          className="fixed inset-0 z-40 bg-[rgb(4_10_12/42%)] backdrop-blur-[2px]"
          onClick={onClose}
        />
      )}
      <aside
        role="dialog"
        aria-modal={open}
        aria-label="Agent settings"
        aria-hidden={!open}
        className={
          "glass fixed top-0 right-0 z-50 flex h-screen w-[min(100vw,640px)] flex-col border-l border-[var(--hairline)] shadow-[var(--shadow-l)] transition-transform duration-200 " +
          (open ? "translate-x-0" : "pointer-events-none translate-x-full")
        }
      >
        <div className="flex flex-none items-center gap-3 border-b border-[var(--hairline)] px-5 py-3.5">
          <h2 className="text-[15px] font-semibold tracking-[-0.015em]">Agent settings</h2>
          <p className="text-[12.5px] text-[var(--ink-3)]">Saved and published with the flow.</p>
          <span className="flex-1" />
          <IconButton aria-label="Close settings" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{settings}</div>
      </aside>
    </>
  );
};
