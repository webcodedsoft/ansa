import type { ComponentPropsWithRef, ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Form controls.
 *
 * Each takes the native element's own props and spreads them, so `maxLength`,
 * `min` and the rest behave exactly as they do in HTML. These supply the label,
 * the hint, the error and the styling — they do not reinvent the input.
 *
 * `ref` is among those native props: React 19 passes it as one, so it reaches the element
 * through the same spread as everything else and no consumer needs a forwardRef wrapper.
 *
 * `required` is the exception, and is handled rather than passed through. See
 * `FieldShell.required` for why.
 */

export const CONTROL =
  "w-full rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)] px-[11px] py-2 " +
  "text-[13.5px] text-[var(--ink)] placeholder:text-[var(--ink-3)] " +
  "transition-colors hover:border-[var(--ink-3)] disabled:opacity-55";

const INVALID = "border-[var(--bad)] hover:border-[var(--bad)]";

export interface FieldShell {
  readonly label: ReactNode;
  /**
   * Marks the field, and deliberately does not switch on the browser's own validation.
   *
   * A native `required` blocks the submit and shows a bubble, which is the wrong shape twice
   * over here. Its message is the browser's rather than ours, and — the part that actually
   * broke — a form on this app can span tabs, where panels are hidden with `hidden` rather
   * than unmounted. Chrome will not submit a form holding an invalid control it cannot
   * focus, so an empty required field on a tab somebody is not looking at made the button do
   * nothing at all: no bubble, no error, no save.
   *
   * The server validates every one of these anyway and returns a message per field, which is
   * rendered underneath. This marks the field for a person and for assistive technology and
   * leaves the checking where it already was.
   */
  readonly required?: boolean;
  /** Under the control. For the reason behind a setting, not a restatement of it. */
  readonly hint?: ReactNode;
  readonly error?: string | undefined;
}

export const FieldError = ({ children }: { readonly children: ReactNode }) => (
  <p className="mt-1.5 text-xs text-[var(--bad)]">{children}</p>
);

const Hint = ({ children }: { readonly children: ReactNode }) => (
  <p className="mt-1.5 max-w-[58ch] text-xs leading-relaxed text-[var(--ink-3)]">{children}</p>
);

export const Field = ({
  label,
  hint,
  error,
  required,
  className,
  as: Shell = "label",
  children,
}: FieldShell & {
  readonly className?: string;
  /**
   * The element wrapping the control. A `label` by default, so clicking the caption focuses
   * the input — which is what you want for every native control.
   *
   * `div` exists for the one control that is not native. A `label` around a combobox delivers
   * the caption's click to the control as well, and for a listbox that means opening the menu
   * and closing it again in the same gesture. The select passes `div` and labels itself
   * through `aria-labelledby` instead, which assistive technology reads identically.
   */
  readonly as?: "label" | "div";
  readonly children: ReactNode;
}) => (
  <Shell className={cn("block", className)}>
    <span className="mb-1.5 block text-[12.5px] font-medium">
      {label}
      {required === true && (
        <span className="ml-1.5 text-[11px] font-normal text-[var(--ink-3)]">required</span>
      )}
    </span>
    {children}
    {error !== undefined && <FieldError>{error}</FieldError>}
    {hint !== undefined && <Hint>{hint}</Hint>}
  </Shell>
);

type InputProps = Omit<ComponentPropsWithRef<"input">, "className">;
type TextAreaProps = Omit<ComponentPropsWithRef<"textarea">, "className">;

export const TextField = ({
  label,
  hint,
  error,
  required,
  className,
  ...input
}: FieldShell & InputProps & { readonly className?: string }) => (
  <Field label={label} hint={hint} error={error} required={required} className={className}>
    <input
      aria-invalid={error !== undefined}
      aria-required={required}
      className={cn(CONTROL, error !== undefined && INVALID)}
      {...input}
    />
  </Field>
);

export const NumberField = ({
  label,
  hint,
  error,
  required,
  className,
  ...input
}: FieldShell & InputProps & { readonly className?: string }) => (
  <Field label={label} hint={hint} error={error} required={required} className={className}>
    <input
      type="number"
      aria-invalid={error !== undefined}
      aria-required={required}
      className={cn(CONTROL, error !== undefined && INVALID)}
      {...input}
    />
  </Field>
);

export const TextAreaField = ({
  label,
  hint,
  error,
  required,
  className,
  tall,
  ...textarea
}: FieldShell & TextAreaProps & { readonly className?: string; readonly tall?: boolean }) => (
  <Field label={label} hint={hint} error={error} required={required} className={className}>
    <textarea
      aria-invalid={error !== undefined}
      aria-required={required}
      className={cn(CONTROL, "resize-y leading-relaxed", tall === true ? "min-h-36" : "min-h-20", error !== undefined && INVALID)}
      {...textarea}
    />
  </Field>
);

/**
 * A checkbox with its label beside it.
 *
 * Separate from `Field` because the layout genuinely differs: a checkbox reads
 * as a sentence with the box at the front, and forcing it through the
 * label-on-top shell puts the box under a heading nobody can tell from a
 * section title.
 */
export const CheckboxField = ({ label, className, ...input }: { readonly label: ReactNode; readonly className?: string } & InputProps) => (
  <label className={cn("flex cursor-pointer items-center gap-2 text-sm", className)}>
    <input type="checkbox" className="size-4 rounded border-[var(--hairline)] accent-[var(--accent)]" {...input} />
    <span>{label}</span>
  </label>
);

/** Checkboxes sharing one name. A fieldset so the legend names the group aloud. */
export const CheckboxGroup = ({ legend, children }: { readonly legend: ReactNode; readonly children: ReactNode }) => (
  <fieldset className="min-w-0 border-0 p-0">
    <legend className="mb-1.5 p-0 text-[12.5px] font-medium">{legend}</legend>
    <div className="flex flex-wrap items-center gap-3.5">{children}</div>
  </fieldset>
);

/**
 * A setting with its reasoning beside it rather than under a label.
 *
 * `control` is passed in rather than rendered here so a caller can supply a
 * real checkbox in a form, or a toggle button driven by state — the row does
 * not care which, and should not.
 */
export const SettingRow = ({
  title,
  description,
  control,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly control: ReactNode;
}) => (
  <div className="flex items-start justify-between gap-4 border-b border-[var(--surface-line)] py-3.5 last:border-b-0">
    <div>
      <div className="text-[13.5px] font-medium">{title}</div>
      {description !== undefined && (
        <div className="mt-0.5 max-w-[54ch] text-[12.5px] text-[var(--ink-3)]">{description}</div>
      )}
    </div>
    <div className="flex-none">{control}</div>
  </div>
);
