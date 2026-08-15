"use client";

import { useActionState, useState } from "react";

import {
  Button,
  Card,
  CheckboxField,
  EmptyState,
  Notice,
  Panel,
  Stack,
  SubmitButton,
  Table,
  Tag,
  Td,
  TextAreaField,
  TextField,
  Th,
  Tr,
  type Tone,
} from "@/components/ui";
import { idleForm } from "@/lib/form-state";
import { useFormToast } from "@/stores/toast.store";

import { deleteHttpToolAction, replaceToolsAction, type ToolsState } from "../agents.actions";
import type { ToolsDocument } from "../agents.service";
import { draftFromApi, type HttpToolDraft } from "../http-tool.schema";

import { HttpToolForm } from "./http-tool-form";

const START: ToolsState = idleForm();

const TIER_TONE: Record<"read" | "write" | "irreversible", Tone> = {
  read: "ok",
  write: "warn",
  irreversible: "bad",
};

/** The host, not the URL: a path can carry an identifier, and this is a list somebody reads. */
const hostOrRaw = (url: string): string => {
  try {
    return new URL(url.replace(/\{[^}]+\}/g, "_")).host;
  } catch {
    // A malformed URL is the registry's problem to report, not this screen's to crash on.
    return url;
  }
};

/**
 * The organisation's tools: a list, and one form for the tool being worked on.
 *
 * This replaced a single textarea holding the whole document as JSON. That was honest —
 * nothing pretended a tool was added until the document round-tripped through the same
 * validation the API runs — but it asked every operator to know JSON Schema, the tier rules
 * and the egress allowlist, and gave them one error at a time to find out with.
 *
 * HTTP tools get the editor. MCP servers appear in the list, still run, and round-trip
 * untouched on every save: there is no editor for them, and a screen that deleted what it
 * could not display would take out a working integration the first time somebody added an
 * endpoint.
 */
export const ToolRegistry = ({
  document: doc,
  credentials,
}: {
  readonly document: ToolsDocument;
  readonly credentials: readonly string[];
}) => {
  /** `null` closed, `"new"` adding, a draft editing. */
  const [editing, setEditing] = useState<HttpToolDraft | "new" | null>(null);
  const mcpCount = doc.mcp.reduce((total, server) => total + server.tools.length, 0);

  const asDraft = editing === "new" || editing === null ? undefined : editing;
  const takenNames = doc.http.map((tool) => tool.name).filter((name) => name !== asDraft?.name);

  if (editing !== null) {
    return (
      <Stack>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[17px] font-semibold tracking-[-0.018em]">
            {editing === "new" ? "Add a tool" : `Editing ${asDraft?.name}`}
          </h2>
          <Button variant="secondary" onClick={() => setEditing(null)}>
            Back to the list
          </Button>
        </div>
        <HttpToolForm
          initial={asDraft}
          configVersion={doc.configVersion}
          takenNames={takenNames}
          allowPlaintextHttp={doc.egress.allowPlaintextHttp ?? false}
          credentials={credentials}
          onDone={() => setEditing(null)}
        />
      </Stack>
    );
  }

  return (
    <Stack>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-[64ch] text-[13.5px] text-[var(--ink-3)]">
          {doc.http.length} HTTP tool{doc.http.length === 1 ? "" : "s"}
          {mcpCount > 0 && <> and {mcpCount} from MCP servers</>}. Configuration version{" "}
          {doc.configVersion}.
        </p>
        <Button onClick={() => setEditing("new")}>Add a tool</Button>
      </div>

      {doc.http.length === 0 && mcpCount === 0 ? (
        <Panel>
          <EmptyState title="No tools registered">
            Until one is, the agent says it cannot look anything up — which is the honest
            answer, and better than a guess.
          </EmptyState>
        </Panel>
      ) : (
        <Panel>
          <Table>
            <thead>
              <tr>
                <Th>Tool</Th>
                <Th>Route</Th>
                <Th>Risk tier</Th>
                <Th>&nbsp;</Th>
              </tr>
            </thead>
            <tbody>
              {doc.http.map((tool) => (
                <Tr key={`http:${tool.name}`}>
                  <Td className="font-medium">{tool.name}</Td>
                  <Td className="font-mono text-[12.5px] text-[var(--ink-3)]">
                    {tool.method} {hostOrRaw(tool.url)}
                  </Td>
                  <Td>
                    <Tag tone={TIER_TONE[tool.riskTier]}>{tool.riskTier}</Tag>
                  </Td>
                  <Td>
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="secondary"
                        onClick={() =>
                          setEditing(draftFromApi(tool as unknown as Record<string, unknown>))
                        }
                      >
                        Edit
                      </Button>
                      <RemoveTool name={tool.name} configVersion={doc.configVersion} />
                    </div>
                  </Td>
                </Tr>
              ))}
              {doc.mcp.flatMap((server) =>
                server.tools.map((tool) => (
                  <Tr key={`mcp:${server.url}:${tool.name}`}>
                    <Td className="font-medium">{tool.name}</Td>
                    <Td className="font-mono text-[12.5px] text-[var(--ink-3)]">
                      MCP · {hostOrRaw(server.url)}
                    </Td>
                    <Td>
                      <Tag tone={TIER_TONE[tool.riskTier]}>{tool.riskTier}</Tag>
                    </Td>
                    <Td>
                      <span className="block text-right text-[12px] text-[var(--ink-3)]">
                        no editor
                      </span>
                    </Td>
                  </Tr>
                )),
              )}
            </tbody>
          </Table>
        </Panel>
      )}

      <Notice tone="error">
        Enforced in code. An irreversible tool never runs — it transfers to a person, and no
        configuration here changes that.
      </Notice>

      <EgressSettings doc={doc} />
    </Stack>
  );
};

