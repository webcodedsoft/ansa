import {
  createKnowledgeSource,
  deleteKnowledgeSource,
  findKnowledgeSource,
  listKnowledgeSources,
  listKnowledgeUnits,
  setKnowledgeUnits,
  type KnowledgeSourceSummary,
} from "@ansa/db";
import {
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Post,
  Put,
} from "@nestjs/common";

import { Endpoint } from "../http/endpoint";
import { apiRoute, FromBody, FromPath } from "../http/request";
import { choice, flag, integer, list, nullable, object, optional, text, type Infer } from "../http/schema";
import { timestamp } from "../schemas";
import { OrganizationContext } from "../tenancy/organization-context";

/**
 * What the agent may state without calling a tool.
 *
 * Sources belong to the **organisation** and an agent selects from them — the same split the
 * tool registry makes, for the same reason. An insurer with three agents writes its motor
 * policy FAQ once, and the after-hours line that only takes messages can be given the branch
 * addresses without being given the claims process.
 *
 * Which sources an agent uses is not decided here. That is `PUT /agents/{agentId}/knowledge`,
 * beside the tool selection it mirrors, because it is a property of the agent.
 *
 * **A unit is the thing retrieval returns, and therefore the thing a caller hears.** Splitting
 * a document into passages happens before this call, deliberately. A parser behind an upload
 * would hide the split, and the first sight of a bad one would be somebody on a phone line
 * being read half a sentence.
 */

const MAX_NAME = 120;

/**
 * Long enough for a policy clause, short enough to speak.
 *
 * A unit is read aloud. One running to two thousand words is not a retrieval problem waiting
 * to happen, it is a certainty: the model receives it whole and has two sentences to answer
 * in.
 */
const MAX_BODY = 4000;
const MAX_QUESTION = 500;
const MAX_UNITS = 2000;

const sourceKind = choice(["faq", "table", "document"]);

const unit = object({
  /** Null for a document passage or a table row, which answer a question nobody wrote down. */
  question: optional(nullable(text({ maxLength: MAX_QUESTION }))),
  body: text({ minLength: 1, maxLength: MAX_BODY }),
});

const storedUnit = object({
  unitId: text({ maxLength: 64 }),
  question: nullable(text({ maxLength: MAX_QUESTION })),
  body: text({ maxLength: MAX_BODY }),
});

const source = object({
  sourceId: text({ maxLength: 64 }),
  name: text({ maxLength: MAX_NAME }),
  kind: sourceKind,
  /** How many retrievable pieces it holds — "18 question pairs", "12 rows". */
  unitCount: integer({ minimum: 0 }),
  /** How often anything in it was retrieved on a call in the last seven days. */
  retrievalsLast7Days: integer({ minimum: 0 }),
  createdAt: timestamp(),
  updatedAt: timestamp(),
});

const sourceList = object({ items: list(source, { maxItems: 500 }) });
const sourceDetail = object({ source, units: list(storedUnit, { maxItems: MAX_UNITS }) });

const newSource = object({
  name: text({ minLength: 1, maxLength: MAX_NAME }),
  kind: sourceKind,
  units: list(unit, { maxItems: MAX_UNITS }),
});

const replacementUnits = object({
  /**
   * The source's `updatedAt` as the edit was made against.
   *
   * Two people with the same page open is the ordinary case, and a source is shared by every
   * agent using it — so a silent last-write-wins here rewrites what a colleague just
   * published to several live lines. The loser of the race hears about it instead.
   */
  expectedUpdatedAt: timestamp(),
  units: list(unit, { maxItems: MAX_UNITS }),
});
const sourcePath = object({ sourceId: text({ maxLength: 64 }) });
const removed = object({ deleted: flag() });

