import type { Metadata } from "next";

import { PageHeader, Tag } from "@/components/ui";
import { currentPrincipal } from "@/features/auth/auth.service";
import { PasswordForm, ProfileForm } from "@/features/auth/components/account-forms";
import { initials } from "@/features/org/invitations.display";

export const metadata: Metadata = { title: "Your account · Ansa" };
export const dynamic = "force-dynamic";

/**
 * Yours, as against the organisation's.
 *
 * Two things a signed-in person may change about themselves — the name they are shown as
 * and their password — and nothing else, because nothing else is theirs alone. The role is
 * the organisation's to set, on the members list; the email is the sign-in identity and
 * changes by invitation. Reached from your name in the sidebar footer.
 */
const AccountPage = async () => {
  const me = await currentPrincipal();

  return (
    <>
      <PageHeader
        eyebrow="Account"
        title={
          <span className="inline-flex items-center gap-3">
            <span
              aria-hidden
              className="grid size-9 place-items-center rounded-full border border-[var(--hairline)] bg-[var(--surface-2)] font-mono text-[13px] font-semibold text-[var(--ink-2)]"
            >
              {initials(me.user.displayName, me.user.email)}
            </span>
            {me.user.displayName}
          </span>
        }
        meta={
          <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="font-mono">{me.user.email}</span>
            <span aria-hidden>·</span>
            <Tag tone={me.role === "owner" ? "accent" : "neutral"}>{me.role}</Tag>
            <span>of {me.organisation.name}</span>
          </span>
        }
      />

      <div className="flex max-w-[56rem] flex-col gap-3.5">
        <ProfileForm displayName={me.user.displayName} email={me.user.email} />
        <PasswordForm />
      </div>
    </>
  );
};

export default AccountPage;
