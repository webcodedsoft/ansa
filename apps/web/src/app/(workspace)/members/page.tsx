import type { Metadata } from "next";
import Link from "next/link";

import { Card, PageHeader, Pagination } from "@/components/ui";
import { currentPrincipal } from "@/features/auth/auth.service";
import { MemberTable } from "@/features/org/components/member-table";
import { listMembers } from "@/features/org/org.service";
import { readPaging } from "@/lib/paging";

export const metadata: Metadata = { title: "Members · Ansa" };
export const dynamic = "force-dynamic";

const MembersPage = async ({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly page?: string; readonly perPage?: string }>;
}) => {
  const requested = readPaging(await searchParams);
  const [principal, { items, page, perPage, totalPages, total }] = await Promise.all([
    currentPrincipal(),
    listMembers(requested.page, requested.perPage),
  ]);
  const canWrite = principal.capabilities.includes("members:write");

  return (
    <>
      <PageHeader
        eyebrow="Organisation"
        title="Members"
        actions={
          <Link href="/invitations" className="inline-flex h-[34px] items-center rounded-lg border border-[var(--hairline)] bg-[var(--glass-hi)] px-3.5 text-sm font-medium shadow-[var(--spec)]">
            Invite someone
          </Link>
        }
        meta="Who is in this organisation, and the role each person holds. Owners and admins can change roles; the last owner can never be demoted or removed."
      />

      <Card>
        <MemberTable members={items} selfUserId={principal.user.id} canWrite={canWrite} />
      </Card>

      <Pagination
        basePath="/members"
        page={page}
        perPage={perPage}
        totalPages={totalPages}
        total={total}
        unit="members"
      />
    </>
  );
};

export default MembersPage;
