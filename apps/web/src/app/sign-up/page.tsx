import type { Metadata } from "next";
import Link from "next/link";

import { AuthShell } from "@/features/auth/components/auth-shell";
import { SignUpForm } from "@/features/auth/components/sign-up-form";

export const metadata: Metadata = { title: "Create an organisation · Ansa" };

/**
 * One of exactly two ways into the product; `/accept-invitation` is the other.
 * Neither is a general-purpose registration form — a person exists only as the
 * owner of an organisation or as somebody's invitee, which is enforced by the
 * database rather than by this page.
 */
const SignUpPage = () => (
  <AuthShell
    title="Create an organisation"
    subtitle="Set up the organisation and the account that owns it."
    footer={
      <>
        Already have an account?{" "}
        <Link href="/sign-in" className="font-medium text-[var(--accent)] hover:underline">
          Sign in
        </Link>
        . Been invited? Use the link you were sent.
      </>
    }
  >
    <SignUpForm />
  </AuthShell>
);

export default SignUpPage;
