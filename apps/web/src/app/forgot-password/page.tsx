import type { Metadata } from "next";
import Link from "next/link";

import { AuthShell } from "@/features/auth/components/auth-shell";
import { ForgotPasswordForm } from "@/features/auth/components/forgot-password-form";

export const metadata: Metadata = { title: "Forgot password · Ansa" };

const ForgotPasswordPage = () => (
  <AuthShell
    title="Forgot your password?"
    subtitle="Tell us the address you sign in with and we will send a link to choose a new one."
    footer={
      <>
        Remembered it?{" "}
        <Link href="/sign-in" className="font-medium text-[var(--accent)] hover:underline">
          Sign in
        </Link>
      </>
    }
  >
    <ForgotPasswordForm />
  </AuthShell>
);

export default ForgotPasswordPage;
