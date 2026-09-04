import type { ReactNode } from "react";

import { Toaster } from "@/components/toaster";
import { Ground } from "@/components/shell/ground";
import { WorkspaceChrome } from "@/components/shell/workspace-chrome";
import { signOut } from "@/features/auth/auth.actions";
import { currentPrincipal } from "@/features/auth/auth.service";
import { liveAgents } from "@/features/agents/agents.service";
import { listLiveCalls, listReviewQueue } from "@/features/calls/calls.service";
import { listNumbers } from "@/features/connect/connect.service";
import { listMembers } from "@/features/org/org.service";
import { withSession } from "@/lib/api/server";

/**
 * The signed-in shell.
 *
 * `currentPrincipal` runs here rather than on each page for two reasons: the
 * chrome needs the organisation, the role and the capabilities anyway, and it
 * is the request that proves the cookie is still good — wrapped in
 * `withSession` so an expired cookie means the sign-in page, not a stack trace.
 *
 * The sidebar counts are fetched here too, in parallel and best-effort:
 * `allSettled`, because a count is decoration and a failing one must never
 * take the shell down with it. Only numbers the API genuinely returns are
 * shown — there is no total-calls endpoint, so Calls carries no badge rather
 * than a made-up one.
 */
const WorkspaceLayout = async ({ children }: { readonly children: ReactNode }) => {
  const me = await withSession(currentPrincipal);

  const [live, review, members, numbers, agents] = await Promise.allSettled([
    listLiveCalls(),
    listReviewQueue(),
    listMembers(),
    listNumbers(),
    liveAgents(),
  ]);

  const counts: Record<string, number> = {};
  if (agents.status === "fulfilled") counts["/agents"] = agents.value.length;
  if (live.status === "fulfilled") counts["/live"] = live.value.length;
  if (review.status === "fulfilled") counts["/review"] = review.value.flagged;
  if (members.status === "fulfilled") counts["/members"] = members.value.items.length;
  if (numbers.status === "fulfilled") counts["/numbers"] = numbers.value.items.length;

  return (
    <>
      <Ground />
      <WorkspaceChrome
        organisation={me.organisation.name}
        user={me.user.displayName}
        role={me.role}
        capabilities={me.capabilities}
        counts={counts}
        signOut={signOut}
      >
        {children}
      </WorkspaceChrome>
      <Toaster />
    </>
  );
};

export default WorkspaceLayout;
