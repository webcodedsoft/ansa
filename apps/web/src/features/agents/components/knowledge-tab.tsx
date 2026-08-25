"use client";

import { useActionState, useEffect, useMemo, useState } from "react";

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
  loadKnowledgeUnits,
  removeKnowledgeSourceAction,
  saveAgentKnowledgeAction,
  saveKnowledgeSourceAction,
  saveKnowledgeUnitsAction,
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
  const [editing, setEditing] = useState<string | null>(null);
  const sources = knowledge.items;

  if (adding) return <AddSource onDone={() => setAdding(false)} />;
  if (editing !== null) {
    return <EditSource sourceId={editing} onDone={() => setEditing(null)} />;
  }

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
        <Selection agent={agent} sources={sources} onEdit={setEditing} />
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
  onEdit,
}: {
  readonly agent: AgentSummary;
  readonly sources: KnowledgeDocument["items"];
  readonly onEdit: (sourceId: string) => void;
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

  /* Dispatched, not submitted. Every tab panel renders inside the page's publish form, and a
     nested `<form>` is invalid HTML — the parser drops the inner tag, so its submit button
     posts the outer form and this saved a configuration version instead of a selection. */
  const save = () => {
    const form = new FormData();
    form.set("agentId", agent.agentId);
    for (const sourceId of chosen) form.append("sources", sourceId);
    action(form);
  };

  return (
    <div>
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
                    <div className="flex justify-end gap-2">
                      <Button variant="secondary" onClick={() => onEdit(source.sourceId)}>
                        Edit
                      </Button>
                      <RetireSource sourceId={source.sourceId} name={source.name} />
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Panel>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={save} disabled={pending}>
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
    </div>
  );
};

