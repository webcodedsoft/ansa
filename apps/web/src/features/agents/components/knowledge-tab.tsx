"use client";

import { useActionState, useMemo, useState } from "react";

import {
  Button,
  Card,
  CheckboxField,
  EmptyState,
  FieldError,
  Notice,
  Panel,
  SelectField,
  Stack,
  Table,
  Tag,
  Td,
  TextAreaField,
  TextField,
  Th,
  Tr,
} from "@/components/ui";
import { idleForm } from "@/lib/form-state";
import { when } from "@/lib/format";
import { useFormToast } from "@/stores/toast.store";

import {
  removeKnowledgeSourceAction,
  saveAgentKnowledgeAction,
  saveKnowledgeSourceAction,
  type KnowledgeState,
} from "../agents.actions";
import type { AgentSummary, KnowledgeDocument } from "../agents.service";
import {
  KINDS,
  KIND_HINT,
  KIND_LABEL,
  parseUnits,
  problemsWith,
  spokenForm,
  type Kind,
} from "../knowledge.schema";

/**
 * What this agent can answer from.
 *
 * Sources belong to the organisation and this is one agent's slice — the same split the
 * Tools tab makes, so a FAQ written once is reusable rather than pasted again. Creating a
 * source and giving it to an agent are two separate acts on purpose: writing something down
 * should not change what a live line says.
 *
 * The parsing happens in the browser, in front of a preview, because a unit is what
 * retrieval returns and therefore what a caller hears. A splitter hidden behind an upload
 * would make a bad split first visible on a phone call.
 */

const START: KnowledgeState = idleForm();

const KIND_TAG: Readonly<Record<Kind, string>> = {
  faq: "question pairs",
  table: "rows",
  document: "passages",
};

const SAMPLE: Readonly<Record<Kind, string>> = {
  faq: "How do I renew my motor policy?\nCall us or use the portal. Renewal opens 30 days before expiry.\n\nWhat do I need to renew?\nYour policy number and a valid means of identification.",
  table:
    "Branch\tAddress\tOpens\tCloses\nIkeja\t14 Allen Avenue\t08:00\t17:00\nLekki\t3 Admiralty Way\t09:00\t16:00",
  document:
    "Cancellations\n\nA policy may be cancelled within 14 days of purchase for a full refund. After that a pro-rata refund applies, less an administrative fee.",
};

export const KnowledgeTab = ({
  agent,
  knowledge,
}: {
  readonly agent: AgentSummary;
  readonly knowledge: KnowledgeDocument;
}) => {
  const [adding, setAdding] = useState(false);
  const sources = knowledge.items;

  if (adding) return <AddSource onDone={() => setAdding(false)} />;

  return (
    <Stack>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold tracking-[-0.018em]">What it can answer from</h2>
          <p className="mt-1 max-w-[62ch] text-[13.5px] text-[var(--ink-3)]">
            Facts the agent may state without calling a tool. Anything not here, it says it
            does not know rather than guessing.
          </p>
        </div>
        <Button onClick={() => setAdding(true)}>Add source</Button>
      </div>

      {sources.length === 0 ? (
        <Panel>
          <EmptyState title="Nothing stored yet">
            Until a source is added and given to this agent, every question about how the
            organisation works gets &ldquo;I can&rsquo;t help with that&rdquo; — which is the
            honest answer, and better than an invented one.
          </EmptyState>
        </Panel>
      ) : (
        <Selection agent={agent} sources={sources} />
      )}

      <Notice tone="warn">
        <span className="font-medium">Grounded only.</span> The agent quotes these or says it
        cannot help. It does not improvise an answer from general knowledge.
      </Notice>
    </Stack>
  );
};

/**
 * The organisation's sources, with this agent's selection.
 *
 * Sent as a whole list rather than per row, so what is on screen is what is stored — the
 * same reason the tool selection is sent whole.
 */
const Selection = ({
  agent,
  sources,
}: {
  readonly agent: AgentSummary;
  readonly sources: KnowledgeDocument["items"];
}) => {
  const [state, action, pending] = useActionState(saveAgentKnowledgeAction, START);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    () => new Set(agent.knowledgeSources ?? []),
  );

  useFormToast(state, () => "Saved.");

  const toggle = (sourceId: string, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(sourceId);
      else next.delete(sourceId);
      return next;
    });

  return (
    <form action={action}>
      <input type="hidden" name="agentId" value={agent.agentId} />
      {[...chosen].map((sourceId) => (
        <input key={sourceId} type="hidden" name="sources" value={sourceId} />
      ))}

      <Stack>
        {(state.status === "failed" || state.status === "invalid") && (
          <Notice tone="error">{state.message}</Notice>
        )}

        <Panel>
          <Table>
            <thead>
              <tr>
                <Th>Used here</Th>
                <Th>Source</Th>
                <Th>Type</Th>
                <Th>Used, 7d</Th>
                <Th>Last updated</Th>
                <Th>&nbsp;</Th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <Tr key={source.sourceId}>
                  <Td>
                    <CheckboxField
                      label={`${source.name} used by this agent`}
                      checked={chosen.has(source.sourceId)}
                      onChange={(event) => toggle(source.sourceId, event.target.checked)}
                    />
                  </Td>
                  <Td className="font-medium">{source.name}</Td>
                  <Td className="text-[12.5px] text-[var(--ink-3)]">
                    {source.unitCount} {KIND_TAG[source.kind as Kind]}
                  </Td>
                  <Td className="tabular-nums">{source.retrievalsLast7Days}</Td>
                  <Td className="whitespace-nowrap text-[12.5px] text-[var(--ink-3)]">
                    {when(source.updatedAt)}
                  </Td>
                  <Td>
                    <div className="flex justify-end">
                      <RetireSource sourceId={source.sourceId} name={source.name} />
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Panel>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save selection"}
          </Button>
          {chosen.size === 0 && (
            <span className="max-w-[58ch] text-[12.5px] text-[var(--ink-3)]">
              With none selected the agent is never offered a search at all, rather than one
              that can only come back empty.
            </span>
          )}
        </div>
      </Stack>
    </form>
  );
};

