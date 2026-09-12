import { DataTable, type Column } from "@/components/ui";

import type { InvitationSummary } from "../org.service";
import { InvitationRow } from "./invitation-row";

/**
 * `renderRow` rather than `columns`: each row is a client component holding its
 * own revoke-confirmation state, so it has to own its whole `<tr>`. The columns
 * are still declared here so the header cannot drift from what the rows draw.
 */
const COLUMNS: readonly Column<InvitationSummary>[] = [
  { key: "email", header: "Invited", cell: () => null },
  { key: "role", header: "As", cell: () => null },
  { key: "status", header: "Status", cell: () => null },
  { key: "when", header: "When", cell: () => null },
  { key: "actions", header: "Revoke", headerHidden: true, cell: () => null },
];

export const InvitationTable = ({
  invitations,
  canWrite,
}: {
  readonly invitations: readonly InvitationSummary[];
  readonly canWrite: boolean;
}) => (
  <DataTable
    rows={invitations}
    columns={COLUMNS}
    rowKey={(invitation) => invitation.id}
    empty={{ title: "Nobody is waiting to join", description: "Invitations you send appear here until they are accepted." }}
    renderRow={(invitation) => (
      <InvitationRow key={invitation.id} invitation={invitation} canWrite={canWrite} />
    )}
  />
);
