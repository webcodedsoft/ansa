import type { Metadata } from "next";

import { Card, EmptyState, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Audit log · Ansa" };

const AuditPage = () => (
  <>
    <PageHeader
        eyebrow="Organisation"
      title="Audit log"
      meta="Who did what to this organisation's configuration, membership and calls, and when."
    />

    <Card>
      <EmptyState title="Not available through the API yet">
        The API does not currently expose an audit endpoint. Sessions are retained server-side
        and marked revoked rather than deleted, so the record this page would show exists in the
        database — it is just not reachable from here yet. Nothing below is a placeholder for
        real activity; there is no row to show until that endpoint exists.
      </EmptyState>
    </Card>
  </>
);

export default AuditPage;