const RetireSource = ({ sourceId, name }: { readonly sourceId: string; readonly name: string }) => {
  const [state, action, pending] = useActionState(removeKnowledgeSourceAction, START);
  useFormToast(state, () => `Retired ${name}.`);

  const retire = () => {
    const form = new FormData();
    form.set("sourceId", sourceId);
    action(form);
  };

  // Danger rather than secondary: retiring a source stops retrieval for every agent using it,
  // and it read as ordinary as the button beside it.
  return (
    <Button type="button" variant="danger" onClick={retire} disabled={pending}>
      {pending ? "Retiring…" : "Retire"}
    </Button>
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

  const store = () => {
    setShowProblems(true);
    const form = new FormData();
    form.set("name", name);
    form.set("kind", kind);
    form.set("unitsJson", JSON.stringify(units));
    action(form);
  };

  return (
    <div>
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
          <Button type="button" onClick={store} disabled={pending}>
            {pending ? "Storing…" : "Store source"}
          </Button>
          <span className="text-[12.5px] text-[var(--ink-3)]">
            Storing does not give it to any agent. Tick it on the list afterwards.
          </span>
        </div>
      </Stack>
    </div>
  );
};


interface EditableUnit {
  readonly question: string;
  readonly body: string;
}

/**
 * Edit what a source already holds, piece by piece.
 *
 * Not by round-tripping back to pasted text. What is stored is units, and re-deriving text
 * from them so it could be re-split would let the splitter reshape pieces nobody touched —
 * a document whose passages were adjusted by hand would silently revert on the next save.
 * These are the things retrieval returns, so these are the things being edited.
 *
 * Order is position, which is why the moves are here. It decides nothing about ranking —
 * the store sorts by relevance — but it is the tie-break, and it is how somebody reads the
 * list back.
 */
const EditSource = ({
  sourceId,
  onDone,
}: {
  readonly sourceId: string;
  readonly onDone: () => void;
}) => {
  const [loaded, setLoaded] = useState<
    | { readonly status: "loading" }
    | { readonly status: "failed"; readonly message: string }
    | {
        readonly status: "ready";
        readonly name: string;
        readonly kind: Kind;
        readonly updatedAt: string;
      }
  >({ status: "loading" });
  const [units, setUnits] = useState<readonly EditableUnit[]>([]);
  /* Which piece the right-hand pane is showing. The list is the navigation, so this is the
     only thing that decides what is on screen — and every mutation below has to keep it
     pointing at the piece the person was looking at, not at whatever slid into that index. */
  const [selected, setSelected] = useState(0);
  const [state, action, pending] = useActionState(saveKnowledgeUnitsAction, START);

  useFormToast(state, () => {
    onDone();
    return "Saved.";
  });

  useEffect(() => {
    let live = true;
    void loadKnowledgeUnits(sourceId).then((result) => {
      if (!live) return;
      if (!result.ok) {
        setLoaded({ status: "failed", message: result.message });
        return;
      }
      setLoaded({
        status: "ready",
        name: result.detail.source.name,
        kind: result.detail.source.kind as Kind,
        // Carried so the save can be refused if somebody else changed the source while this
        // was open. A shared source rewritten silently is a live line rewritten silently.
        updatedAt: result.detail.source.updatedAt,
      });
      setUnits(
        result.detail.units.map((unit) => ({ question: unit.question ?? "", body: unit.body })),
      );
    });
    return () => {
      live = false;
    };
  }, [sourceId]);

  const edit = (index: number, over: Partial<EditableUnit>) =>
    setUnits((current) =>
      current.map((unit, at) => (at === index ? { ...unit, ...over } : unit)),
    );

  const move = (index: number, by: number) =>
    setUnits((current) => {
      const to = index + by;
      if (to < 0 || to >= current.length) return current;
      const next = [...current];
      const [taken] = next.splice(index, 1);
      if (taken === undefined) return current;
      next.splice(to, 0, taken);
      return next;
    });

  /* Selection travels with the piece. Moving something and then finding yourself editing
     its neighbour is the kind of small betrayal that costs somebody a paragraph. */
  const moveSelected = (by: number) => {
    const to = selected + by;
    if (to < 0 || to >= units.length) return;
    move(selected, by);
    setSelected(to);
  };

  const removeSelected = () => {
    setUnits(units.filter((_, at) => at !== selected));
    setSelected(Math.max(0, Math.min(selected, units.length - 2)));
  };

  const addPiece = () => {
    setUnits([...units, { question: "", body: "" }]);
    setSelected(units.length);
  };

  if (loaded.status === "loading") {
    return (
      <Card title="Loading" description="Fetching what this source holds.">
        <p className="text-[13px] text-[var(--ink-2)]">One moment.</p>
      </Card>
    );
  }

  if (loaded.status === "failed") {
    return (
      <Stack>
        <Notice tone="error">{loaded.message}</Notice>
        <div>
          <Button variant="secondary" onClick={onDone}>
            Back
          </Button>
        </div>
      </Stack>
    );
  }

  const empty = units.every((unit) => unit.body.trim() === "");

  const save = () => {
    const form = new FormData();
    form.set("sourceId", sourceId);
    form.set("expectedUpdatedAt", loaded.updatedAt);
    form.set(
      "unitsJson",
      JSON.stringify(
        units
          .filter((unit) => unit.body.trim() !== "")
          .map((unit) => ({
            question: unit.question.trim() === "" ? null : unit.question.trim(),
            body: unit.body.trim(),
          })),
      ),
    );
    action(form);
  };

  const current = units[selected];

  return (
    <div>
      <Stack>
        {(state.status === "failed" || state.status === "invalid") && (
          <Notice tone="error">{state.message}</Notice>
        )}

        {empty && (
          <Notice tone="warn">
            A source with nothing in it retrieves nothing, which sounds exactly like it having
            been deleted. Retire it instead — that says so.
          </Notice>
        )}

        {/* One surface, with the source's own name in its own bar. The name used to sit
            above the panel as a page heading, which left the panel looking like furniture
            belonging to nothing. */}
        <div className="overflow-hidden rounded-xl border border-[var(--surface-line)]">
          <div className="flex items-center gap-3 border-b border-[var(--surface-line)] bg-[var(--surface-2)] px-4 py-2.5">
            <span className="truncate font-mono text-[11px] tracking-[0.14em] text-[var(--ink-2)] uppercase">
              {loaded.name}
            </span>
            <span className="flex-1" />
            <Button type="button" size="sm" variant="secondary" onClick={onDone}>
              Back
            </Button>
            {/* Primary, because it is the one thing on this screen that keeps the work. */}
            <Button type="button" size="sm" variant="primary" onClick={save} disabled={pending || empty}>
              {pending ? "Saving…" : "Save changes"}
            </Button>
          </div>

          {/* The list navigates and the pane edits, each scrolling on its own, so the page
              behind them does not scroll at all. Eight hundred pieces cost the same screen as
              eighteen — which is the whole reason for the shape. */}
          <div className="grid h-[min(600px,calc(100vh-340px))] grid-cols-[minmax(0,300px)_minmax(0,1fr)] max-md:h-auto max-md:grid-cols-1">
            <div className="flex min-h-0 flex-col border-r border-[var(--surface-line)] max-md:border-r-0 max-md:border-b">
              <div className="min-h-0 flex-1 overflow-y-auto p-2 max-md:max-h-[200px]">
                {units.map((unit, index) => (
                  <button
                    // Position is the identity here; a piece has no id until it is saved.
                    key={index}
                    type="button"
                    aria-current={index === selected}
                    onClick={() => setSelected(index)}
                    className={`flex w-full gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] leading-snug ${
                      index === selected
                        ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                        : "text-[var(--ink-2)] hover:bg-[var(--surface-2)]"
                    }`}
                  >
                    <span className="pt-px font-mono text-[10.5px] text-[var(--ink-3)]">
                      {index + 1}
                    </span>
                    {/* Wrapped to two lines rather than truncated. Half this organisation's
                        questions open "Do you have a two-bedroom…", so a single clipped line
                        makes neighbouring pieces impossible to tell apart in the one place
                        you pick between them. */}
                    <span className="min-w-0 flex-1 line-clamp-2">
                      {unit.question.trim() !== ""
                        ? unit.question
                        : unit.body.trim() !== ""
                          ? unit.body
                          : "Empty piece"}
                    </span>
                  </button>
                ))}
              </div>
              <div className="border-t border-[var(--surface-line)] p-2">
                <Button type="button" size="sm" variant="secondary" onClick={addPiece}>
                  Add a piece
                </Button>
              </div>
            </div>

            {current === undefined ? (
              <div className="grid place-items-center p-8 text-center text-[13px] text-[var(--ink-3)]">
                Nothing in here yet. Add a piece to start.
              </div>
            ) : (
              <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
                {/* Quiet controls. Three full-size buttons shouted louder than the sentence
                    they act on, which was the complaint about the screen this replaces. */}
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-[var(--ink-3)]">
                    Piece {selected + 1} of {units.length}
                  </span>
                  <span className="flex-1" />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label="Move this piece earlier"
                    onClick={() => moveSelected(-1)}
                    disabled={selected === 0}
                  >
                    ↑
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label="Move this piece later"
                    onClick={() => moveSelected(1)}
                    disabled={selected >= units.length - 1}
                  >
                    ↓
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={removeSelected}>
                    Remove
                  </Button>
                </div>
                <TextField
                  label="Question it answers"
                  value={current.question}
                  onChange={(event) => edit(selected, { question: event.target.value })}
                  placeholder="Optional — blank is fine for a passage or a row"
                />
                <TextAreaField
                  label="What the agent says"
                  value={current.body}
                  onChange={(event) => edit(selected, { body: event.target.value })}
                  rows={12}
                  hint="Retrieved on its own and read out on its own. If it would not answer a question by itself, split it."
                />
              </div>
            )}
          </div>
        </div>

        <p className="text-[12.5px] text-[var(--ink-3)]">
          {units.length} {KIND_TAG[loaded.kind]} · every agent using this source sees the change
          on its next call.
        </p>

      </Stack>
    </div>
  );
};
