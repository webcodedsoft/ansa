import type { Metadata } from "next";

import { Card, PageHeader, Pagination } from "@/components/ui";
import { currentPrincipal } from "@/features/auth/auth.service";
import { InviteForm } from "@/features/org/components/invite-form";
import { InvitationTable } from "@/features/org/components/invitation-table";
import { listInvitations } from "@/features/org/org.service";
import { readPaging } from "@/lib/paging";

export const metadata: Metadata = { title: "Invitations · Ansa" };
export const dynamic = "force-dynamic";

const InvitationsPage = async ({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly page?: string; readonly perPage?: string }>;
}) => {
  const requested = readPaging(await searchParams);
  const [principal, { items, page, perPage, totalPages, total }] = await Promise.all([
    currentPrincipal(),
    listInvitations(requested.page, requested.perPage),
  ]);
  const canWrite = principal.capabilities.includes("invitations:write");

  return (
    <>
      <PageHeader
        eyebrow="Organisation"
        title="Invitations"
        meta="Pending, accepted and revoked invitations, newest first."
      />

      {canWrite && <InviteForm />}

      <Card className="mt-3.5">
        <InvitationTable invitations={items} canWrite={canWrite} />
      </Card>

      <Pagination
        basePath="/invitations"
        page={page}
        perPage={perPage}
        totalPages={totalPages}
        total={total}
        unit="invitations"
      />
    </>
  );
};

export default InvitationsPage;
