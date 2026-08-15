"use client";

import { useActionState, useState } from "react";

import { Button, Card, Notice, Row, TextField } from "@/components/ui";
import { idleForm } from "@/lib/form-state";

import { placeTestCallAction, type TestCallState } from "../agents.actions";

const START: TestCallState = idleForm();

/**
 * The proof this whole section exists to produce.
 *
 * `client.config.*` compiling is not the same as a call working — the "done when" rule in
 * `CLAUDE.md` is a phone ringing. This deliberately has no `<form>` of its own: it renders
 * inside the agent workspace, which wraps every tab in one `<form>` so a single publish
 * action can cover fields spread across tabs, and a `<form>` cannot nest inside another one.
 * `useActionState`'s dispatch function does not need a form to be called — building a
 * `FormData` by hand and calling it directly from a plain button works the same way.
 */
export const TestCallCard = () => {
  const [state, dispatch, pending] = useActionState(placeTestCallAction, START);
  const [to, setTo] = useState("");

  const ring = () => {
    const form = new FormData();
    form.set("to", to);
    dispatch(form);
  };

  return (
    <Card title="Test call" description="Ring a number and let the live configuration answer it.">
      <Row>
        <TextField
          label="Number to ring"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="+2348021184429"
          className="max-w-64"
          error={state.fieldErrors["to"]}
        />
        <div className="pt-[22px]">
          <Button variant="primary" onClick={ring} disabled={pending}>
            {pending ? "Ringing…" : "Ring me now"}
          </Button>
        </div>
      </Row>
      {state.status === "succeeded" && (
        <Notice tone="ok" className="mt-3">
          {state.message}
        </Notice>
      )}
      {(state.status === "failed" || state.status === "invalid") && state.message !== null && (
        <Notice tone="error" className="mt-3">
          {state.message}
        </Notice>
      )}
    </Card>
  );
};
