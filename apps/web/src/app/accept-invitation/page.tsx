import type { Metadata } from "next";
import Link from "next/link";

import { Notice } from "@/components/ui";
import { AcceptInvitationForm } from "@/features/auth/components/accept-invitation-form";
import { AuthShell } from "@/features/auth/components/auth-shell";

export const metadata: Metadata = { title: "Accept invitation · Ansa" };

/**
 * The front door for somebody joining an organisation that already exists.
 *
 * The token arrives in the query string because that is what a link can carry.
 * It goes straight into a hidden field and is never rendered — it is a bearer
 * credential, and a page that displayed it would encourage copying it
 * somewhere it should not go.
 */
const AcceptInvitationPage = async ({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly token?: string }>;
}) => {
  const { token } = await searchParams;

  return (
    <AuthShell title="Set up your account" subtitle="Join the organisation that invited you.">
      {token === undefined || token === "" ? (
        <div className="flex flex-col gap-3.5">
          <Notice tone="error">
            This link has no invitation token. Open the link exactly as it was sent to you, or
            ask for a new one.
          </Notice>
          <Link href="/sign-in" className="text-sm text-[var(--ink-3)] hover:underline">
            Already have an account? Sign in
          </Link>
        </div>
      ) : (
        <AcceptInvitationForm token={token} />
      )}
    </AuthShell>
  );
};

export default AcceptInvitationPage;
