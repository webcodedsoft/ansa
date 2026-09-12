import { Crown, MailPlus, ShieldCheck, Users } from "lucide-react";
import type { Metadata } from "next";

import { Card, PageHeader, Pagination, Stat } from "@/components/ui";
import { currentPrincipal } from "@/features/auth/auth.service";
import { InvitationTable } from "@/features/org/components/invitation-table";
import { InviteMember } from "@/features/org/components/invite-form";
import { MemberTable } from "@/features/org/components/member-table";
import { pendingFirst, statusOf } from "@/features/org/invitations.display";
import { listInvitations, listMembers } from "@/features/org/org.service";
import { readPaging } from "@/lib/paging";

export const metadata: Metadata = { title: "Members · Ansa" };
export const dynamic = "force-dynamic";

/**
 * Who is in this organisation, and who has been asked.
 *
 * One page, because they are one question. "Invitations" was its own screen with its own
 * form, and the thing a person actually does — look at who is here, notice who is missing,
 * invite them, see whether they have accepted — was spread over two. Now the people are the
 * page, inviting is the header's one action, and what is outstanding sits underneath.
 *
 * Invitations are not paged. There are rarely more than a handful outstanding, and the ones
 * that matter — pending — sort first. The first hundred are fetched; the count in the card's
 * header says if there are more, which is a state nobody has reached.
 */
const INVITATIONS_SHOWN = 100;

const MembersPage = async ({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly page?: string; readonly perPage?: string }>;
}) => {
  const requested = readPaging(await searchParams);
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
      <PageHeader
        eyebrow="Organisation"
        title="Members"
        actions={canInvite ? <InviteMember /> : undefined}
        meta="Who is in this organisation and the role each person holds. Owners and admins can change roles; the last owner can never be demoted or removed."
      />

      <div className="grid gap-3.5 sm:grid-cols-4">
        <Stat label="People" value={members.total} icon={<Users />} />
        <Stat label="Owners" value={owners} icon={<Crown />} />
        <Stat label="Admins" value={admins} icon={<ShieldCheck />} />
        <Stat label="Awaiting a reply" value={pending} icon={<MailPlus />} />
      </div>

      <Card
        title="People"
        className="mt-[26px]"
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
        basePath="/members"
        page={members.page}
        perPage={members.perPage}
        totalPages={members.totalPages}
        total={members.total}
        unit="members"
      />

      <Card
        title="Invitations"
        className="mt-3.5"
        bodyClassName="p-0"
        actions={
          <span className="text-[12px] text-[var(--ink-3)] tabular-nums">
            {pending === 0
              ? "none pending"
              : `${pending} pending`}
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

export default MembersPage;
