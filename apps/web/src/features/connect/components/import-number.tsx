"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { Button, Card, Notice, Stack, SubmitButton } from "@/components/ui";
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
 * Import a number this organisation already holds, by proving it holds it.
 *
 * Nothing here asks which number is being imported, and that absence is the whole mechanism.
 * Only the holder of a number can decide where its calls are sent, so pointing that number's
 * voice webhook at this URL and then dialling it is itself the proof — the arriving call
 * carries the number, and the secret in the URL says which organisation to attach it to. A
 * form that took a number typed in by hand would be attaching a line somebody else controls
 * at their carrier, on nothing but their word for it.
 *
 * That makes the URL a bearer secret rather than an address, which is why it is not simply
 * printed as a field: it is shown with what it can do, and with a rotation next to it.
 */
export const ImportNumber = ({ webhook }: { readonly webhook: ClaimWebhook }) => {
  const [state, action, pending] = useActionState(rotateWebhook, START);
  const [copied, setCopied] = useState<CopyOutcome>("idle");
  /* Whether a URL existed when this screen was opened, captured once and never updated.
     `url` below is the *result* of the action, so it is non-null the moment a first URL is
     created — which would make the confirmation of that creation read "Rotated". What the
     reader needs to know is which act they just performed, and only the state before it
     answers that. */
  const [hadUrl] = useState(webhook.url !== null);

  // The prop and the action agree after a rotation — `revalidatePath` re-renders this page
  // in the same response — but this is the one value on the screen where being one version
  // behind means handing somebody a secret that no longer works, so it is read from the
  // answer that produced it rather than from around it.
  const url = state.status === "succeeded" && state.data !== null ? state.data.url : webhook.url;

  const flash = (outcome: CopyOutcome) => {
    setCopied(outcome);
    // The label is a confirmation, not a mode. Left reading "Copied" it makes the next copy
    // — of a freshly rotated URL, usually — look as though the button did nothing.
    window.setTimeout(() => setCopied("idle"), FLASH_MS);
  };

  const copy = () => {
    if (url === null) return;
    void navigator.clipboard.writeText(url).then(
      () => flash("copied"),
      // The clipboard is refused outside a secure context and under some browser policies.
      // Saying so beats a caller walking away believing they hold a URL they do not.
      () => flash("failed"),
    );
  };

  return (
    <Card
      title="Import a number you already hold"
      description="Point the number's voice webhook at this URL, then call it once. The call is the proof — no number is typed in and no carrier account details are shared."
    >
      <form
        action={action}
        onSubmit={(event) => {
          /* Only when there is something to break. Creating the first URL destroys nothing, and
             a confirmation asking whether to rotate would be asking about the wrong act. */
          if (url === null) return;
          const confirmed = window.confirm(
            "Rotate the import URL? The current one stops working immediately, and every carrier still pointing at it stops reaching this organisation until you move it.",
          );
          if (!confirmed) event.preventDefault();
        }}
      >
        <Stack>
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

          {/* No URL yet, and nothing is wrong. A secret is only minted when somebody asks for
              one, so an organisation that never imports a number never has one to leak — which
              is the promise migration 0054 makes and the reason this button exists at all. */}
          {webhook.addressable && url === null && (
            <p className="text-[12.5px] leading-relaxed text-[var(--ink-3)]">
              No import URL yet. Create one when you are ready to point a carrier at it — until
              then this organisation holds no secret that could be leaked.
            </p>
          )}

          {url !== null && (
            <div>
              <div className="flex items-start gap-2">
                <p className="min-w-0 flex-1 rounded-md border border-[var(--hairline)] bg-[var(--surface-2)] px-2.5 py-2 font-mono text-[12.5px] break-all">
                  {url}
                </p>
                <Button onClick={copy}>{COPY_LABEL[copied]}</Button>
              </div>
              <p className="mt-1.5 text-[12.5px] text-[var(--ink-3)]">
                Sent as {webhook.method}. Carriers call this the voice webhook, the voice URL or
                the answer URL, depending on whose console you are in.
              </p>
            </div>
          )}

          <div>
            <h3 className="text-[13.5px] font-medium">What to do</h3>
            <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-[12.5px] leading-relaxed text-[var(--ink-3)]">
              <li>Sign in wherever you bought the number and open its voice settings.</li>
              <li>
                Set that number&apos;s voice webhook to the URL above, sent as {webhook.method}.
                Consoles call this different things — the voice webhook, the voice URL, the
                answer URL, or on Twilio the field under &ldquo;A call comes in&rdquo;.
              </li>
              <li>Call the number once from any handset. That call is what proves you hold it.</li>
              <li>
                The number appears in the table above, unrouted. Give it an agent to answer on the{" "}
                <Link href="/agents" className="underline">
                  Agents
                </Link>{" "}
                screen — until then it rings nobody.
              </li>
              <li>
                Repeat with the same URL for every other number you want here. One URL, as many
                numbers as you own.
              </li>
            </ol>

            {/* The failure everybody hits, and the one the screen cannot detect for them: a
                webhook that never reaches us looks identical to a number nobody has called.
                Saying what to check beats leaving somebody refreshing a table. */}
            <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--ink-3)]">
              If the number does not appear after the call, the webhook is not reaching us. Check
              the URL is exact, that it is set as {webhook.method} rather than GET, and that you
              saved it against the number itself and not the account default. Nothing here needs
              your carrier password or account details — only that one setting.
            </p>
          </div>

          <Notice tone="warn">
            Treat this URL as a password. Anyone holding it can attach numbers to this
            organisation, so it belongs in a carrier&apos;s settings and nowhere a person can read
            it. Rotate it if it has been anywhere else — but the new URL only exists once
            rotation is done, and the old one dies the same instant, so have every carrier&apos;s
            settings open first rather than going looking for them afterwards.
          </Notice>

          {/* One button, two jobs, because minting and replacing are the same act — see the
              endpoint. It is only dangerous once there is something to replace, so it changes
              its words and its weight rather than appearing twice. */}
          {webhook.addressable && (
            <div>
              <SubmitButton
                pending={pending}
                variant={url === null ? "primary" : "danger"}
                size="sm"
                idle={url === null ? "Create the import URL" : "Rotate URL"}
                busy={url === null ? "Creating…" : "Rotating…"}
              />
            </div>
          )}
        </Stack>
      </form>
    </Card>
  );
};
