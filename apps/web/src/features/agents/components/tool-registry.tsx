"use client";

import { useActionState } from "react";

import { Card, CheckboxField, Notice, Panel, Stack, SubmitButton, Table, Tag, Td, TextAreaField, TextField, Th, Tr, type Tone } from "@/components/ui";
import { idleForm } from "@/lib/form-state";
import { useFormToast } from "@/stores/toast.store";

import { replaceToolsAction, type ToolsState } from "../agents.actions";
import type { ToolsDocument } from "../agents.service";

const START: ToolsState = idleForm();

const TIER_TONE: Record<"read" | "write" | "irreversible", Tone> = { read: "ok", write: "warn", irreversible: "bad" };

interface ToolRegistryProps {
  readonly document: ToolsDocument;
}

/**
 * Organisation-wide tools: what may run, at what risk tier, from what host.
 *
 * `PUT /tools` rewrites the whole document the same way a configuration publish does, so
 * editing goes through a JSON document rather than a field per tool property — a
 * structured per-tool editor (add a header, add an identifier pair, and so on) is the
 * better long-term shape, but it is a lot of dynamic-list machinery for what a JSON
 * textarea already does honestly today: nothing here pretends a tool was added until the
 * document round-trips through the same validation `tools.replace` runs.
 */
export const ToolRegistry = ({ document: doc }: ToolRegistryProps) => {
  const [state, action, pending] = useActionState(replaceToolsAction, START);
  const total = doc.http.length + doc.mcp.reduce((n, s) => n + s.tools.length, 0);

  useFormToast(state, (data) => `Published configuration version ${data.configVersion}.`);

  const documentJson = JSON.stringify({ http: doc.http, mcp: doc.mcp }, null, 2);

  return (
    <Stack>
      {total === 0 ? (
        <Panel>
          <div className="px-6 py-10 text-center text-[13.5px] text-[var(--ink-3)]">
            No tools registered yet. Add one below.
          </div>
        </Panel>
      ) : (
        <Panel>
          <Table>
            <thead>
              <tr>
                <Th>Tool</Th>
                <Th>Route</Th>
                <Th>Risk tier</Th>
              </tr>
            </thead>
            <tbody>
              {doc.http.map((tool) => (
                <Tr key={`http:${tool.name}`}>
                  <Td className="font-medium">{tool.name}</Td>
                  <Td className="font-mono text-[12.5px] text-[var(--ink-3)]">HTTP · {tool.method} {new URL(tool.url).host}</Td>
                  <Td>
                    <Tag tone={TIER_TONE[tool.riskTier]}>{tool.riskTier}</Tag>
                  </Td>
                </Tr>
              ))}
              {doc.mcp.flatMap((server) =>
                server.tools.map((tool) => (
                  <Tr key={`mcp:${server.url}:${tool.name}`}>
                    <Td className="font-medium">{tool.name}</Td>
                    <Td className="font-mono text-[12.5px] text-[var(--ink-3)]">MCP · {new URL(server.url).host}</Td>
                    <Td>
                      <Tag tone={TIER_TONE[tool.riskTier]}>{tool.riskTier}</Tag>
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

      <form action={action}>
        <input type="hidden" name="expectedVersion" value={doc.configVersion} />
        {(state.status === "failed" || state.status === "invalid") && <Notice tone="error" className="mb-3.5">{state.message}</Notice>}

        <Card title="Egress" description="Hosts a tool's URL is allowed to point at. Anything else is refused at registration.">
          <Stack>
            <TextAreaField
              label="Allowed hosts"
              name="allowedHosts"
              defaultValue={doc.egress.allowedHosts.join("\n")}
              error={state.fieldErrors["allowedHosts"]}
              hint="One host per line, e.g. api.kanogeneral.ng"
            />
            <CheckboxField label="Allow plaintext HTTP (not recommended)" name="allowPlaintextHttp" defaultChecked={doc.egress.allowPlaintextHttp ?? false} />
          </Stack>
        </Card>

        <Card title="Tools document" description="The whole HTTP and MCP tool list, as JSON. Replaces the current document exactly." className="mt-3.5">
          <Stack>
            <TextAreaField
              label="http and mcp"
              name="documentJson"
              defaultValue={documentJson}
              tall
              className="font-mono"
              error={state.fieldErrors["documentJson"]}
              hint={`Shape: { "http": [...], "mcp": [...] }, matching PUT /api/v1/tools. A write tool needs a "readback"; an irreversible tool registers but never executes.`}
            />
          </Stack>
        </Card>

        <Card title="Publish" description={`Currently on configuration version ${doc.configVersion}.`} className="mt-3.5">
          <Stack>
            <TextField label="What changed" name="note" maxLength={500} placeholder="Added change_address" error={state.fieldErrors["note"]} />
            <div>
              <SubmitButton pending={pending} idle="Publish registry" busy="Publishing…" />
            </div>
          </Stack>
        </Card>
      </form>
    </Stack>
  );
};
