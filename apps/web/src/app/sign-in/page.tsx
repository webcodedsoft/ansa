import type { Metadata } from "next";
import Link from "next/link";

import { Notice } from "@/components/ui";
import { AuthShell } from "@/features/auth/components/auth-shell";
import { SignInForm } from "@/features/auth/components/sign-in-form";

export const metadata: Metadata = { title: "Sign in · Ansa" };

const SignInPage = async ({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly reset?: string }>;
}) => {
  const { reset } = await searchParams;
  return (
  <AuthShell
    title="Sign in to Ansa"
    subtitle="Answer and place calls with an agent your organisation configures."
    footer={
      <>
        No account yet?{" "}
        <Link href="/sign-up" className="font-medium text-[var(--accent)] hover:underline">
          Create an organisation
        </Link>
        , or use the invitation link you were sent to join one.
      </>
    }
  >
    {reset === "done" && (
      <div className="mb-4">
        <Notice tone="ok">Your password is changed. Sign in with it now — every other session was signed out.</Notice>
      </div>
    )}
    <SignInForm />
  </AuthShell>
  );
};

export default SignInPage;
