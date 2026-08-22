/**
 * An organisation's rules, given a shape the model can search.
 *
 * `organization-layer.ts` already carries their rules as bounded prose, fenced, with 8g's
 * limit stated after the fence — that limit is the half that changes what a caller hears,
 * and it stays whatever happens here. This is the other half: a model reading a paragraph
 * picks whichever clause is nearest, and one reading headings can find the clause that
 * applies, or find that none does.
 *
 * That second outcome is the one worth building for. "There is no rule for this" is only a
 * usable answer if the rules are discrete enough to be exhausted; against a run of prose it
 * is a judgement call the model will resolve in favour of having an answer.
 *
 * Renders nothing when there are no blocks, which is every organisation until one writes
 * some. An agent with none behaves exactly as it did.
 */

export interface PolicyBlock {
  readonly name: string;
  readonly applies: string;
  readonly canDo: readonly string[];
  readonly cannotDo: readonly string[];
  readonly escalateWhen: readonly string[];
}

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * Stored as jsonb, so it arrives as `unknown` and is checked here rather than trusted.
 *
 * The API validated it on the way in, and this is the call path — which reads rows written
 * by an older schema, by a script, or by a version of that schema that has since changed.
 * A malformed block is dropped rather than rendered half-formed: a heading with no rules
 * under it reads to the model as a policy that permits nothing.
 */
export const toPolicyBlocks = (raw: unknown): readonly PolicyBlock[] => {
  if (!Array.isArray(raw)) return [];
  const blocks: PolicyBlock[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const block = item as Record<string, unknown>;
    if (typeof block["name"] !== "string" || block["name"].trim() === "") continue;
    if (typeof block["applies"] !== "string") continue;
    const canDo = block["canDo"];
    const cannotDo = block["cannotDo"];
    const escalateWhen = block["escalateWhen"];
    blocks.push({
      name: block["name"].trim(),
      applies: block["applies"].trim(),
      canDo: isStringArray(canDo) ? canDo : [],
      cannotDo: isStringArray(cannotDo) ? cannotDo : [],
      escalateWhen: isStringArray(escalateWhen) ? escalateWhen : [],
    });
  }
  return blocks;
};

const section = (block: PolicyBlock): readonly string[] => [
  `## ${block.name}`,
  block.applies === "" ? "" : `Applies when: ${block.applies}`,
  ...block.canDo.map((line) => `- You can: ${line}`),
  ...block.cannotDo.map((line) => `- You cannot: ${line}`),
  ...block.escalateWhen.map((line) => `- Get them a person if: ${line}`),
  "",
];

/**
 * The blocks, or an empty string when there are none.
 *
 * The closing rule is the one that matters, and it is the same one 8g states about their
 * prose — repeated here because a reader who finds a heading for refunds and none for
 * exchanges is in exactly the situation that invents an exchange policy from the refund
 * one. Stated after the blocks rather than before, so nothing an organisation writes sits
 * downstream of it.
 */
export const renderPolicyBlocks = (blocks: readonly PolicyBlock[]): string => {
  if (blocks.length === 0) return "";
  return [
    "These are the policies you have. Find the one that covers what the caller is asking",
    "about, and follow it.",
    "",
    ...blocks.flatMap(section),
    "If none of them covers their situation, you do not have a policy for it. Do not work",
    "one out from the others — they are separate rules and not examples of a pattern. Say",
    "you would have to check, and get them a person.",
  ].join("\n");
};
