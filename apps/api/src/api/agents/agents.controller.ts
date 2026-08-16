import {
  archiveAgent,
  createAgent,
  findAgent,
  listAgents,
  NumberNotRoutable,
  stageAgentSelection,
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
  flag,
  integer,
  list,
  nullable,
  number,
  object,
  optional,
  text,
  type Infer,
} from "../http/schema";
import {
  capturedField,
  MAX_CAPTURED_FIELDS,
  phoneNumber,
  timestamp,
  uuid,
} from "../schemas";
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

const agent = object({
  agentId: uuid(),
  name: text({ maxLength: NAME_LIMIT }),
  persona: nullable(text({ maxLength: PERSONA_LIMIT })),
  greeting: nullable(text({ maxLength: GREETING_LIMIT })),
  /** House rules, layered onto the base prompt and never replacing it. */
  instructions: nullable(text({ maxLength: INSTRUCTIONS_LIMIT })),
  voiceId: nullable(text({ maxLength: VOICE_LIMIT })),
  /** Null is the voice's own pace. 0.7 to 1.2, the range ElevenLabs renders cleanly. */
  speakingRate: nullable(number({ minimum: 0.7, maximum: 1.2 })),
  /** The number that reaches this agent. Null while unrouted, which is a real state. */
  dialledNumber: nullable(phoneNumber()),
  /** Per agent. Two agents both on version 3 is ordinary and means nothing. */
  configVersion: integer({ minimum: 1 }),
  /**
   * Which of the organisation's shared registry this agent may call. Empty means none —
   * never all of them.
   */
  enabledTools: list(text({ maxLength: TOOL_NAME_LIMIT })),
  /** Ids of the organisation's knowledge sources this agent answers from. */
  knowledgeSources: list(text({ maxLength: 64 }), { maxItems: 200 }),
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
  deletedAt: nullable(timestamp()),
  createdAt: timestamp(),
});

const fieldSelection = object({ fields: list(capturedField, { maxItems: MAX_CAPTURED_FIELDS }) });

const agentList = object({ items: list(agent) });

const agentPath = object({ agentId: uuid() });

/**
 * What staging answers with.
 *
 * Not the agent. These three used to write the live tables and return the agent, which was a
 * true description of what had happened; now they write the draft, and returning the agent
 * would describe a row they deliberately did not touch. The console re-reads
 * `GET /config/draft` for the staged state, so the only thing worth returning is when.
 */
const staged = object({ updatedAt: timestamp() });

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
/**
 * Routing, and nothing else. See `AgentEdit` in `@ansa/db` for why the rest left.
 *
 * A field removed from here is refused by the schema layer rather than ignored, so a caller
 * still sending `greeting` gets a 422 naming it instead of a silent no-op. That is the right
 * answer: it used to work, and "it stopped working" needs to be loud.
 */
const agentEdit = object({
  dialledNumber: optional(nullable(phoneNumber())),
});

/**
 * The behaviour flags, staged rather than applied.
 *
 * Both optional and neither required, unlike the three selections above, which are sent
 * whole. Those are lists where "what is on screen is what gets saved"; these are two switches
 * flipped one at a time, and requiring both would make every flip carry the other flag's
 * value as the browser last saw it — which is how one tab reverts the other. Absent means
 * "not staged" all the way down to the column.
 */
const behaviour = object({
  bargeIn: optional(flag()),
  answeringMachineDetection: optional(flag()),
});

