"use server";

import { revalidatePath } from "next/cache";

import { failureMessage, refusedWith } from "@/lib/api/server";
import { failedForm, invalidForm, succeededForm, type FormState } from "@/lib/form-state";

import { correctionSchema, testCallSchema } from "./calls.schema";
import { placeTestCall, recordCorrection } from "./calls.service";

// ---------------------------------------------------------------------------
// Placing a test call
// ---------------------------------------------------------------------------

export interface PlacedCall {
  readonly to: string;
  readonly status: string;
  readonly configVersion: number;
}

export interface TestCallState extends FormState<PlacedCall> {
  /**
   * True when the API refused rather than failed — the consent gate, the do-not-call list,
   * or the hour. Kept apart from an ordinary failure because it is the system working, and
   * showing it in red beside "something went wrong" teaches people to route around it.
   */
  readonly refused: boolean;
}

export const placeCall = async (
  _previous: TestCallState,
  form: FormData,
): Promise<TestCallState> => {
  const parsed = testCallSchema.safeParse({ to: form.get("to") ?? "" });
  if (!parsed.success) return { ...invalidForm<PlacedCall>(parsed.error), refused: false };

  try {
    const result = await placeTestCall(parsed.data);
    revalidatePath("/calls");
    return {
      ...succeededForm<PlacedCall>({
        to: result.to,
        status: result.status,
        configVersion: result.configVersion,
      }),
      refused: false,
    };
  } catch (error) {
    return {
      ...failedForm<PlacedCall>(failureMessage(error)),
      refused: refusedWith(error, 422),
    };
  }
};

// ---------------------------------------------------------------------------
// Reviewing a transcript
// ---------------------------------------------------------------------------

export interface Verdict {
  readonly changed: boolean;
  readonly text: string;
}

export type CorrectionState = FormState<Verdict>;

/**
 * Record what the caller actually said.
 *
 * The ids travel in hidden fields rather than being bound into the action, because one
 * action serves every line on the page and binding would mean a distinct closure — and a
 * distinct server reference — per transcript.
 */
export const correctTranscript = async (
  _previous: CorrectionState,
  form: FormData,
): Promise<CorrectionState> => {
  const parsed = correctionSchema.safeParse({
    callId: form.get("callId") ?? "",
    transcriptId: form.get("transcriptId") ?? "",
    correctedText: form.get("correctedText") ?? "",
  });
  if (!parsed.success) return invalidForm(parsed.error);

  try {
    const result = await recordCorrection(parsed.data);
    revalidatePath(`/calls/${parsed.data.callId}`);
    return succeededForm({ changed: result.changed, text: result.correctedText });
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};
