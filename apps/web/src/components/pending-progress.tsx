"use client";

import { useProgressWhile } from "@/stores/progress.store";

/**
 * Reports a form's pending state to the bar at the top of the page, and renders nothing.
 *
 * This exists as its own file because of the rule at the top of `components/ui/button.tsx`:
 * nothing in the kit carries `"use client"`, so that every piece renders in a Server
 * Component and a Client Component alike. A hook in `SubmitButton` would have ended that.
 * A client child does not — a Server Component may render one, and the kit file stays
 * directive-free.
 *
 * It sits beside `toaster.tsx` rather than in the kit for the same reason the toaster does:
 * both are app chrome that happens to be triggered from deep inside a page.
 */
export const PendingProgress = ({ pending }: { readonly pending: boolean }) => {
  useProgressWhile(pending);
  return null;
};
