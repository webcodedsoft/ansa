"use client";

import { useActionState, useState } from "react";

import { Button, CONTROL, Notice, Row, Stack, SubmitButton } from "@/components/ui";
import { cn } from "@/lib/cn";
import { idleForm } from "@/lib/form-state";

import { correctTranscript, type CorrectionState } from "../calls.actions";
import type { CallTranscript } from "../calls.service";
import { isUncertain } from "./needs-a-look";

const START: CorrectionState = idleForm();

/**
 * One thing the caller said, and the means to say what they actually said.
 *
 * The editor is collapsed by default. Reading a call is the common action and correcting a
 * line is the rare one, so a textarea under every line would turn a transcript into a form
 * and make the call harder to read for the sake of the thing you mostly are not doing.
 */
export const TranscriptLine = ({
  callId,
  transcript,
}: {
  readonly callId: string;
  readonly transcript: CallTranscript;
}) => {
  const [state, action, pending] = useActionState(correctTranscript, START);
  const [editing, setEditing] = useState(false);

  const verdict = state.data;
  const settled = transcript.correctedText !== null || verdict !== null;
  const corrected = verdict?.text ?? transcript.correctedText;
  const changed = verdict?.changed ?? (corrected !== null && corrected !== transcript.text);
  const uncertain = isUncertain(transcript);

  return (
    <div className="group">
      <div className="leading-relaxed">
        {/* When a correction exists the original is struck through rather than replaced.
            What the transcriber heard is the evidence; hiding it would leave the record
            looking as though it had been right all along. */}
        {changed ? (
          <>
            <span className="text-[var(--ink-3)] line-through">{transcript.text}</span>{" "}
            <span>{corrected}</span>
          </>
        ) : (
          transcript.text
        )}
      </div>

      {/* The chrome under a line is for the lines that need it.
       *
       * Every caller line used to carry the provider's name, its confidence to three places
       * and a Correct button — forty rows of "deepgram · confidence 1.000 · Correct" under a
       * conversation somebody was trying to read. The provider is evaluation data and lives
       * on Diagnostics. Confidence is shown when it is low, because that is when it is
       * information; a line that came back at 1.000 says nothing by saying so. The control to
       * correct a line is always reachable — it appears when the line is hovered or focused —
       * and always visible on a line the agent itself would have doubted. */}
      {!editing && (
        <div
          className={cn(
            "flex flex-wrap items-center gap-2 text-xs text-[var(--ink-3)]",
            /* Collapsed, not faded: a faded row still holds its height, and a one-word bubble
               with a blank line under it looks like something failed to render. The button
               stays in the tab order while collapsed, and focusing it opens the row. */
            uncertain || settled
              ? "mt-1"
              : "max-h-0 overflow-hidden transition-[max-height,margin] group-hover:mt-1 group-hover:max-h-8 group-focus-within:mt-1 group-focus-within:max-h-8",
          )}
        >
          {uncertain && !settled && (
            <span className="text-[var(--warn)]">heard at {Number(transcript.confidence).toFixed(2)} confidence</span>
          )}
          {settled && !changed && <span>reviewed, correct</span>}
          <Button variant="ghost" onClick={() => setEditing(true)} className="text-xs">
            {settled ? "Change verdict" : uncertain ? "Correct this" : "Correct"}
          </Button>
        </div>
      )}

      {editing && (
        <form action={action} className="mt-2">
          <Stack gap="sm">
            <input type="hidden" name="callId" value={callId} />
            <input type="hidden" name="transcriptId" value={transcript.id} />
            <textarea
              name="correctedText"
              defaultValue={corrected ?? transcript.text}
              aria-label="What was actually said"
              className={cn(CONTROL, "min-h-14 resize-y leading-relaxed")}
            />
            <p className="text-xs text-[var(--ink-3)]">
              Submitting these words unchanged records that the transcriber got it right.
              That is a verdict too.
            </p>
            <Row>
              <SubmitButton pending={pending} idle="Save" />
              <Button onClick={() => setEditing(false)} disabled={pending}>
                Cancel
              </Button>
            </Row>
            {(state.status === "failed" || state.status === "invalid") && (
              <Notice tone="error">{state.fieldErrors["correctedText"] ?? state.message}</Notice>
            )}
          </Stack>
        </form>
      )}
    </div>
  );
};
