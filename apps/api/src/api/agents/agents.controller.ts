import {
  archiveAgent,
  createAgent,
  setCapturedFields,
  findAgent,
  listAgents,
  NumberNotRoutable,
  setAgentTools,
  updateAgent,
} from "@ansa/db";
import {
  BadRequestException,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Patch,
  Post,
  Put,
} from "@nestjs/common";

import { Endpoint } from "../http/endpoint";
import { apiRoute, FromBody, FromPath } from "../http/request";
import {
  choice,
  flag,
  integer,
  list,
  nullable,
  object,
  optional,
  text,
  type Infer,
} from "../http/schema";
import { phoneNumber, timestamp, uuid } from "../schemas";
import { OrganizationContext } from "../tenancy/organization-context";

/**
 * The agents an organisation runs (migration 0018).
 *
 * An agent is what a caller experiences: a name, a persona, a greeting, a voice, the
 * number that reaches it and the tools it may use. An organisation may run several, and a
 * number reaches exactly one of them.
 *
 * **Routing is here; ownership is not.** An organisation chooses which of *its own* agents
 * answers a line it already holds. It cannot add a line — `organization_numbers` is written by
 * an operator and `ansa_app` has SELECT on it and nothing else. That split is the point of
 * migration 0019 and the reason `numbers.controller.ts` is read-only: an organisation that
 * could claim a number would be claiming one somebody else controls at their carrier, and
 * the damage lands on whoever is onboarded onto it next.
 *
 * `config:read` and `config:write` rather than a new `agents:*` pair. The capability table
 * already defines `config:read` as "the agent's configuration: prompts, tools, numbers,
 * hours" — an agent is that configuration, so a second vocabulary would mean two names for
 * one permission and a role table that has to keep them in step.
 */

const NAME_LIMIT = 200;
const PERSONA_LIMIT = 2000;
const GREETING_LIMIT = 500;
const VOICE_LIMIT = 120;
/** Matches what `config.publish` already accepts, so a template can carry either route. */
const INSTRUCTIONS_LIMIT = 2000;
/** The registry is a jsonb document; a tool name in it is a short identifier. */
const TOOL_NAME_LIMIT = 120;
/**
 * Enough for any registry maintained by hand, and a ceiling all the same. Without one a
 * selection is an unbounded array that gets inserted a row at a time.
 */
const MAX_TOOLS = 200;
/** A voice form longer than this is a conversation nobody finishes. */
const MAX_FIELDS = 40;

/**
 * One thing the agent asks a caller for.
 *
 * A voice form, so every field carries how it is *asked* and how it is *confirmed* — the
 * two questions a web form never has to answer. `confirm` is the one that matters: a
 * write-tier tool will not fire on an unconfirmed value however confident the transcriber
 * was, because 8 kHz audio does not support that confidence.
 */
const capturedField = object({
  /** How tools receive it. An identifier, not a label — `policyNumber`, not "Policy number". */
  key: text({ maxLength: 64, pattern: /^[a-zA-Z][a-zA-Z0-9_]*$/ }),
  /**
   * The engine's own vocabulary, not a parallel one.
   *
   * `capture.ts` knows how to hear, check and read back twelve kinds of value — including
   * a NIN's eleven digits and an email's spelling fallback. A shorter list here would mean
   * translating configuration into it and losing the difference between an eleven-digit
   * BVN and "a number", which is exactly the check that catches a dropped digit.
   *
   * `choice` and `text` are the two the engine does not capture: nothing is read back and
   * the answer stays in the transcript for the model to read.
   */
  type: choice(["name", "reference", "phone", "email", "address", "date", "time", "amount", "nin", "bvn", "otp", "quantity", "choice", "text"]),
  /** Written as speech, not as a form label. It goes through the normalizer before it is spoken. */
  prompt: text({ maxLength: 300 }),
  /**
   * Keypad tones survive an 8 kHz line intact. For anything with a checkable structure,
   * prefer it — it is the difference between a guess and a fact.
   */
  capture: choice(["speech", "keypad", "either"]),
  /**
   * Whether the agent checks the value back before anything uses it.
   *
   * The operator's choice, including "none", and that is a product decision rather than an
   * oversight. The capture engine's own risk table would always read an identifier back;
   * this overrides it, so a field marked `none` is taken as heard.
   *
   * It does not override the dispatch path. A write-tier tool naming this field in its
   * `identifiers` still refuses to fire on a value nothing confirmed — that gate is about
   * what may be acted on, not about what may be asked, and no configuration reaches it.
   */
  confirm: choice(["none", "readback", "spellback"]),
  /** Rejected values are re-asked, not passed on. Empty means anything is accepted. */
  pattern: text({ maxLength: 200 }),
  /** Then it transfers to a person, rather than asking a fourth time. */
  attempts: integer({ minimum: 1, maximum: 10 }),
  required: flag(),
  /** Stored and sent to the organisation's systems, hidden in the console. */
  redact: flag(),
  /** Only meaningful for `choice`. Empty otherwise. */
  options: list(text({ maxLength: 120 }), { maxItems: 24 }),
});

