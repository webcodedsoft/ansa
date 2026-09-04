"use client";

import { useEffect } from "react";
import { create } from "zustand";

/**
 * How wide the page may be.
 *
 * Every page in this console reads at a column width, and the shell enforces one. A flow
 * agent's workspace is a drawing surface, and a drawing inside 1080 pixels is a drawing
 * nobody can see. The shell cannot tell from the route which kind of agent a page is
 * about — `/agents/:id` is the same route for both — so the page says.
 */
interface LayoutStore {
  readonly wide: boolean;
  readonly setWide: (wide: boolean) => void;
}

export const useLayoutStore = create<LayoutStore>((set) => ({
  wide: false,
  setWide: (wide) => set({ wide }),
}));

/** Claim the width for as long as the calling component is mounted and `wide` holds. */
export const useWidePage = (wide = true): void => {
  const setWide = useLayoutStore((store) => store.setWide);
  useEffect(() => {
    setWide(wide);
    return () => setWide(false);
  }, [setWide, wide]);
};
