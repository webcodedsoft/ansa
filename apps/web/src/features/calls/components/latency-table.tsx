import { Notice, Table, Td, Th, Tr } from "@/components/ui";

import type { CallMetrics } from "../calls.service";
import { msLabel } from "../format";

/**
 * The only latency the API aggregates: caller stops talking to first reply audio. Not a
 * stage-by-stage budget — the metrics endpoint has no STT/LLM/TTS split, only the whole
 * response. Saying so is the honest version of this table; inventing a breakdown from
 * nothing would look like measurement and be a guess.
 */
export const LatencyTable = ({ metrics }: { readonly metrics: CallMetrics }) => (
  <>
    <Table>
      <thead>
        <tr>
          <Th>Stage</Th>
          <Th>Latency</Th>
        </tr>
      </thead>
      <tbody>
        <Tr>
          <Td>Response, p50 — caller stops talking to first reply audio</Td>
          <Td className="tabular-nums">{msLabel(metrics.responseLatencyMs.p50)}</Td>
        </Tr>
        <Tr>
          <Td>Response, p95 — the tail, which is what a caller remembers</Td>
          <Td className="tabular-nums">{msLabel(metrics.responseLatencyMs.p95)}</Td>
        </Tr>
      </tbody>
    </Table>
    <Notice tone="warn" className="mt-3">
      This is the whole response, not a breakdown by stage. The API does not expose
      aggregate STT, LLM or TTS timing yet — only per call, in that call&apos;s own event
      timeline.
    </Notice>
  </>
);
