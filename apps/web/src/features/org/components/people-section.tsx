import { Crown, MailPlus, ShieldCheck, Users } from "lucide-react";

import { Card, Pagination, Stat } from "@/components/ui";
import { currentPrincipal } from "@/features/auth/auth.service";
import { readPaging } from "@/lib/paging";

import { pendingFirst, statusOf } from "../invitations.display";
import { listInvitations, listMembers } from "../org.service";
import { InvitationTable } from "./invitation-table";
import { MemberTable } from "./member-table";

/**
 * Who is in this organisation, and who has been asked.
 *
 * A section of the organisation page rather than a page of its own: the people are a fact
 * about the company like its hours and its recording switch, and the rail is where those
 * facts live. Inviting is the page header's one action, so this section does not repeat it.
 *
 * Members and invitations are one card each, because they are one question — look at who
 * is here, notice who is missing, see whether they have accepted. Invitations are not paged:
 * there are rarely more than a handful outstanding, and the ones that matter — pending —
 * sort first. The first hundred are fetched; the count in the card's header says if there
 * are more, which is a state nobody has reached.
 */
const INVITATIONS_SHOWN = 100;

export const PeopleSection = async ({
  paging,
}: {
  readonly paging: { readonly page?: string; readonly perPage?: string };
}) => {
  const requested = readPaging(paging);
  const [principal, members, invitations] = await Promise.all([
    currentPrincipal(),
    listMembers(requested.page, requested.perPage),
    listInvitations(1, INVITATIONS_SHOWN),
  ]);
  const canEditMembers = principal.capabilities.includes("members:write");
  const canInvite = principal.capabilities.includes("invitations:write");

  const now = Date.now();
  const ordered = pendingFirst(invitations.items, now);
  const pending = ordered.filter((one) => statusOf(one, now) === "pending").length;
  const owners = members.items.filter((one) => one.role === "owner").length;
  const admins = members.items.filter((one) => one.role === "admin").length;

  return (
    <>
      <div className="grid gap-3.5 sm:grid-cols-4">
        <Stat label="People" value={members.total} icon={<Users />} />
        <Stat label="Owners" value={owners} icon={<Crown />} />
        <Stat label="Admins" value={admins} icon={<ShieldCheck />} />
        <Stat label="Awaiting a reply" value={pending} icon={<MailPlus />} />
      </div>

      <Card
        title="People"
        description="The role each person holds. Owners and admins can change roles; the last owner can never be demoted or removed."
        bodyClassName="p-0"
        actions={
          <span className="text-[12px] text-[var(--ink-3)] tabular-nums">
            {members.total} {members.total === 1 ? "person" : "people"}
          </span>
        }
      >
        <MemberTable
          members={members.items}
          selfUserId={principal.user.id}
          canWrite={canEditMembers}
        />
      </Card>

      <Pagination
        basePath="/organisation"
        params={{ s: "people" }}
        page={members.page}
        perPage={members.perPage}
        totalPages={members.totalPages}
        total={members.total}
        unit="members"
      />

      <Card
        title="Invitations"
        bodyClassName="p-0"
        actions={
          <span className="text-[12px] text-[var(--ink-3)] tabular-nums">
            {pending === 0 ? "none pending" : `${pending} pending`}
            {invitations.total > INVITATIONS_SHOWN
              ? ` · showing ${INVITATIONS_SHOWN} of ${invitations.total}`
              : ""}
          </span>
        }
      >
        <InvitationTable invitations={ordered} canWrite={canInvite} />
      </Card>
    </>
  );
};
