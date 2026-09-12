import { KeyRound, TriangleAlert, UserRound } from "lucide-react";
import type { Metadata } from "next";

import { SectionRail } from "@/components/shell/section-rail";
import { PageHeader, Tag } from "@/components/ui";
import { currentPrincipal } from "@/features/auth/auth.service";
import { DeleteAccountForm, PasswordForm, ProfileForm } from "@/features/auth/components/account-forms";
import { initials } from "@/features/org/invitations.display";

export const metadata: Metadata = { title: "Settings · Ansa" };
export const dynamic = "force-dynamic";

/**
 * Yours, as against the organisation's — the same shape as that page, one section at a time.
 *
 * Three things a signed-in person may do to their own account: change the name they are
 * shown as, change their password, and close the account. Nothing else is theirs alone —
 * the role is the organisation's to set, on the members list; the email is the sign-in
 * identity and changes by invitation. The section is the URL, like every other rail.
 */
const SECTIONS = ["profile", "password", "delete"] as const;
type Section = (typeof SECTIONS)[number];

const AccountPage = async ({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly s?: string }>;
}) => {
  const { s } = await searchParams;
  const section: Section = SECTIONS.includes(s as Section) ? (s as Section) : "profile";
  const me = await currentPrincipal();

  return (
    <>
      <PageHeader
        eyebrow="Settings"
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

      <div className="grid items-start gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <SectionRail
          groups={[
            {
              label: "Account",
              items: [
                { href: "/account", label: "Profile", Icon: UserRound, active: section === "profile" },
                { href: "/account?s=password", label: "Password", Icon: KeyRound, active: section === "password" },
                { href: "/account?s=delete", label: "Delete account", Icon: TriangleAlert, active: section === "delete" },
              ],
            },
          ]}
        />

        <div className="flex min-w-0 flex-col gap-3.5">
          {section === "profile" && <ProfileForm displayName={me.user.displayName} email={me.user.email} />}
          {section === "password" && <PasswordForm />}
          {section === "delete" && <DeleteAccountForm organisationName={me.organisation.name} />}
        </div>
      </div>
    </>
  );
};

export default AccountPage;
