import type { AgentSummary } from "../agents.service";
import type { CapturedField } from "../agents.schema";
import { FieldBuilder } from "./field-builder";

/**
 * What this agent collects.
 *
 * The definitions are real and they save (migration 0021, `PUT /agents/:id/fields`). What
 * does not exist yet is the runtime that conducts them: nothing in the orchestrator reads
 * this array and walks a caller through it, so defining a field describes an intention
 * rather than changing a call. `FieldBuilder` says so on screen rather than leaving it to
 * be discovered on the phone.
 *
 * The cast is the counterpart of the one in the API controller. `capturedFields` crosses
 * the wire as the generated client's structural type; this feature owns the zod schema that
 * defines it, and the server validated against the same shape on the way out.
 */
export const DataCapturedTab = ({ agent }: { readonly agent: AgentSummary }) => (
  <FieldBuilder
    agentId={agent.agentId}
    initial={agent.capturedFields as readonly CapturedField[]}
  />
);