const RemoveTool = ({
  name,
  configVersion,
}: {
  readonly name: string;
  readonly configVersion: number;
}) => {
  const [state, action, pending] = useActionState(deleteHttpToolAction, START);
  useFormToast(state, () => `Removed ${name}.`);

  return (
    <form action={action}>
      <input type="hidden" name="name" value={name} />
      <input type="hidden" name="expectedVersion" value={configVersion} />
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Removing…" : "Remove"}
      </Button>
    </form>
  );
};

/**
 * The allowlist, still editable by hand.
 *
 * Saving a tool adds its host automatically, so this is now for removing an entry or adding
 * one ahead of time, rather than the thing standing between a tool and working at all. The
 * automatic add is one-way on purpose: nothing here guesses that a host has become unused,
 * because two tools can share one and removing it would break the other.
 */
const EgressSettings = ({ doc }: { readonly doc: ToolsDocument }) => {
  const [state, action, pending] = useActionState(replaceToolsAction, START);
  useFormToast(state, (data) => `Published configuration version ${data.configVersion}.`);

  return (
    <form action={action}>
      <input type="hidden" name="expectedVersion" value={doc.configVersion} />
      <input
        type="hidden"
        name="documentJson"
        value={JSON.stringify({ http: doc.http, mcp: doc.mcp })}
      />

      {(state.status === "failed" || state.status === "invalid") && (
        <Notice tone="error" className="mb-3.5">
          {state.message}
        </Notice>
      )}

      <Card
        title="Egress"
        description="Hosts a tool's URL may point at. Anything else is refused at registration."
      >
        <Stack>
          <TextAreaField
            label="Allowed hosts"
            name="allowedHosts"
            defaultValue={doc.egress.allowedHosts.join("\n")}
            error={state.fieldErrors["allowedHosts"]}
            hint="One host per line. Saving a tool adds its host here for you."
          />
          <CheckboxField
            label="Allow plaintext HTTP (not recommended)"
            name="allowPlaintextHttp"
            defaultChecked={doc.egress.allowPlaintextHttp ?? false}
          />
          <TextField
            label="What changed"
            name="note"
            maxLength={500}
            placeholder="Added api.acme.ng"
            error={state.fieldErrors["note"]}
          />
          <div>
            <SubmitButton pending={pending} idle="Save egress" busy="Saving…" />
          </div>
        </Stack>
      </Card>
    </form>
  );
};
