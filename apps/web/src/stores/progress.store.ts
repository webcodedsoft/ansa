"use client";

import { useEffect } from "react";
import { create } from "zustand";

/**
 * Whether anything is in flight, for the bar across the top of every page.
 *
 * Every page in this console is an async server component and none of them has a
 * `loading.tsx`, so a click on a nav link renders nothing new until the server has finished
 * the whole page. The old screen just sits there. This is the feedback that was missing, and
 * the reason it lives in a store is that the two things that make the app busy are nowhere
 * near each other in the tree: navigation is intercepted at the document, and a form's
 * pending state belongs to a `SubmitButton` somewhere deep inside a page.
 *
 * **A count, not a flag.** A publish can be saving while a nav is pending, and a form that
 * ends in `redirect()` is both at once. A boolean would clear on whichever finished first
 * and leave the bar gone with work still running.
 *
 * **Navigation holds at most one token.** Clicking three links before the first lands is
 * ordinary, and each click would otherwise add a token that only one URL change ever
 * releases — the bar would then never complete. `beginNavigation` is idempotent for that
 * reason, and so is its opposite.
 */

interface ProgressStore {
  /** How many things are in flight. The bar runs while this is above zero. */
  readonly active: number;
  /** Whether one of those things is a page navigation. */
  readonly navigating: boolean;
  readonly begin: () => void;
  readonly end: () => void;
  readonly beginNavigation: () => void;
  readonly endNavigation: () => void;
}

export const useProgressStore = create<ProgressStore>((set) => ({
  active: 0,
  navigating: false,
  begin: () => set((state) => ({ active: state.active + 1 })),
  // Floored at zero: an `end` without a `begin` is a bug, but a negative count would keep the
  // bar hidden through the next real one, which is a worse way to find out.
  end: () => set((state) => ({ active: Math.max(0, state.active - 1) })),
  beginNavigation: () =>
    set((state) => (state.navigating ? state : { navigating: true, active: state.active + 1 })),
  endNavigation: () =>
    set((state) =>
      state.navigating ? { navigating: false, active: Math.max(0, state.active - 1) } : state,
    ),
}));

/**
 * Run the bar for as long as `pending` is true.
 *
 * The cleanup is the part that matters. A form that submits and then redirects unmounts while
 * still pending, and an `end()` written in the effect body would never run — the counter would
 * sit above zero and the bar would spin for the rest of the session. Returning `end` releases
 * the token on unmount as well as on completion.
 */
export const useProgressWhile = (pending: boolean): void => {
  const begin = useProgressStore((store) => store.begin);
  const end = useProgressStore((store) => store.end);

  useEffect(() => {
    if (!pending) return;
    begin();
    return end;
  }, [pending, begin, end]);
};
