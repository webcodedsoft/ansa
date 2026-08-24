"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * The landing page's two motion primitives.
 *
 * Both exist because CSS alone cannot do this everywhere. Scroll-driven animations
 * (`animation-timeline`) are Chrome and Safari; a landing page whose signature effect only
 * fires in some browsers reads as broken in the rest. These are deliberately tiny: they
 * measure scroll and toggle state, and every visual decision stays in page.module.css.
 *
 * Both are progressive. Server markup renders complete and visible; an inline script adds
 * `js` to <html>, and only under `html.js` does the stylesheet hide anything — so with
 * JavaScript disabled the page is simply static, never blank.
 */

/** Adds the global class `in` when the element enters the viewport, once. */
export const Reveal = ({
  className,
  children,
}: {
  readonly className?: string;
  readonly children: ReactNode;
}) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (typeof IntersectionObserver === "undefined") {
      el.classList.add("in");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            el.classList.add("in");
            io.disconnect();
          }
        }
      },
      // Fire a little before the element's top clears the fold, so the motion is seen
      // rather than already finished.
      { rootMargin: "0px 0px -10% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
};

/**
 * Scroll progress through a tall wrapper, handed to CSS.
 *
 * Sets `--p` (0..1, continuous) and `data-step` (discrete, 0..steps-1) on itself as the
 * viewport scrolls through it. The stylesheet couples geometry to `--p` — the isometric
 * stack swings and spreads with the scroll itself, not on a timer — and swaps step states
 * off `data-step`.
 *
 * Deliberately not rAF-throttled. An earlier version queued updates through
 * requestAnimationFrame, and in an occluded tab rAF frames are starved entirely — the
 * queue flag stayed set and the scene froze at whatever progress it had. Scroll events
 * already arrive at most once per frame, and the work is one getBoundingClientRect on one
 * element, so the throttle bought nothing and cost correctness.
 */
export const ScrollScene = ({
  className,
  steps,
  id,
  children,
}: {
  readonly className?: string;
  readonly steps: number;
  readonly id?: string;
  readonly children: ReactNode;
}) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;

    const update = (): void => {
      const rect = el.getBoundingClientRect();
      const span = rect.height - window.innerHeight;
      const progress = span > 0 ? Math.min(1, Math.max(0, -rect.top / span)) : 1;
      el.style.setProperty("--p", progress.toFixed(4));
      el.dataset["step"] = String(Math.min(steps - 1, Math.floor(progress * steps)));
    };

    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [steps]);

  return (
    <div ref={ref} id={id} className={className} data-step="0">
      {children}
    </div>
  );
};