const agent = object({
  agentId: uuid(),
  name: text({ maxLength: NAME_LIMIT }),
  persona: nullable(text({ maxLength: PERSONA_LIMIT })),
  greeting: nullable(text({ maxLength: GREETING_LIMIT })),
  /** House rules, layered onto the base prompt and never replacing it. */
  instructions: nullable(text({ maxLength: INSTRUCTIONS_LIMIT })),
  voiceId: nullable(text({ maxLength: VOICE_LIMIT })),
  /** The number that reaches this agent. Null while unrouted, which is a real state. */
  dialledNumber: nullable(phoneNumber()),
  /** Per agent. Two agents both on version 3 is ordinary and means nothing. */
  configVersion: integer({ minimum: 1 }),
  /**
   * Which of the organisation's shared registry this agent may call. Empty means none —
   * never all of them.
   */
  enabledTools: list(text({ maxLength: TOOL_NAME_LIMIT })),
  /**
   * The caller may cut the agent off mid-sentence. On unless somebody turns it off.
   *
   * Settable, unlike the transfer-on-escalation behaviour shown beside it in the console:
   * that one is enforced in the dispatch path so that no setting and no prompt can talk it
   * out of it, and a field here would be a switch for disabling a safety rail.
   */
  bargeIn: flag(),
  /** Outbound calls reaching voicemail hang up rather than talk to a greeting. */
  answeringMachineDetection: flag(),
  /** The voice form this agent conducts, in the order it asks. */
  capturedFields: list(capturedField),
  /** Set when the agent was retired. Retired agents are listed so call logs can name them. */
  archivedAt: nullable(timestamp()),
  createdAt: timestamp(),
});

const fieldSelection = object({ fields: list(capturedField, { maxItems: MAX_FIELDS }) });

const agentList = object({ items: list(agent) });

const agentPath = object({ agentId: uuid() });

const newAgent = object({
  name: text({ maxLength: NAME_LIMIT }),
  persona: optional(nullable(text({ maxLength: PERSONA_LIMIT }))),
  greeting: optional(nullable(text({ maxLength: GREETING_LIMIT }))),
  instructions: optional(nullable(text({ maxLength: INSTRUCTIONS_LIMIT }))),
  voiceId: optional(nullable(text({ maxLength: VOICE_LIMIT }))),
  dialledNumber: optional(nullable(phoneNumber())),
});

/**
 * Every field optional, and each distinguishes absent from null.
 *
 * Omitting `persona` leaves it alone; sending `null` clears it. Collapsing those two would
 * make "this agent no longer has a persona" inexpressible, and unrouting an agent —
 * `dialledNumber: null` — is the case where it actually matters.
 */
const agentEdit = object({
  name: optional(text({ maxLength: NAME_LIMIT })),
  persona: optional(nullable(text({ maxLength: PERSONA_LIMIT }))),
  greeting: optional(nullable(text({ maxLength: GREETING_LIMIT }))),
  instructions: optional(nullable(text({ maxLength: INSTRUCTIONS_LIMIT }))),
  voiceId: optional(nullable(text({ maxLength: VOICE_LIMIT }))),
  dialledNumber: optional(nullable(phoneNumber())),
  bargeIn: optional(flag()),
  answeringMachineDetection: optional(flag()),
});

const toolSelection = object({
  tools: list(text({ maxLength: TOOL_NAME_LIMIT }), { maxItems: MAX_TOOLS }),
});

/**
 * The database refuses an unroutable number two ways, and this answers the same for both.
 *
 * 409 rather than 422: nothing about the request is malformed, the number is simply spoken
 * for. And the message does not say by whom — the index is global, so the answer could
 * name another organisation's agent, and a caller who could tell "already routed" from
 * "not yours" could walk a number range to learn who else is a customer.
 */
/**
 * One agent row, as the wire sees it.
 *
 * The cast is on `capturedFields` alone and it is narrow on purpose: `@ansa/db` stores the
 * form as `unknown[]` deliberately — the shape belongs to this file, which validates it on
 * the way in. The response schema then validates it again on the way out, so a row written
 * by hand in psql that does not match surfaces as a 500 here rather than as a malformed
 * document three layers away.
 */
const toResponse = (row: {
  readonly capturedFields: readonly unknown[];
}): Infer<typeof agent> =>
  ({ ...row, capturedFields: [...row.capturedFields] }) as unknown as Infer<typeof agent>;

const asConflict = (error: unknown): never => {
  if (error instanceof NumberNotRoutable) {
    throw new ConflictException(
      "that number is not available to route — it is not one of this organisation's numbers, or another agent already answers it",
    );
  }
  throw error;
};

@Controller(apiRoute("agents"))
export class AgentsController {
  constructor(@Inject(OrganizationContext) private readonly db: OrganizationContext) {}

  @Get()
  @Endpoint({
    summary: "List this organisation's agents, oldest first",
    description:
      "Includes retired agents, because a call log that references one still needs its name. Filter on `archivedAt` when offering a choice.",
    capability: "config:read",
    response: agentList,
  })
  async list(): Promise<Infer<typeof agentList>> {
    const items = await this.db.tx((scope) => listAgents(scope));
    return { items: items.map(toResponse) };
  }

