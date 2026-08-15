import type { ZodError } from "zod";

/**
 * What every Server Action in this app hands back to its form.
 *
 * One shape rather than three hand-rolled ones, because each form needs the same four
 * answers — did it work, what went wrong overall, what went wrong per field, and what came
 * back — and inventing that separately per feature is how two of them end up unable to show
 * a field error at all.
 *
 * `status` is a discriminant rather than a pair of nullable fields. `error !== null` and
 * `data !== null` can both be false at once, which leaves a form with no way to tell "not
 * submitted yet" from "submitted and the API returned nothing".
 */
export type FormStatus = "idle" | "invalid" | "failed" | "succeeded";

export interface FormState<TData = null> {
  readonly status: FormStatus;
  /** A sentence about the whole submission. Null when there is nothing to say. */
  readonly message: string | null;
  /** Field name to complaint, for the fields a schema or the API rejected. */
  readonly fieldErrors: Readonly<Record<string, string>>;
  readonly data: TData | null;
}

export const idleForm = <TData>(): FormState<TData> => ({
  status: "idle",
  message: null,
  fieldErrors: {},
  data: null,
});

/**
 * The first complaint per field.
 *
 * First rather than all of them: zod reports every failing rule, and a field that is both
 * too short and wrongly formatted does not become clearer by saying so twice. The first
 * issue is the one the schema author put first.
 */
export const fieldErrorsOf = (error: ZodError): Readonly<Record<string, string>> => {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path.map(String).join(".");
    if (field !== "" && errors[field] === undefined) errors[field] = issue.message;
  }
  return errors;
};

/** The submission did not satisfy the schema. Nothing was sent. */
export const invalidForm = <TData>(
  error: ZodError,
  message = "Some of these need another look.",
): FormState<TData> => ({
  status: "invalid",
  message,
  fieldErrors: fieldErrorsOf(error),
  data: null,
});

/** It was sent and the API said no, or the request never arrived. */
export const failedForm = <TData>(message: string): FormState<TData> => ({
  status: "failed",
  message,
  fieldErrors: {},
  data: null,
});

export const succeededForm = <TData>(
  data: TData,
  message: string | null = null,
): FormState<TData> => ({
  status: "succeeded",
  message,
  fieldErrors: {},
  data,
});
