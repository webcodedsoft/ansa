import { DataTable, type Column } from "@/components/ui";

import type { MemberSummary } from "../org.service";
import { MemberRow } from "./member-row";

/**
 * `renderRow` rather than `columns`: a member row is a client component holding
 * its own remove-confirmation state, so it owns its whole `<tr>`. The columns
 * are declared anyway, so the header and the rows cannot drift apart.
 */
const COLUMNS: readonly Column<MemberSummary>[] = [
  { key: "person", header: "Person", cell: () => null },
  { key: "role", header: "Role", cell: () => null },
  { key: "joined", header: "Joined", cell: () => null },
  { key: "actions", header: "Remove", headerHidden: true, cell: () => null },
];

export const MemberTable = ({
  members,
  selfUserId,
  canWrite,
}: {
  readonly members: readonly MemberSummary[];
  readonly selfUserId: string;
  readonly canWrite: boolean;
}) => {
  // Counted within this page only. The API's own refusal is what actually enforces "not the
  // last owner" — this only pre-empts the click when the page in front of the reader already
  // shows the answer, which is the common case since organisations rarely run past one page
  // of members. A last owner sitting on a page not currently loaded still gets the API's 409
  // rather than a UI that let the click through.
  const ownerCount = members.filter((member) => member.role === "owner").length;

  return (
    <DataTable
      rows={members}
      columns={COLUMNS}
      rowKey={(member) => member.userId}
      empty={{ title: "No members", description: "This organisation has nobody in it yet." }}
      renderRow={(member) => (
        <MemberRow
          key={member.userId}
          member={member}
          isSelf={member.userId === selfUserId}
          isLastOwner={member.role === "owner" && ownerCount === 1}
          canWrite={canWrite}
        />
      )}
    />
  );
};
