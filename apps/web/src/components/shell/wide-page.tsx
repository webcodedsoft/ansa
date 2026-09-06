"use client";

import { useWidePage } from "@/stores/layout.store";

/**
 * Claim the wide shell from a server-rendered page.
 *
 * `useWidePage` is a hook, so only a client component can call it, and the agent workspace
 * calls it inline because it already is one. A page that is server-rendered has no such
 * seam — hence this: nothing rendered, one effect, released when the page unmounts.
 *
 * Deliberately not a route-based rule in the shell. `/agents/:id` is the same route for a
 * form agent and a flow agent and only one of them wants the width, so the decision lives
 * with whoever knows — which means a page that wants it has to say so.
 */
export const WidePage = (): null => {
  useWidePage();
  return null;
};
