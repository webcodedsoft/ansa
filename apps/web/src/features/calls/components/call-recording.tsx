"use client";

import { startTransition, useActionState } from "react";

import { Button, Notice } from "@/components/ui";
import { idleForm } from "@/lib/form-state";

import { fetchRecording, type RecordingState } from "../calls.actions";

const START: RecordingState = idleForm();

/**
 * The call, heard.
 *
 * **Nothing is requested until somebody presses play.** The API writes a row to the
 * organisation's audio access log for every link it mints, and that log is what answers "who
 * has heard my call" — filling it with everyone who merely opened the page would make it
 * useless for the one question it exists to answer. So this renders a button, and pressing it
 * is the act being recorded.
 *
 * The link works once and expires in two minutes, which is why the `<audio>` element appears
 * only after one is granted: a re-render would need a second ticket, and asking for one is
 * another line in the log. `preload="auto"` for the same reason — fetch it once, immediately,
 * while the ticket is still good.
 *
 * A call with no audio is the common case rather than an error. Most calls happened when the
 * organisation was not recording, and every recording eventually passes its retention window;
 * the message says which, instead of showing a player that does nothing.
 */
export const CallRecording = ({ callId }: { readonly callId: string }) => {
  const [state, action, pending] = useActionState(fetchRecording, START);
  const link = state.status === "succeeded" ? state.data : null;

  if (link !== null) {
    return (
      <div className="flex flex-col gap-1.5">
        {/* The transcript below is the caption, and unlike a caption track it can be
            corrected — which is the whole point of playing this. */}
        <audio controls autoPlay preload="auto" src={link.url} className="w-full">
          Your browser cannot play this recording.
        </audio>
        <p className="text-[11.5px] text-[var(--ink-3)]">
          {link.bothLegs
            ? "Both voices: the caller on the left channel, the agent on the right."
            : "The caller only. This call was recorded before the agent's own audio was captured."}{" "}
          This link works once and is already spent — press play again for a new one.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          size="sm"
          disabled={pending}
          onClick={() => {
            const form = new FormData();
            form.set("callId", callId);
            startTransition(() => action(form));
          }}
        >
          {pending ? "Fetching…" : "▶ Play the recording"}
        </Button>
      </div>
      {state.status === "failed" && <Notice tone="warn">{state.message}</Notice>}
      {state.status !== "failed" && (
        <p className="text-[11.5px] text-[var(--ink-3)]">
          Listening is recorded against your name, so the person whose voice it is can be told
          who has heard it.
        </p>
      )}
    </div>
  );
};
