import type { Metadata } from "next";
import { Suspense } from "react";
import type { ReactNode } from "react";

import { ProgressBar } from "@/components/progress-bar";

import "./globals.css";

export const metadata: Metadata = {
  title: "Ansa",
  description: "Configure the agent, place a test call, and read what happened.",
};

/**
 * Mounted here rather than in the workspace shell so signing in and accepting an invitation
 * get the bar too — those are the slowest requests in the app and the ones a person is least
 * sure worked.
 *
 * The Suspense boundary is required, not decorative: `ProgressBar` reads `useSearchParams`,
 * and a client component that does so without one opts every page below it out of static
 * rendering. `null` is the right fallback — a progress bar that has not loaded has nothing
 * to say.
 */
const RootLayout = ({ children }: { readonly children: ReactNode }) => (
  <html lang="en">
    <body>
      <Suspense fallback={null}>
        <ProgressBar />
      </Suspense>
      {children}
    </body>
  </html>
);

export default RootLayout;