const knowledgeSelection = object({
  /** Source ids from the organisation's own list. One this organisation does not hold is ignored. */
  sources: list(uuid(), { maxItems: 200 }),
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
      "Includes retired agents, because a call log that references one still needs its name. Filter on `deletedAt` when offering a choice.",
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
    summary: "Move which number reaches an agent",
    description:
      "Routing only. Send `dialledNumber: null` to unroute the agent, or a number to move it; refuses with 409 if that number is not available to route. Everything the agent says — its name, greeting, persona, instructions, voice and pace — is published, not patched, so it is not settable here: this endpoint would otherwise be a way to change what a caller hears with no version behind it.",
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

  @Put(":agentId/behaviour")
  @Endpoint({
    summary: "Stage this agent's behaviour flags",
    description:
      "Saved, not applied: the flags go into the agent's unpublished draft and a call answered a second later behaves exactly as it does today, until somebody publishes. Send only the switch that moved — an omitted flag is left as it was, staged or live, so flipping one cannot revert the other to whatever the page last read. `false` is a value and stages the switch off.",
    capability: "config:write",
    params: agentPath,
    body: behaviour,
    response: staged,
  })
  async setBehaviour(
    @FromPath() path: Infer<typeof agentPath>,
    @FromBody() body: Infer<typeof behaviour>,
  ): Promise<Infer<typeof staged>> {
    const at = await this.db.tx((scope) =>
      stageAgentSelection(
        scope,
        path.agentId,
        {
          ...(body.bargeIn === undefined ? {} : { bargeIn: body.bargeIn }),
          ...(body.answeringMachineDetection === undefined
            ? {}
            : { answeringMachineDetection: body.answeringMachineDetection }),
        },
        null,
      ),
    );
    if (at === null) throw new NotFoundException();
    return { updatedAt: at };
  }

  @Put(":agentId/tools")
  @Endpoint({
    summary: "Stage which shared tools this agent may call",
    description:
      "Saved, not applied: the selection goes into the agent's unpublished draft and the agent keeps calling whatever it calls today until somebody publishes. The registry belongs to the organisation; this is one agent's slice of it, sent whole rather than patched so the selection on screen is the selection saved. An empty list stages an agent that reaches none of the organisation's tools — it keeps the platform's own, so it can still end a call and transfer to a human.",
    capability: "config:write",
    params: agentPath,
    body: toolSelection,
    response: staged,
  })
  async setTools(
    @FromPath() path: Infer<typeof agentPath>,
    @FromBody() body: Infer<typeof toolSelection>,
  ): Promise<Infer<typeof staged>> {
    const at = await this.db.tx((scope) =>
      stageAgentSelection(scope, path.agentId, { tools: body.tools }, null),
    );
    if (at === null) throw new NotFoundException();
    return { updatedAt: at };
  }

  @Put(":agentId/knowledge")
  @Endpoint({
    summary: "Stage which of the organisation's sources this agent may answer from",
    description:
      "Saved, not applied: the selection goes into the unpublished draft and retrieval on a live call is unchanged until somebody publishes. Sources belong to the organisation; this is one agent's slice, exactly as tools are. An empty list stages an agent with no knowledge base — `search_knowledge_base` is then not registered and the model is never told it can look anything up, rather than being offered a search that can only come back empty.",
    capability: "config:write",
    params: agentPath,
    body: knowledgeSelection,
    response: staged,
  })
  async setKnowledge(
    @FromPath() path: Infer<typeof agentPath>,
    @FromBody() body: Infer<typeof knowledgeSelection>,
  ): Promise<Infer<typeof staged>> {
    const at = await this.db.tx((scope) =>
      stageAgentSelection(scope, path.agentId, { knowledge: body.sources }, null),
    );
    if (at === null) throw new NotFoundException();
    return { updatedAt: at };
  }

  @Put(":agentId/fields")
  @Endpoint({
    summary: "Stage the form this agent conducts",
    description:
      "Saved, not applied: the form goes into the unpublished draft and the agent keeps asking whatever it asks today until somebody publishes. Sent whole rather than patched, because the order of the fields is the order the caller is asked and a partial update would be a reorder protocol nobody asked for. Once published, a field with a pattern is re-asked until the value matches or the attempts run out.",
    capability: "config:write",
    params: agentPath,
    body: fieldSelection,
    response: staged,
  })
  async setFields(
    @FromPath() path: Infer<typeof agentPath>,
    @FromBody() body: Infer<typeof fieldSelection>,
  ): Promise<Infer<typeof staged>> {

    /* An uncompilable pattern is refused at save rather than at publish, and long before a
       call. The runtime treats one as "accept anything", which is the only safe reading at
       answer time — a stray bracket must not become a caller who can never get past the first
       question. But that makes it silent, and a stray bracket saved today is a format check
       that has never once run. Checked here and not only on the publish path for the reason
       every draft rule is: being told it saved and finding out at publish that it never could
       have is worse than being told now. */
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

    const at = await this.db.tx((scope) =>
      stageAgentSelection(scope, path.agentId, { capturedFields: body.fields }, null),
    );
    if (at === null) throw new NotFoundException();
    return { updatedAt: at };
  }
}
