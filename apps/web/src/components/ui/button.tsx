import { Loader2 } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

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

const VARIANTS: Record<ButtonVariant, string> = {
  /* The one saturated surface in the interface, so it gets the most care: a
     slight gradient reading as a curved face, and a coloured glow beneath. */
  primary:
    "border-transparent text-[var(--accent-on)] font-semibold " +
    "bg-[linear-gradient(178deg,color-mix(in_srgb,var(--accent)_88%,#fff),var(--accent))] " +
    "shadow-[inset_0_1px_0_rgb(255_255_255/34%),0_1px_2px_rgb(6_20_26/22%),0_8px_20px_-8px_color-mix(in_srgb,var(--accent)_66%,transparent)] " +
    "hover:brightness-[1.07] hover:saturate-[1.04]",
  secondary:
    "bg-[var(--glass-hi)] backdrop-blur-xl border-[var(--hairline)] text-[var(--ink)] " +
    "shadow-[var(--spec)] hover:shadow-[var(--spec),var(--shadow-s)]",
  ghost: "border-transparent bg-transparent text-[var(--ink-2)] hover:bg-[var(--glass-hi)] hover:text-[var(--ink)]",
  danger: "border-transparent bg-[var(--bad-soft)] text-[var(--bad)] hover:brightness-[1.05]",
};

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-lg border px-3.5 text-sm font-medium " +
  "transition-[transform,box-shadow,background,filter] duration-100 active:translate-y-px " +
  "disabled:cursor-not-allowed disabled:opacity-55 disabled:active:translate-y-0";

const SIZES = { sm: "h-7 px-2.5 text-[12.5px]", md: "h-[34px]" } as const;

export interface ButtonProps extends ComponentPropsWithoutRef<"button"> {
  readonly variant?: ButtonVariant;
  readonly size?: keyof typeof SIZES;
}

export const Button = ({ variant = "secondary", size = "md", className, type, ...rest }: ButtonProps) => (
  // `type` defaults to "submit" inside a form, which has submitted more forms
  // by accident than any other default in HTML.
  <button type={type ?? "button"} className={cn(BASE, SIZES[size], VARIANTS[variant], className)} {...rest} />
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
  busy,
  variant = "primary",
  size = "md",
  className,
  form,
  formAction,
}: {
  readonly pending: boolean;
  readonly idle: ReactNode;
  readonly busy: ReactNode;
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
    className={cn(BASE, SIZES[size], VARIANTS[variant], className)}
  >
    {pending && <Loader2 aria-hidden className="size-4 animate-spin" />}
    {pending ? busy : idle}
  </button>
);

/** A square button holding only an icon. Always give it an accessible name. */
export const IconButton = ({ className, type, ...rest }: ComponentPropsWithoutRef<"button">) => (
  <button
    type={type ?? "button"}
    className={cn(
      "grid size-[30px] place-items-center rounded-lg border border-transparent bg-transparent",
      "text-[var(--ink-2)] transition-colors hover:border-[var(--hairline)] hover:bg-[var(--glass-hi)] hover:text-[var(--ink)]",
      className,
    )}
    {...rest}
  />
);
