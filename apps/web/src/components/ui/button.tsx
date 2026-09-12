import { Loader2 } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { PendingProgress } from "@/components/pending-progress";
import { cn } from "@/lib/cn";

/**
 * Buttons.
 *
 * Nothing in `components/ui` carries `"use client"`. None of it holds state or
 * takes a handler of its own, so every piece renders in a Server Component and
 * in a Client Component alike — which is what makes the kit shared rather than
 * one set per half of the tree. Anything needing `useState` belongs to a
 * feature, not here.
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

/*
 * One solid button, everything else a hairline.
 *
 * These used to be filled pills: `secondary` a blurred glass surface with its own shadow,
 * `primary` a gradient with an inset highlight and a coloured glow beneath. Five of them in
 * a row — which is what an agent header actually holds — read as five things of equal
 * importance, and the accent one had to shout over the others to be found.
 *
 * So the emphasis now comes from fill rather than from decoration: exactly one button on a
 * screen is solid, and the rest are an outline of the same shape. The radius is tight
 * against the soft panels they sit on, which is what keeps a control reading as a control.
 */
const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "border-transparent bg-[var(--accent)] text-[var(--accent-on)] font-semibold " +
    "hover:brightness-[1.06]",
  secondary: "bg-transparent border-[var(--hairline)] text-[var(--ink)] hover:border-[var(--hairline-hi)]",
  ghost:
    "border-transparent bg-transparent text-[var(--ink-2)] hover:bg-[var(--glass-hi)] hover:text-[var(--ink)]",
  /* Outlined like the rest rather than filled, so destructive reads as a different colour of
     the same control and not as a second kind of emphasis competing with the accent. */
  danger:
    "bg-transparent border-[color-mix(in_srgb,var(--bad)_42%,transparent)] text-[var(--bad)] " +
    "hover:bg-[var(--bad-soft)]",
};

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-[4px] border px-3.5 text-[13px] font-medium " +
  "transition-[transform,box-shadow,background,border-color,filter] duration-100 active:translate-y-px " +
  "disabled:cursor-not-allowed disabled:opacity-55 disabled:active:translate-y-0";

const SIZES = { sm: "h-7 px-2.5 text-[12.5px]", md: "h-[34px]" } as const;

/**
 * The same shape as a bare class string, for controls that cannot be a `<button>`.
 *
 * A control that navigates has to be an `<a>` — that is where middle-click, open-in-new-tab
 * and the browser's own affordances live. Before this existed each such call site re-typed
 * the classes by hand, and they drifted: the agent header, the members page and the export
 * menu were still wearing the filled pill after the buttons beside them had stopped.
 */
export const buttonClass = (
  variant: ButtonVariant = "secondary",
  size: keyof typeof SIZES = "md",
  className?: string,
) => cn(BASE, SIZES[size], VARIANTS[variant], className);

export interface ButtonProps extends ComponentPropsWithoutRef<"button"> {
  readonly variant?: ButtonVariant;
  readonly size?: keyof typeof SIZES;
  /**
   * Something this button started is still running.
   *
   * The label stays in the layout but invisible, and a spinner sits over it, so the button
   * keeps its width while it waits — a button that shrinks to a dot and grows back is a
   * layout that jumps twice per click. Disabled and `aria-busy` for the duration.
   */
  readonly pending?: boolean;
}

/**
 * A spinner in place of a label, with the label still holding the space.
 *
 * Every waiting state in the app draws this and nothing else: no "Saving…", no "Fetching…".
 * A spinner says "wait" in every language and reads faster than a verb with an ellipsis, and
 * the verb was always the same one the idle label already said.
 */
const Waiting = ({ pending, children }: { readonly pending: boolean; readonly children: ReactNode }) => (
  <>
    <span className={cn("inline-flex items-center gap-2", pending && "invisible")}>{children}</span>
    {pending && <Loader2 aria-hidden className="absolute inset-0 m-auto size-4 animate-spin" />}
  </>
);

export const Button = ({
  variant = "secondary",
  size = "md",
  className,
  type,
  pending = false,
  disabled,
  children,
  ...rest
}: ButtonProps) => (
  // `type` defaults to "submit" inside a form, which has submitted more forms
  // by accident than any other default in HTML.
  <button
    type={type ?? "button"}
    disabled={disabled === true || pending}
    aria-busy={pending || undefined}
    className={cn(BASE, SIZES[size], VARIANTS[variant], "relative", className)}
    {...rest}
  >
    <Waiting pending={pending}>{children}</Waiting>
  </button>
);

/**
 * The button that submits a form.
 *
 * `pending` is a prop rather than `useFormStatus`, so this file stays usable
 * from a Server Component. Every caller already has the flag from
 * `useActionState`; reading it again from context would cost the boundary and
 * buy nothing.
 */
export const SubmitButton = ({
  pending,
  idle,
  variant = "primary",
  size = "md",
  className,
  form,
  formAction,
}: {
  readonly pending: boolean;
  readonly idle: ReactNode;
  readonly variant?: ButtonVariant;
  readonly size?: keyof typeof SIZES;
  readonly className?: string;
  /**
   * Submit a form this button sits outside of, by its id.
   *
   * A plain HTML attribute, which is the whole appeal: a header action can drive a form
   * further down the page with no client state and no second copy of the control.
   */
  readonly form?: string;
  /**
   * Submit the form through a different action than its own.
   *
   * For a form with two meanings — the agent workspace saves a draft or publishes it — where
   * one of them has to be what the Enter key does. The form's own `action` is the harmless
   * one and this overrides it on the deliberate button, rather than both buttons sharing an
   * action that then has to work out which was pressed.
   */
  readonly formAction?: (payload: FormData) => void;
}) => (
  <button
    type="submit"
    form={form}
    formAction={formAction}
    disabled={pending}
    aria-busy={pending}
    className={cn(BASE, SIZES[size], VARIANTS[variant], "relative", className)}
  >
    {/* Every form in the app submits through one of these, so this is the whole of "data is
        saving" in one place — no per-form wiring, and a form added next week is covered
        without knowing the bar exists. Renders nothing; see `pending-progress.tsx` for why
        it is a child rather than a hook. */}
    <PendingProgress pending={pending} />
    <Waiting pending={pending}>{idle}</Waiting>
  </button>
);

/** A square button holding only an icon. Always give it an accessible name. */
export const IconButton = ({ className, type, ...rest }: ComponentPropsWithoutRef<"button">) => (
  <button
    type={type ?? "button"}
    className={cn(
      "grid size-[30px] place-items-center rounded-[4px] border border-transparent bg-transparent",
      "text-[var(--ink-2)] transition-colors hover:border-[var(--hairline)] hover:bg-[var(--glass-hi)] hover:text-[var(--ink)]",
      className,
    )}
    {...rest}
  />
);
