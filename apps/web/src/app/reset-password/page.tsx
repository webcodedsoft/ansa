import type { Metadata } from "next";
import Link from "next/link";

import { Notice } from "@/components/ui";
import { AuthShell } from "@/features/auth/components/auth-shell";
import { ResetPasswordForm } from "@/features/auth/components/reset-password-form";

export const metadata: Metadata = { title: "Choose a new password · Ansa" };

/**
 * Where the reset link lands. The token travels in the query string because that is what a
 * link can carry; it goes straight into a hidden field and is never rendered.
 */
const ResetPasswordPage = async ({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly token?: string }>;
}) => {
  const { token } = await searchParams;

  return (
    <AuthShell
      title="Choose a new password"
      subtitle="This signs you out everywhere else, so whoever had the old one is gone too."
    >
      {token === undefined || token === "" ? (
        <div className="flex flex-col gap-3.5">
          <Notice tone="error">
            This link has no reset token. Open the link exactly as it was sent to you, or ask for a new one.
          </Notice>
          <Link href="/forgot-password" className="text-sm text-[var(--ink-3)] hover:underline">
            Ask for a new link
          </Link>
        </div>
      ) : (
        <ResetPasswordForm token={token} />
      )}
    </AuthShell>
  );
};

export default ResetPasswordPage;