const RetireSource = ({ sourceId, name }: { readonly sourceId: string; readonly name: string }) => {
  const [state, action, pending] = useActionState(removeKnowledgeSourceAction, START);
  useFormToast(state, () => `Retired ${name}.`);

  return (
    <form action={action}>
      <input type="hidden" name="sourceId" value={sourceId} />
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Retiring…" : "Retire"}
      </Button>
    </form>
  );
};

/**
 * Paste something, see what it becomes, then store it.
 *
 * The preview is the feature. Every other field here is ordinary, but the list of pieces is
 * the only chance anybody gets to notice that a table lost a column or a document split
 * mid-clause. After this, the next sight of it is a caller being read the result.
 */
const AddSource = ({ onDone }: { readonly onDone: () => void }) => {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("faq");
  const [raw, setRaw] = useState("");
  const [showProblems, setShowProblems] = useState(false);
  const [state, action, pending] = useActionState(saveKnowledgeSourceAction, START);

  useFormToast(state, () => {
    onDone();
    return "Stored.";
  });

  const units = useMemo(() => parseUnits(kind, raw), [kind, raw]);
  const problems = problemsWith(name, units);
  const problem = (key: string) => (showProblems ? problems[key] : undefined);

  return (
    <form
      action={(form) => {
        form.set("unitsJson", JSON.stringify(units));
        action(form);
      }}
    >
      <Stack>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[17px] font-semibold tracking-[-0.018em]">Add a source</h2>
          <Button type="button" variant="secondary" onClick={onDone}>
            Back
          </Button>
        </div>

        {(state.status === "failed" || state.status === "invalid") && (
          <Notice tone="error">{state.message}</Notice>
        )}

        <Card
          title="What it is"
          description="Stored for the organisation, so any of its agents can be given it."
        >
          <Stack>
            <TextField
              label="Name"
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              error={problem("name")}
              placeholder="Motor policy FAQ"
              hint="How somebody tells this apart from the others later."
            />
            <SelectField
              label="Shape"
              name="kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as Kind)}
              hint={KIND_HINT[kind]}
            >
              {KINDS.map((option) => (
                <option key={option} value={option}>
                  {KIND_LABEL[option]}
                </option>
              ))}
            </SelectField>
          </Stack>
        </Card>

        <Card title="Paste it in" description="Split as you type. Check the preview before storing.">
          <Stack>
            <TextAreaField
              label="Content"
              value={raw}
              onChange={(event) => setRaw(event.target.value)}
              rows={12}
              className="font-mono text-[12.5px]"
              placeholder={SAMPLE[kind]}
            />
            {problem("content") !== undefined && <FieldError>{problem("content")}</FieldError>}
            {raw.trim() === "" && (
              <div>
                <Button type="button" variant="secondary" onClick={() => setRaw(SAMPLE[kind])}>
                  Use an example
                </Button>
              </div>
            )}
          </Stack>
        </Card>

        {units.length > 0 && (
          <Card
            title={`${units.length} piece${units.length === 1 ? "" : "s"}`}
            description="Each is retrieved on its own and read out on its own. If one of these would not answer a question by itself, it is split wrong."
          >
            <div className="flex flex-col gap-2">
              {units.slice(0, 30).map((unit, index) => (
                <div
                  key={index}
                  className="flex items-start gap-2 rounded-lg border border-[var(--surface-line)] bg-[var(--surface-2)] px-3 py-2"
                >
                  <Tag>{index + 1}</Tag>
                  <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-[var(--ink-2)]">
                    {spokenForm(unit)}
                  </p>
                </div>
              ))}
              {units.length > 30 && (
                <p className="text-[12.5px] text-[var(--ink-3)]">
                  …and {units.length - 30} more. All of them are stored; this shows thirty so
                  the page stays readable.
                </p>
              )}
            </div>
          </Card>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending} onClick={() => setShowProblems(true)}>
            {pending ? "Storing…" : "Store source"}
          </Button>
          <span className="text-[12.5px] text-[var(--ink-3)]">
            Storing does not give it to any agent. Tick it on the list afterwards.
          </span>
        </div>
      </Stack>
    </form>
  );
};
