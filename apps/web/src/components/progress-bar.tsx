"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import LoadingBar, { type LoadingBarRef } from "react-top-loading-bar";

import { useProgressStore } from "@/stores/progress.store";

/**
 * The bar across the top of every page.
 *
 * `react-top-loading-bar` is passive — a ref with `continuousStart` and `complete` — so all
 * of this is about deciding when to call them. App Router has no router events, and
 * `useLinkStatus` only reports from inside a `Link` descendant, which would mean wrapping
 * every link in twenty-two files. So navigation is caught where every navigation passes
 * regardless of which component rendered it: the click, and the URL that follows.
 *
 * Forms do not come through here at all. `SubmitButton` already receives `pending`, and it
 * reports its own — one seam covering every `useActionState` form in the app.
 */

/**
 * How long a navigation may hold the bar before it is released anyway.
 *
 * Nothing here can prove a navigation *failed*. A click the router declines to act on, a
 * redirect back to the page you were already on, a server that never answers — each leaves
 * a token nothing will ever release, and a bar that runs forever reads as a broken app
 * rather than a slow one. Generous enough that a genuinely slow page still finishes first.
 */
const GIVE_UP_MS = 20_000;

/** A click the browser, not the router, is going to handle. */
const handledByBrowser = (event: MouseEvent, anchor: HTMLAnchorElement): boolean =>
  // Middle-click and modified clicks open elsewhere; this tab is not going anywhere.
  event.button !== 0 ||
  event.metaKey ||
  event.ctrlKey ||
  event.shiftKey ||
  event.altKey ||
  event.defaultPrevented ||
  anchor.target === "_blank" ||
  anchor.hasAttribute("download") ||
  // `mailto:`, `tel:` and friends leave the app entirely.
  !anchor.protocol.startsWith("http");

export const ProgressBar = () => {
  const bar = useRef<LoadingBarRef>(null);
  const running = useRef(false);

  const active = useProgressStore((store) => store.active);
  const navigating = useProgressStore((store) => store.navigating);
  const beginNavigation = useProgressStore((store) => store.beginNavigation);
  const endNavigation = useProgressStore((store) => store.endNavigation);

  const pathname = usePathname();
  const searchParams = useSearchParams();

  /* Start a navigation from the click rather than from a component, so a link added to any
     page later is covered without knowing this exists. Capture phase, because a handler on
     the way down still sees the event if something below calls `stopPropagation`. */
  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a");
      if (anchor === null || !anchor.href) return;
      if (handledByBrowser(event, anchor)) return;

      const next = new URL(anchor.href);
      if (next.origin !== window.location.origin) return;
      /* A link to where you already are, or to a fragment on this page, renders nothing new
         and changes no URL — so nothing would ever complete the bar. Same-document scrolling
         is not loading, and showing progress for it is a lie. */
      if (next.pathname === window.location.pathname && next.search === window.location.search) {
        return;
      }

      beginNavigation();
    };

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [beginNavigation]);

  /* The URL changed, so whatever was navigating has arrived. This also catches the
     navigations no click produced — `router.push` from the command palette, and the
     `redirect()` at the end of a server action. */
  const url = `${pathname}?${searchParams}`;
  useEffect(() => {
    endNavigation();
  }, [url, endNavigation]);

  useEffect(() => {
    if (!navigating) return;
    const timer = setTimeout(endNavigation, GIVE_UP_MS);
    return () => clearTimeout(timer);
  }, [navigating, endNavigation]);

  /* Guarded on both sides. `continuousStart` restarts the animation from zero, so calling it
     again for a second concurrent token would jerk a bar that is already most of the way
     across; `complete` on an idle bar re-runs its fade. */
  useEffect(() => {
    if (active > 0 && !running.current) {
      running.current = true;
      bar.current?.continuousStart();
      return;
    }
    if (active === 0 && running.current) {
      running.current = false;
      bar.current?.complete();
    }
  }, [active]);

  return (
    <LoadingBar
      ref={bar}
      color="var(--accent)"
      height={2}
      shadow={false}
      waitingTime={200}
      transitionTime={200}
      /* Above the toast stack and the command palette, both of which sit at 50. A bar the
         palette's backdrop covers is a bar nobody sees during the navigation it started. */
      style={{ zIndex: 60 }}
    />
  );
};