const toResponse = (row: KnowledgeSourceSummary): Infer<typeof source> => ({
  sourceId: row.sourceId,
  name: row.name,
  kind: row.kind,
  unitCount: row.unitCount,
  retrievalsLast7Days: row.retrievalsLast7Days,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

@Controller(apiRoute("knowledge"))
export class KnowledgeController {
  constructor(@Inject(OrganizationContext) private readonly db: OrganizationContext) {}

  @Get()
  @Endpoint({
    summary: "What this organisation's agents can answer from",
    description:
      "Every source the organisation holds, with how many pieces each carries and how often anything in it was retrieved on a call in the last seven days. Retired sources are absent: unlike an agent, a source that is gone has nothing pointing back at it that still needs its name.",
    capability: "config:read",
    response: sourceList,
  })
  async list(): Promise<Infer<typeof sourceList>> {
    const rows = await this.db.tx((scope) => listKnowledgeSources(scope));
    return { items: rows.map(toResponse) };
  }

  @Post()
  @Endpoint({
    summary: "Store something the agent may answer from",
    description:
      "Units are sent whole and are exactly what retrieval will return, so they are also what a caller will hear. Creating a source does not give it to any agent — that is `PUT /agents/{agentId}/knowledge`, so writing a FAQ cannot accidentally change what a live line says.",
    capability: "config:write",
    body: newSource,
    response: source,
  })
  async create(@FromBody() body: Infer<typeof newSource>): Promise<Infer<typeof source>> {
    const created = await this.db.tx((scope) =>
      createKnowledgeSource(scope, {
        name: body.name,
        kind: body.kind,
        units: body.units.map((entry) => ({ question: entry.question ?? null, body: entry.body })),
      }),
    );
    return toResponse(created);
  }

  @Get(":sourceId")
  @Endpoint({
    summary: "One source, with the pieces retrieval can return",
    capability: "config:read",
    params: sourcePath,
    response: sourceDetail,
  })
  async read(@FromPath() path: Infer<typeof sourcePath>): Promise<Infer<typeof sourceDetail>> {
    const found = await this.db.tx(async (scope) => {
      const row = await findKnowledgeSource(scope, path.sourceId);
      if (row === null) return null;
      return { row, units: await listKnowledgeUnits(scope, path.sourceId) };
    });
    if (found === null) throw new NotFoundException();

    return {
      source: toResponse(found.row),
      units: found.units.map((entry) => ({
        unitId: entry.unitId,
        question: entry.question,
        body: entry.body,
      })),
    };
  }

  @Put(":sourceId/units")
  @Endpoint({
    summary: "Replace what a source holds",
    description:
      "Whole, not patched: the order of the units is their position, and a patch protocol over an ordered list is a reorder API nobody asked for. Every agent using this source sees the change on its next call — that is the point of a shared source, and the reason to know which agents use one before rewriting it.",
    capability: "config:write",
    params: sourcePath,
    body: replacementUnits,
    response: source,
  })
  async replaceUnits(
    @FromPath() path: Infer<typeof sourcePath>,
    @FromBody() body: Infer<typeof replacementUnits>,
  ): Promise<Infer<typeof source>> {
    const saved = await this.db.tx(async (scope) => {
      // Read and compare inside the same transaction as the write, so the check cannot pass
      // and then be overtaken between the two statements.
      const current = await findKnowledgeSource(scope, path.sourceId);
      if (current === null) return null;
      if (current.updatedAt !== body.expectedUpdatedAt) return "conflict" as const;

      return setKnowledgeUnits(
        scope,
        path.sourceId,
        body.units.map((entry) => ({ question: entry.question ?? null, body: entry.body })),
      );
    });

    if (saved === null) throw new NotFoundException();
    if (saved === "conflict") {
      throw new ConflictException(
        "this source changed since you opened it; re-read it and make the edit again",
      );
    }
    return toResponse(saved);
  }

  @Delete(":sourceId")
  @Endpoint({
    summary: "Retire a source",
    description:
      "A soft delete. Retrieval stops immediately for every agent using it, and the retrieval history it accumulated stays readable — a call that quoted this source last week still has something to point at.",
    capability: "config:write",
    params: sourcePath,
    response: removed,
  })
  async remove(@FromPath() path: Infer<typeof sourcePath>): Promise<Infer<typeof removed>> {
    const gone = await this.db.tx((scope) => deleteKnowledgeSource(scope, path.sourceId));
    if (!gone) throw new NotFoundException();
    return { deleted: true };
  }
}
