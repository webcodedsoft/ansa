import { branchesTakenBefore, projectToCapturedFields, reachableNodes } from "@ansa/shared/flow-project";
import type { BranchTaken } from "@ansa/shared/flow-project";

import type { Flow } from "./flow.schema";
import type { FlowQuestion } from "./components/authoring-mode";

/**
 * A branch, in the words the Data captured tab puts after "asked".
 *
 * "when intent is rent", "when total is more than 50,000", "when intent is anything else".
 * Several branches read as one clause joined by "and", which is right: a question behind two
 * decisions is asked only when both went that way.
 */
const phrase = (branch: BranchTaken): string => {
  const { on, when } = branch;
  if (when === null) return `${on} is anything else`;
  if ("equals" in when) return `${on} is "${when.equals}"`;
  if ("oneOf" in when) return `${on} is ${when.oneOf.map((value) => `"${value}"`).join(" or ")}`;
  if ("isEmpty" in when) return `${on} was not given`;
  return `${on} is more than ${when.greaterThan.toLocaleString("en-NG")}`;
};

/**
 * The questions a flow asks, in the order a call meets them, each saying when.
 *
 * The order and the set are the projection's — the same list the API publishes onto
 * `capturedFields` — so this tab and the Collected data columns cannot disagree about what
 * the agent asks. What this adds is the one column a list cannot have: which branch a
 * question sits behind, from the same must-analysis that decides what a step may branch on.
 */
export const questionsFromFlow = (flow: Flow): readonly FlowQuestion[] => {
  const collects = reachableNodes(flow).filter((node) => node.kind === "collect");
  return projectToCapturedFields(flow).map((field) => {
    const node = collects.find((each) => each.field?.key === field.key);
    const taken = node === undefined ? [] : branchesTakenBefore(flow, node.id);
    return {
      key: field.key,
      prompt: field.prompt,
      type: field.type,
      confirm: field.confirm,
      asked: taken.length === 0 ? null : `when ${taken.map(phrase).join(" and ")}`,
    };
  });
};

/** How many places this flow branches — what turning it back into a form throws away. */
export const branchCount = (flow: Flow): number =>
  reachableNodes(flow).filter((node) => node.kind === "decide" || node.kind === "confirm").length;
