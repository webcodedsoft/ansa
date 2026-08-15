import type { Metadata } from "next";

import { Card, PageHeader } from "@/components/ui";
import { listLiveCalls } from "@/features/calls/calls.service";
import { AutoRefresh } from "@/features/calls/components/auto-refresh";
import { LiveCallTable } from "@/features/calls/components/live-call-table";

export const metadata: Metadata = { title: "Live · Ansa" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

const REFRESH_MS = 5_000;

/**
 * Calls in progress, right now.
 *
 * There is no live endpoint — see `listLiveCalls`. `AutoRefresh` re-runs this Server
 * Component every few seconds so the page stays current without a socket, which is the
 * right amount of "live" for a screen someone glances at rather than stares at.
 */
const LivePage = async () => {
  const calls = await listLiveCalls();

  return (
    <>
      <PageHeader
        eyebrow="Operate"
        title="Live"
        meta="Calls in progress right now. There is no push feed for this — it is the call list, filtered to what has not ended, refreshed on its own every few seconds."
      />
      <AutoRefresh intervalMs={REFRESH_MS} />
      <Card>
        <LiveCallTable calls={calls} />
      </Card>
    </>
  );
};

export default LivePage;
