"use client";

import { useState } from "react";

import { Button, Card, FieldError, Notice, Stack, TextField } from "@/components/ui";

import type { LiveConfiguration } from "../agents.service";

/**
 * The organisation's own rules, as blocks the prompt renders under headings.
 *
 * The API has accepted and returned these since migration 0046 and nothing could set them:
 * the console publishes a whole configuration document and had no policy editor in it, which
 * is why `publish_agent_config` coalesces a null `policy_blocks` to the stored value. That
 * coalesce was a guard around this gap rather than a feature — and with an editor on screen
 * the distinction it protects becomes real. Absent still means "leave them alone"; an empty
 * list now means "this agent has none", which is something somebody can actually choose.
 *
 * One hidden input carrying JSON, rather than indexed form fields. A block is a name, a
 * sentence and three lists of sentences, and flattening twelve of those into `FormData` keys
 * means inventing an index convention whose failure mode is two policies silently merging.
 *
 * The input belongs to the existing publish form by `form={publishForm}`, so Save and Publish
 * both carry policies without either action learning anything about them.
 */

export interface PolicyBlock {
  name: string;
  applies: string;
  canDo: string[];
  cannotDo: string[];
  escalateWhen: string[];
}

/** Both ceilings match the API's, so the editor cannot compose a document it will refuse. */
const MAX_BLOCKS = 12;
const MAX_LINES = 12;

const emptyBlock = (): PolicyBlock => ({
  name: "",
  applies: "",
  canDo: [""],
  cannotDo: [""],
  escalateWhen: [""],
});

/**
 * Blank lines are dropped on the way out, not on the way in.
 *
 * Somebody who adds a third bullet and thinks better of it should not have to delete the
 * empty box, and a block with no name was abandoned rather than written. Trimming at submit
 * keeps editing forgiving and the published document clean — different jobs, and they should
 * not share a rule.
 */
const cleaned = (blocks: readonly PolicyBlock[]): PolicyBlock[] =>
  blocks
    .map((block) => ({
      name: block.name.trim(),
      applies: block.applies.trim(),
      canDo: block.canDo.map((line) => line.trim()).filter((line) => line !== ""),
      cannotDo: block.cannotDo.map((line) => line.trim()).filter((line) => line !== ""),
      escalateWhen: block.escalateWhen.map((line) => line.trim()).filter((line) => line !== ""),
    }))
    .filter((block) => block.name !== "" && block.applies !== "");

const LIST_LABELS = {
  canDo: "What the agent can do",
  cannotDo: "What it must not do",
  escalateWhen: "When it hands over to a person",
} as const;

type ListKey = keyof typeof LIST_LABELS;

const LIST_KEYS: readonly ListKey[] = ["canDo", "cannotDo", "escalateWhen"];

interface PolicyTabProps {
  readonly config: LiveConfiguration["config"];
  readonly errors: Readonly<Record<string, string>>;
  readonly publishForm: string;
  readonly savingDraft: boolean;
}

export const PolicyTab = ({ config, errors, publishForm, savingDraft }: PolicyTabProps) => {
  const [blocks, setBlocks] = useState<PolicyBlock[]>(() =>
    (config.policyBlocks ?? []).map((block) => ({
      name: block.name,
      applies: block.applies,
      // At least one box per list, so an empty policy is editable rather than a dead heading.
      canDo: block.canDo.length > 0 ? [...block.canDo] : [""],
      cannotDo: block.cannotDo.length > 0 ? [...block.cannotDo] : [""],
      escalateWhen: block.escalateWhen.length > 0 ? [...block.escalateWhen] : [""],
    })),
  );

  const update = (index: number, change: Partial<PolicyBlock>): void =>
    setBlocks((current) =>
      current.map((block, at) => (at === index ? { ...block, ...change } : block)),
    );

  const setLine = (index: number, key: ListKey, at: number, value: string): void =>
    setBlocks((current) =>
      current.map((block, n) =>
        n === index
          ? { ...block, [key]: block[key].map((line, position) => (position === at ? value : line)) }
          : block,
      ),
    );

  const addLine = (index: number, key: ListKey): void =>
    setBlocks((current) =>
      current.map((block, n) => (n === index ? { ...block, [key]: [...block[key], ""] } : block)),
    );

  return (
    <Stack>
      <Notice tone="ok">
        Rules the agent follows on top of its instructions, grouped so the model can tell which
        one applies. Each block is rendered under its own heading, and the agent is told never
        to reason by analogy from one block to another — a refund rule is not a cancellation
        rule. Leave this empty if the instructions already cover everything.
      </Notice>

      {/* The whole editor, as one field. Everything else here is chrome around this input. */}
      <input
        type="hidden"
        form={publishForm}
        name="policyBlocks"
        value={JSON.stringify(cleaned(blocks))}
      />

      {errors["policyBlocks"] !== undefined && <FieldError>{errors["policyBlocks"]}</FieldError>}

      {blocks.map((block, index) => (
        <Card
          key={index}
          title={block.name.trim() === "" ? `Policy ${index + 1}` : block.name}
          description="A policy with no name, or no 'applies when', is dropped when you save — it reads as one somebody started and left."
        >
          <Stack>
            <TextField
              label="Name"
              value={block.name}
              onChange={(event) => update(index, { name: event.target.value })}
              placeholder="Refunds"
            />
            <TextField
              label="Applies when"
              value={block.applies}
              onChange={(event) => update(index, { applies: event.target.value })}
              placeholder="The caller wants money back for something they have already paid for."
            />

            {LIST_KEYS.map((key) => (
              <Stack key={key} gap="sm">
                {block[key].map((line, at) => (
                  <TextField
                    key={at}
                    label={`${LIST_LABELS[key]} — line ${at + 1}`}
                    value={line}
                    onChange={(event) => setLine(index, key, at, event.target.value)}
                  />
                ))}
                {block[key].length < MAX_LINES && (
                  <div>
                    <Button onClick={() => addLine(index, key)}>Add a line</Button>
                  </div>
                )}
              </Stack>
            ))}

            <div>
              <Button
                onClick={() => setBlocks((current) => current.filter((_, at) => at !== index))}
                disabled={savingDraft}
              >
                Remove this policy
              </Button>
            </div>
          </Stack>
        </Card>
      ))}

      {blocks.length < MAX_BLOCKS && (
        <div>
          <Button onClick={() => setBlocks((current) => [...current, emptyBlock()])}>
            Add a policy
          </Button>
        </div>
      )}
    </Stack>
  );
};