  @Post()
  @Endpoint({
    summary: "Add an agent to this organisation",
    description:
      "Starts at version 1 with no tools selected — a new agent does not inherit permission to call the organisation's endpoints. `dialledNumber` is optional; an agent can be written and reviewed before it is given a line. Refuses with 409 if the number is not available to route.",
    capability: "config:write",
    body: newAgent,
    response: agent,
  })
  async create(@FromBody() body: Infer<typeof newAgent>): Promise<Infer<typeof agent>> {
    const created = await this.db.tx((scope) => createAgent(scope, body)).catch(asConflict);
    return toResponse(created);
  }

  @Get(":agentId")
  @Endpoint({
    summary: "One agent",
    capability: "config:read",
    params: agentPath,
    response: agent,
  })
  async read(@FromPath() path: Infer<typeof agentPath>): Promise<Infer<typeof agent>> {
    const found = await this.db.tx((scope) => findAgent(scope, path.agentId));
    // Not ours reads the same as does not exist, and under RLS that is also the true
    // answer: this session genuinely cannot see the row. A 403 would confirm the id.
    if (found === null) throw new NotFoundException();
    return toResponse(found);
  }

  @Patch(":agentId")
  @Endpoint({
    summary: "Rename an agent, or move which number reaches it",
    description:
      "Only the fields present are written. Send `dialledNumber: null` to unroute the agent, or a number to move it. Refuses with 409 if that number is not available to route.",
    capability: "config:write",
    params: agentPath,
    body: agentEdit,
    response: agent,
  })
  async update(
    @FromPath() path: Infer<typeof agentPath>,
    @FromBody() body: Infer<typeof agentEdit>,
  ): Promise<Infer<typeof agent>> {
    const updated = await this.db
      .tx((scope) => updateAgent(scope, path.agentId, body))
      .catch(asConflict);
    if (updated === null) throw new NotFoundException();
    return toResponse(updated);
  }

  @Delete(":agentId")
  @Endpoint({
    summary: "Retire an agent and release its number",
    description:
      "Archived, not deleted: calls point at the agent that handled them for the life of the call log. The number is released in the same statement, because an archived agent does not answer and a number left attached would ring nobody and could not be reassigned.",
    capability: "config:write",
    params: agentPath,
  })
  async archive(@FromPath() path: Infer<typeof agentPath>): Promise<void> {
    const archived = await this.db.tx((scope) => archiveAgent(scope, path.agentId));
    if (!archived) throw new NotFoundException();
  }

  @Put(":agentId/tools")
  @Endpoint({
    summary: "Replace which shared tools this agent may call",
    description:
      "The registry belongs to the organisation; this is one agent's slice of it. Sent whole rather than patched, so the selection on screen is the selection saved. An empty list means the agent reaches none of the organisation's tools — it keeps the platform's own, so it can still end a call and transfer to a human.",
    capability: "config:write",
    params: agentPath,
    body: toolSelection,
    response: agent,
  })
  async setTools(
    @FromPath() path: Infer<typeof agentPath>,
    @FromBody() body: Infer<typeof toolSelection>,
  ): Promise<Infer<typeof agent>> {
    const saved = await this.db.tx(async (scope) => {
      const applied = await setAgentTools(scope, path.agentId, body.tools);
      if (applied === null) return null;
      // Read back inside the same transaction rather than assembling a response from the
      // request: what the caller renders is then what the database holds, deduplication
      // and ordering included.
      return findAgent(scope, path.agentId);
    });
    if (saved === null) throw new NotFoundException();
    return toResponse(saved);
  }

  @Put(":agentId/fields")
  @Endpoint({
    summary: "Replace the form this agent conducts",
    description:
      "Sent whole rather than patched: the order of the fields is the order the caller is asked, so a partial update would be a reorder protocol nobody asked for. The agent conducts this form on the next call it takes — the order here is the order it asks, and a field with a pattern is re-asked until the value matches or the attempts run out.",
    capability: "config:write",
    params: agentPath,
    body: fieldSelection,
    response: agent,
  })
  async setFields(
    @FromPath() path: Infer<typeof agentPath>,
    @FromBody() body: Infer<typeof fieldSelection>,
  ): Promise<Infer<typeof agent>> {

    /* An uncompilable pattern is refused here rather than on a call. The runtime treats one
       as "accept anything", which is the only safe reading at answer time — a stray bracket
       must not become a caller who can never get past the first question. But that makes it
       silent, and a stray bracket saved today is a format check that has never once run. */
    for (const field of body.fields) {
      if (field.pattern === "") continue;
      try {
        new RegExp(field.pattern);
      } catch {
        throw new BadRequestException(
          `The pattern on "${field.key}" is not a valid regular expression. Nothing was saved.`,
        );
      }
    }

    const saved = await this.db.tx((scope) => setCapturedFields(scope, path.agentId, body.fields));
    if (saved === null) throw new NotFoundException();
    return toResponse(saved);
  }
}
