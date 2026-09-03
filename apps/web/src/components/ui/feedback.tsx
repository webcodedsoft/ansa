import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "@/lib/cn";

export type Tone = "neutral" | "ok" | "warn" | "bad" | "accent";

const TONES: Record<Tone, string> = {
  neutral: "bg-[var(--surface-2)] text-[var(--ink-2)] border-[var(--hairline)]",
  ok: "bg-[var(--ok-soft)] text-[var(--ok)] border-[color-mix(in_srgb,var(--ok)_28%,transparent)]",
  warn: "bg-[var(--warn-soft)] text-[var(--warn)] border-[color-mix(in_srgb,var(--warn)_30%,transparent)]",
  bad: "bg-[var(--bad-soft)] text-[var(--bad)] border-[color-mix(in_srgb,var(--bad)_28%,transparent)]",
  accent: "bg-[var(--accent-soft)] text-[var(--accent)] border-[color-mix(in_srgb,var(--accent)_34%,transparent)]",
};

/**
 * `info` is not a quieter `warn`.
 *
 * There were three tones, all of which said something had gone right or wrong, so a plain
 * statement of fact — this agent is built as a flow, its questions live on the canvas — had
 * to borrow the warning triangle. Nothing is wrong in that sentence, and an icon that says
 * otherwise teaches people to ignore the ones that mean it.
 */
export type NoticeTone = "error" | "ok" | "warn" | "info";

const NOTICES = {
  error: { tone: TONES.bad, Icon: CircleAlert },
  ok: { tone: TONES.ok, Icon: CircleCheck },
  warn: { tone: TONES.warn, Icon: TriangleAlert },
  info: { tone: TONES.neutral, Icon: Info },
} as const;

/**
 * A message about what just happened.
 *
 * The ARIA role follows the tone rather than being the caller's to pass: a
 * failure is announced assertively, a success politely. Callers got this
 * backwards when it was theirs to choose, and a screen reader interrupting
 * somebody mid-sentence to say "published" is worse than staying quiet.
 */
export const Notice = ({
  tone,
  className,
  children,
}: {
  readonly tone: NoticeTone;
  readonly className?: string;
  readonly children: ReactNode;
}) => {
  const { tone: toneClass, Icon } = NOTICES[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn("flex gap-2.5 rounded-lg border p-3 text-[13.5px] leading-relaxed", toneClass, className)}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
};

export const Tag = ({ tone = "neutral", children }: { readonly tone?: Tone; readonly children: ReactNode }) => (
  <span
    className={cn(
      "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11.5px] font-medium whitespace-nowrap",
      TONES[tone],
    )}
  >
    {children}
  </span>
);

/** A status dot. `pulse` marks something happening right now, like a live call. */
export const Blip = ({ pulse = false }: { readonly pulse?: boolean }) => (
  <span className={cn("size-1.5 rounded-full bg-current", pulse && "animate-pulse")} />
);

export const EmptyState = ({
  title,
  children,
  action,
}: {
  readonly title: ReactNode;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
}) => (
  <div className="px-6 py-14 text-center">
    <h3 className="mb-1.5 text-[15.5px] font-semibold tracking-[-0.015em]">{title}</h3>
    {children !== undefined && (
      <p className="mx-auto mb-4 max-w-[44ch] text-[13.5px] text-[var(--ink-3)]">{children}</p>
    )}
    {action}
  </div>
);

/**
 * A table that scrolls itself.
 *
 * The wrapper is not optional styling: without it a wide table widens the page
 * and drags the sidebar with it, which reads as a layout fault rather than a
 * long value in one cell.
 */
export const Table = ({ children }: { readonly children: ReactNode }) => (
  <div className="overflow-x-auto">
    <table className="w-full border-collapse text-[13.5px]">{children}</table>
  </div>
);

export const Th = ({ className, ...rest }: ComponentPropsWithoutRef<"th">) => (
  <th
    className={cn(
      // Opaque, not `--surface`: a sticky header at 90% lets rows scroll
      // through it, which looks like a rendering fault.
      "sticky top-0 border-b border-[var(--hairline)] bg-[var(--surface-solid)] px-[18px] py-3",
      "text-left font-mono text-[10px] font-medium tracking-[0.11em] whitespace-nowrap text-[var(--ink-3)] uppercase",
      className,
    )}
    {...rest}
  />
);

export const Td = ({ className, ...rest }: ComponentPropsWithoutRef<"td">) => (
  <td className={cn("border-b border-[var(--surface-line)] px-[18px] py-3.5 align-middle", className)} {...rest} />
);

/**
 * A heading for a run of rows, living inside the table rather than above it.
 *
 * The alternative — a separate `<table>` per group — is what this replaces, and it
 * has two real faults. Each table sizes its own columns, so the day you are reading
 * does not line up with the day above it unless every width is pinned by hand. And
 * the header row belongs to the first table only, so everything below the first
 * group is a set of unlabelled columns.
 *
 * `columns` must cover every column in the table; a short span leaves a hole the
 * rows show through.
 */
export const GroupRow = ({
  label,
  columns,
  action,
}: {
  readonly label: ReactNode;
  readonly columns: number;
  /** Right-aligned, past a rule. A count, usually. */
  readonly action?: ReactNode;
}) => (
  // No top border on the first one: the header row already drew that line, and two
  // hairlines a pixel apart read as a rendering fault rather than a divider.
  <tr className="first:[&>td]:border-t-0">
    <td
      colSpan={columns}
      className="border-y border-[var(--hairline)] bg-[var(--surface-2)] px-[18px] py-2"
    >
      <div className="flex items-center gap-3">
        <span className="flex-none font-mono text-[10px] font-semibold tracking-[0.11em] text-[var(--ink-2)] uppercase">
          {label}
        </span>
        <span aria-hidden className="h-px flex-1 bg-[var(--hairline)]" />
        {action}
      </div>
    </td>
  </tr>
);

/** A body row. `onClick` makes it look and behave like the link it becomes. */
export const Tr = ({ className, ...rest }: ComponentPropsWithoutRef<"tr">) => (
  <tr
    className={cn(
      "transition-colors last:[&>td]:border-b-0 hover:bg-[var(--surface-2)]",
      rest.onClick !== undefined && "cursor-pointer",
      className,
    )}
    {...rest}
  />
);
