"use client";

import { useActionState, useState } from "react";

import { Button, CONTROL, Notice, Row, Stack, SubmitButton, Tag } from "@/components/ui";
import { cn } from "@/lib/cn";
import { idleForm } from "@/lib/form-state";

import { correctTranscript, type CorrectionState } from "../calls.actions";
import type { CallTranscript } from "../calls.service";

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

  return (
    <div>
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

      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--ink-3)]">
        <Tag>{transcript.provider}</Tag>
        {transcript.confidence !== null && <span>confidence {transcript.confidence}</span>}
        {settled && !changed && <span>reviewed, correct</span>}
        {!editing && (
          <Button variant="ghost" onClick={() => setEditing(true)} className="text-xs">
            {settled ? "Change verdict" : "Correct"}
          </Button>
        )}
      </div>

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
              <SubmitButton pending={pending} idle="Save" busy="Saving…" />
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
