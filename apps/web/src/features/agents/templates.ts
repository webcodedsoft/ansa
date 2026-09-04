
import { CATALOGUE_TEMPLATES } from "./catalogue";
import type { AgentTemplate } from "./templates.shape";

export {
  allFields, field, formPolicies, servicesOf,
  type AgentTemplate, type TemplateArm, type TemplateBranch, type TemplatePolicy,
} from "./templates.shape";

/**
 * Starting points for a new agent.
 *
 * An organisation can now have no agents at all — migration 0025 removed the trigger that
 * used to create one — so this is the first thing somebody sees after signing up. A blank
 * form at that moment asks a person who has never configured a voice agent to invent the
 * shape of one, and what they invent is usually a web form read aloud: "Please enter your
 * policy number." These templates exist to put a working conversation in front of them
 * instead, which they then edit.
 *
 * Every prompt below is written as speech. That is the same rule the field builder states
 * and the reason it is worth repeating here: these strings go through the normalizer and
 * out of a speaker, and "Policy number:" is not something a person says.
 *
 * Written for Nigerian callers — naira, WAT, Nigerian English, real branch names. A
 * template full of "Main Street" and dollars is a template every organisation has to
 * rewrite before it is usable, which defeats the point of having one.
 */

const BLANK: AgentTemplate = {
  id: "blank",
  name: "Start from nothing",
  sector: "Any business",
  summary: "A name and nothing else. Write the greeting and the questions yourself.",
  persona: "",
  greeting: "",
  instructions: "",
  keyterms: [],
  policies: [],
  fields: [],
  bargeIn: true,
  answeringMachineDetection: false,
};

/**
 * Everything: the catalogue, blank last.
 *
 * The catalogue lives in its own directory because it is sixty-odd organisations of content
 * and this file is the shape.
 */
export const AGENT_TEMPLATES: readonly AgentTemplate[] = [...CATALOGUE_TEMPLATES, BLANK];

/** Every sector in the catalogue, in the order the gallery lists them. */
export const TEMPLATE_SECTORS: readonly string[] = [
  ...new Set(AGENT_TEMPLATES.map((template) => template.sector)),
];

/** Null rather than a throw: a template id in a request body is not to be trusted. */
export const findTemplate = (id: string): AgentTemplate | null =>
  AGENT_TEMPLATES.find((template) => template.id === id) ?? null;
