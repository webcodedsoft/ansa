"use client";

import { KeyRound, TriangleAlert } from "lucide-react";
import { startTransition, useActionState, useState } from "react";

import { Button, ConfirmDialog, Modal, Notice, SubmitButton } from "@/components/ui";
import { idleForm } from "@/lib/form-state";

import { rotateWebhook, type RotateWebhookState } from "../connect.actions";
import type { ClaimWebhook } from "../connect.service";

const START: RotateWebhookState = idleForm();

/** How long the copy button admits to having copied before it offers to do it again. */
const FLASH_MS = 2000;

type CopyOutcome = "idle" | "copied" | "failed";

const COPY_LABEL: Record<CopyOutcome, string> = {
  idle: "Copy",
  copied: "Copied",
  failed: "Copy failed",
};

/**
 * Bring a number you already hold — as a dialog.
 *
 * Nothing here asks which number is being imported, and that absence is the whole mechanism.
 * Only the holder of a number can decide where its calls are sent, so pointing that number's
 * voice webhook at this URL and then dialling it is itself the proof — the arriving call
 * carries the number, and the secret in the URL says which organisation to attach it to. A
 * form that took a number typed in by hand would be attaching a line somebody else controls
 * at their carrier, on nothing but their word for it.
 *
 * That makes the URL a bearer secret rather than an address, which is why it is shown with
 * what it can do and with a rotation beside it. The first URL is minted on request, so an
 * organisation that never imports a number never holds a secret that could leak.
 */
export const BringYourOwnModal = ({
  open,
  onClose,
  webhook,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly webhook: ClaimWebhook;
}) => {
  const [state, action, pending] = useActionState(rotateWebhook, START);
  const [asking, setAsking] = useState(false);
  const [copied, setCopied] = useState<CopyOutcome>("idle");
  /* Whether a URL existed when this opened, captured once: `url` below is the result of the
     action, so it is non-null the moment a first URL is created — which would make the
     confirmation of that creation read "Rotated". */
  const [hadUrl] = useState(webhook.url !== null);

  // The prop and the action agree after a rotation, but this is the one value where being one
  // version behind means handing somebody a secret that no longer works, so it is read from
  // the answer that produced it rather than from around it.
  const url = state.status === "succeeded" && state.data !== null ? state.data.url : webhook.url;

  const flash = (outcome: CopyOutcome) => {
    setCopied(outcome);
    window.setTimeout(() => setCopied("idle"), FLASH_MS);
  };

  const copy = () => {
    if (url === null) return;
    void navigator.clipboard.writeText(url).then(
      () => flash("copied"),
      // Refused outside a secure context and under some browser policies. Saying so beats a
      // caller walking away believing they hold a URL they do not.
      () => flash("failed"),
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Bring a number you already hold"
      description="Point its voice webhook at this URL and call it once. The call is the proof — nothing is typed in, no carrier password is shared."
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <form
            action={action}
            onSubmit={(event) => {
              /* Only when there is something to break. Creating the first URL destroys
                 nothing, and a confirmation asking whether to rotate would be asking about
                 the wrong act. */
              if (url === null) return;
              event.preventDefault();
              setAsking(true);
            }}
          >
            {webhook.addressable && (
              <SubmitButton pending={pending} idle={url === null ? "Create the import URL" : "Rotate the URL"} variant={url === null ? "primary" : "ghost"} />
            )}
          </form>
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
        </div>
      }
    >
      <ConfirmDialog
        open={asking}
        onClose={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false);
          startTransition(() => action(new FormData()));
        }}
        title="Rotate the import URL?"
        confirmLabel="Rotate it"
        cancelLabel="Keep the current one"
        pending={pending}
      >
        The current URL stops working immediately. Every carrier still pointing at it stops
        reaching this organisation until you move it onto the new one.
      </ConfirmDialog>

      <div className="flex flex-col gap-4">
        {state.status === "failed" && <Notice tone="error">{state.message}</Notice>}
        {state.status === "succeeded" && (
          <Notice tone="ok">
            {hadUrl
              ? "Rotated. The previous URL stopped answering — move every carrier onto this one now."
              : "Created. Point a carrier at this URL and call the number once."}
          </Notice>
        )}
        {!webhook.addressable && (
          <Notice tone="warn">
            This deployment has no public address configured, so there is no URL for a carrier
            to send calls to. Ask whoever operates it to set one before importing a number.
          </Notice>
        )}

        {url === null ? (
          <p className="m-0 rounded-lg border border-dashed border-[var(--hairline)] px-3.5 py-3 text-[12.5px] leading-relaxed text-[var(--ink-3)]">
            No import URL yet. Create one when you are ready to point a carrier at it — until then
            this organisation holds no secret that could be leaked.
          </p>
        ) : (
          <div className="flex items-center gap-2 rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)] px-3 py-2.5">
            <KeyRound aria-hidden className="size-4 flex-none text-[var(--ink-3)]" />
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--ink-2)]" title={url}>
              {url}
            </span>
            <Button size="sm" onClick={copy}>
              {COPY_LABEL[copied]}
            </Button>
          </div>
        )}

        <ol className="m-0 flex list-decimal flex-col gap-1.5 pl-5 text-[13px] text-[var(--ink-2)]">
          <li>Open the number&apos;s voice settings at your carrier.</li>
          <li>Set the webhook to this URL, sent as {webhook.method}.</li>
          <li>Call the number once. It appears on this page.</li>
        </ol>

        <div className="flex items-start gap-2.5 rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)] px-3.5 py-3 text-[12.5px] text-[var(--ink-2)]">
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 flex-none text-[var(--ink-3)]" />
          <span>Treat the URL as a password. Rotate it if it has been anywhere else.</span>
        </div>
      </div>
    </Modal>
  );
};
