import { DataTable, type Column } from "@/components/ui";

import type { InvitationSummary } from "../org.service";
import { InvitationRow } from "./invitation-row";

/**
 * `renderRow` rather than `columns`: each row is a client component holding its
 * own revoke-confirmation state, so it has to own its whole `<tr>`. The columns
 * are still declared here so the header cannot drift from what the rows draw.
 */
const COLUMNS: readonly Column<InvitationSummary>[] = [
  { key: "email", header: "Email", cell: (i) => i.email },
  { key: "role", header: "Role", cell: (i) => i.role },
  { key: "status", header: "Status", cell: () => null },
  { key: "expires", header: "Expires", cell: () => null },
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
    empty={{ title: "No invitations", description: "Nobody has been invited yet." }}
    renderRow={(invitation) => (
      <InvitationRow key={invitation.id} invitation={invitation} canWrite={canWrite} />
    )}
  />
);
