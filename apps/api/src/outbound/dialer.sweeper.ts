import {
  organizationsWithDueCalls,
  startDueCampaigns,
  type Db,
  type DueCall,
} from "@ansa/db";
import type { Logger, OrganizationId } from "@ansa/shared";
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";

import { DATA_SOURCE, LOGGER } from "../telephony/tokens";
import { ORIGINATION, type Origination } from "../api/testcall/origination";
import { DIALER_SWEEP_MS, sweepOnce, type SweepReport } from "./dialer";

/**
 * The timer that makes campaigns happen.
 *
 * `dialer.ts` holds every decision and this holds none of them: it is the thing that runs the
 * sweep on a clock and nothing else, so the policy stays testable without a process around it.
 *
 * It goes through `ORIGINATION`, which goes through `placeOutboundCall`, which is the one door
 * with the consent gate on it. That indirection is the point — `origination.ts` says it plainly:
 * a second path is how the check ends up on one route and not the other, and the route without
 * it would be the one with a button on it.
 *
 * The campaign travels out with the call as a stream parameter and comes back on the media
 * socket, which is the same mechanism CLAUDE.md describes for the organisation on an outbound
 * call. Without it the orchestrator has no way to know why it is on the phone.
 */
@Injectable()
export class OutboundDialer implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: Db | null,
    @Inject(ORIGINATION) private readonly origination: Origination | null,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.dataSource === null) {
      // Inbound-only is a working deployment. Say so once rather than failing to start.
      this.log.warn("no database: outbound campaigns cannot be dialled");
      return;
    }
    if (this.origination === null) {
      this.log.warn("no telephony credentials: outbound campaigns cannot be dialled");
      return;
    }
    this.timer = setInterval(() => {
      void this.sweep();
    }, DIALER_SWEEP_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass. Returns what it did so a test can assert on it rather than on a log line.
   *
   * Guarded against overlapping itself: a sweep that takes longer than the interval must not
   * have a second one start beside it and dial the rows it is already dialling. The claim
   * would refuse the duplicate anyway — this saves the work of finding that out.
   */
  async sweep(): Promise<SweepReport> {
    const empty: SweepReport = { considered: 0, placed: 0, suppressed: 0, failed: 0 };
    if (this.running || this.dataSource === null || this.origination === null) return empty;
    this.running = true;

    try {
      const dataSource = this.dataSource;
      const origination = this.origination;

      /* Before looking for work, not after: a campaign whose start time passed a moment ago
         should dial on this sweep rather than wait out another interval. Its own try/catch,
         because a campaign failing to start is not a reason to stop dialling every campaign
         that already has. */
      try {
        const started = await startDueCampaigns(dataSource);
        for (const one of started) {
          this.log.info("campaign reached its start time and is now running", {
            campaignId: one.campaignId,
            organizationId: one.organizationId,
          });
        }
      } catch (error) {
        this.log.warn("could not start scheduled campaigns", {
          reason: error instanceof Error ? error.message : String(error),
        });
      }

      return await sweepOnce({
        dataSource,
        log: this.log,
        organizationsWithWork: () => organizationsWithDueCalls(dataSource),
        place: async (organizationId: OrganizationId, due: DueCall) => {
          const placed = await origination.place({
            owner: organizationId,
            to: due.phone,
            // Non-null by the time this runs: `sweepOrganization` suppresses the row otherwise.
            from: due.fromNumber ?? "",
            /* The campaign, so the orchestrator can read its brief when the socket opens.
               `scheduledCallId` too: the outcome the agent records has to land on the row
               that caused the call, and the call itself is the only thing that knows both. */
            parameters: {
              campaignId: due.campaignId,
              scheduledCallId: due.id,
            },
          });
          return { callId: placed.callId ?? null };
        },
      });
    } catch (error) {
      this.log.warn("outbound sweep failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      return empty;
    } finally {
      this.running = false;
    }
  }
}
