import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Surfaces and page structure.
 *
 * `Panel` is the content layer and `GlassPanel` is the control layer. The
 * difference is not decorative: a panel holding a transcript must not blur what
 * is behind it, and a toolbar floating over scrolling content should.
 */

/** `id` is accepted so a panel can be an anchor target — a header action that
 *  jumps to the control it names needs somewhere to land. */
interface SurfaceProps {
  readonly className?: string;
  readonly id?: string;
  readonly children: ReactNode;
}

export const Panel = ({ className, id, children }: SurfaceProps) => (
  <section id={id} className={cn("surface overflow-hidden rounded-[18px]", className)}>
    {children}
  </section>
);

export const GlassPanel = ({ className, id, children }: SurfaceProps) => (
  <section id={id} className={cn("glass rounded-[18px]", className)}>
    {children}
  </section>
);

/** Padding for a panel holding prose or form fields rather than a table. */
export const PanelBody = ({ className, children }: { readonly className?: string; readonly children: ReactNode }) => (
  <div className={cn("px-[26px] py-6", className)}>{children}</div>
);

/**
 * A panel with a heading block.
 *
 * `description` is a prop rather than the first child because it is styled as
 * part of the heading. Leaving it to callers produced two different spacings
 * on two pages the first time this markup was copied, which is the argument
 * for a component rather than a convention.
 */
export const Card = ({
  title,
  description,
  actions,
  className,
  children,
}: {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}) => (
  <Panel className={cn("p-5", className)}>
    {(title !== undefined || actions !== undefined) && (
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          {title !== undefined && <h2 className="text-base font-semibold tracking-tight">{title}</h2>}
          {description !== undefined && (
            <p className="mt-1 text-sm text-[var(--ink-3)]">{description}</p>
          )}
        </div>
        {actions}
      </div>
    )}
    {children}
  </Panel>
);

/**
 * The page header, and the placement rule the whole app follows: eyebrow,
 * title, one description line, all flush on the same left axis; actions right,
 * optically aligned to the title.
 */
export const PageHeader = ({
  eyebrow,
  title,
  meta,
  actions,
}: {
  readonly eyebrow?: ReactNode;
  readonly title: ReactNode;
  readonly meta?: ReactNode;
  readonly actions?: ReactNode;
}) => (
  <header className="mb-6 flex items-start justify-between gap-6">
    <div className="min-w-0">
      {eyebrow !== undefined && (
        // Muted rather than accent-coloured: it is a locator, not the headline,
        // and at full accent it pulls the eye before the title does.
        <p className="mb-2 font-mono text-[10.5px] font-medium tracking-[0.15em] text-[var(--ink-3)] uppercase">
          {eyebrow}
        </p>
      )}
      <h1 className="text-[31px] leading-[1.1] font-[650] tracking-[-0.032em] text-balance">{title}</h1>
      {meta !== undefined && (
        <p className="mt-2 max-w-[62ch] text-[14.5px] leading-relaxed text-[var(--ink-2)]">{meta}</p>
      )}
    </div>
    {actions !== undefined && <div className="flex flex-none gap-2 pt-6">{actions}</div>}
  </header>
);

/** A small-caps label with a hairline filling the rest of the width. */
export const SectionHead = ({ children, action }: { readonly children: ReactNode; readonly action?: ReactNode }) => (
  <div className="mt-[30px] mb-3 flex items-center gap-3 first:mt-0">
    <h2 className="flex-none text-[11px] font-semibold tracking-[0.11em] text-[var(--ink-3)] uppercase">
      {children}
    </h2>
    <span className="h-px flex-1 bg-[var(--hairline)]" />
    {action}
  </div>
);

export const Stack = ({
  gap = "md",
  className,
  children,
}: {
  readonly gap?: "sm" | "md";
  readonly className?: string;
  readonly children: ReactNode;
}) => <div className={cn("flex flex-col", gap === "sm" ? "gap-2" : "gap-3.5", className)}>{children}</div>;

export const Row = ({ className, children }: { readonly className?: string; readonly children: ReactNode }) => (
  <div className={cn("flex flex-wrap items-center gap-2.5", className)}>{children}</div>
);

/** A headline number with its trend. The unit is muted so the figure reads first. */
export const Stat = ({
  label,
  value,
  unit,
  trend,
  tone = "flat",
}: {
  readonly label: ReactNode;
  readonly value: ReactNode;
  readonly unit?: string;
  readonly trend?: ReactNode;
  readonly tone?: "up" | "down" | "flat";
}) => (
  <GlassPanel className="px-5 py-[18px]">
    <div className="text-[12px] text-[var(--ink-3)]">{label}</div>
    {/* The figure carries the card, so it is set well above the label rather than a step
        up from it — at 27px the two read as one block and the eye has nowhere to land. */}
    <div className="mt-1.5 text-[33px] leading-[1.05] font-[680] tracking-[-0.035em] tabular-nums">
      {value}
      {unit !== undefined && (
        <span className="ml-0.5 text-[15px] font-medium text-[var(--ink-3)]">{unit}</span>
      )}
    </div>
    {trend !== undefined && (
      <div
        className={cn(
          "mt-1.5 text-xs",
          tone === "up" && "text-[var(--ok)]",
          tone === "down" && "text-[var(--bad)]",
          tone === "flat" && "text-[var(--ink-3)]",
        )}
      >
        {trend}
      </div>
    )}
  </GlassPanel>
);
