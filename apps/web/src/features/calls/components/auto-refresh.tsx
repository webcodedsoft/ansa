"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Keeps a server-rendered page current without a push feed.
 *
 * There is no live endpoint. "Live" here means re-rendering the page on an interval and
 * trusting the page's own `dynamic`/`revalidate` export to skip the cache each time.
 * `router.refresh()` re-runs the Server Component in place — no full navigation, no lost
 * scroll position, no flash of an empty page while it loads.
 */
export const AutoRefresh = ({ intervalMs }: { readonly intervalMs: number }) => {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);

  return null;
};
