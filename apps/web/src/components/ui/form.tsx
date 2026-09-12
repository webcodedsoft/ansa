import { CircleAlert, Search } from "lucide-react";
import { useId, type ComponentPropsWithRef, type ReactNode } from "react";

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
 *
 * Every state a control can be in is drawn here and nowhere else: rest, hover, focus,
 * invalid, read-only, disabled. Focus is a soft ring in the accent rather than the page's
 * outline, because an outline sits outside a rounded border and reads as a second box;
 * invalid keys off `aria-invalid`, so a raw `<input>` that sets it gets the red border
 * without also having to know the class. Read-only drops the fill and the hover so a value
 * that cannot be changed does not invite a click.
 */

const STATES =
  "transition-[border-color,box-shadow] duration-100 " +
  "hover:border-[var(--ink-3)] " +
  "aria-invalid:border-[var(--bad)] aria-invalid:hover:border-[var(--bad)] " +
  "read-only:cursor-default read-only:bg-transparent read-only:text-[var(--ink-2)] " +
  "read-only:hover:border-[var(--hairline)] read-only:focus:border-[var(--hairline)] read-only:focus:shadow-none " +
  "disabled:cursor-not-allowed disabled:opacity-55 " +
  /* The browser's own calendar and clock buttons, dimmed to the hint colour until hovered. */
  "[&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-55 " +
  "[&::-webkit-calendar-picker-indicator]:hover:opacity-100 " +
  "[&::-webkit-search-cancel-button]:cursor-pointer";

const FOCUS =
  "focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-soft)] focus:outline-none " +
  "aria-invalid:focus:shadow-[0_0_0_3px_var(--bad-soft)]";

export const CONTROL =
  "w-full rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)] px-[11px] py-2 " +
  "text-[13.5px] leading-5 text-[var(--ink)] placeholder:text-[var(--ink-3)] " +
  STATES +
  " " +
  FOCUS;

/**
 * The same box, drawn around an input and whatever sits beside it — an icon, a unit, a
 * currency, a button. The frame carries the states and the input inside it carries none, so
 * a field with a leading icon focuses and errs exactly like one without.
 */
const FRAME =
  "flex w-full items-center gap-2 rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)] " +
  "text-[var(--ink)] transition-[border-color,box-shadow] duration-100 hover:border-[var(--ink-3)] " +
  "focus-within:border-[var(--accent)] focus-within:shadow-[0_0_0_3px_var(--accent-soft)] " +
  "has-[[aria-invalid=true]]:border-[var(--bad)] has-[[aria-invalid=true]]:hover:border-[var(--bad)] " +
  "has-[[aria-invalid=true]]:focus-within:shadow-[0_0_0_3px_var(--bad-soft)] " +
  "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-55 " +
  "has-[input:read-only]:bg-transparent has-[input:read-only]:hover:border-[var(--hairline)] " +
  "has-[input:read-only]:focus-within:border-[var(--hairline)] has-[input:read-only]:focus-within:shadow-none";

const BARE =
  "min-w-0 flex-1 border-0 bg-transparent p-0 text-[var(--ink)] outline-none " +
  "placeholder:text-[var(--ink-3)] read-only:text-[var(--ink-2)] disabled:cursor-not-allowed " +
  "[&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-55 " +
  "[&::-webkit-search-cancel-button]:cursor-pointer";

const SIZES = {
  md: { frame: "px-[11px] text-[13.5px]", input: "py-2 leading-5" },
  sm: { frame: "px-2.5 text-[12.5px]", input: "py-1.5 leading-5" },
} as const;

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
  /**
   * Keep the caption for assistive technology but take it off the screen — for a control in
   * a toolbar or a table row, where the text around it already says what it is.
   */
  readonly hideLabel?: boolean;
}

export const FieldError = ({ id, children }: { readonly id?: string; readonly children: ReactNode }) => (
  <p id={id} role="alert" className="mt-1.5 flex items-start gap-1.5 text-xs text-[var(--bad)]">
    <CircleAlert aria-hidden className="mt-px size-3.5 flex-none" />
    <span>{children}</span>
  </p>
);

const Hint = ({ id, children }: { readonly id?: string; readonly children: ReactNode }) => (
  <p id={id} className="mt-1.5 max-w-[58ch] text-xs leading-relaxed text-[var(--ink-3)]">
    {children}
  </p>
);

/** The ids a control names in `aria-describedby`, so a screen reader reads the hint and the error with the field. */
const describedBy = (id: string, hint: ReactNode, error: string | undefined): string | undefined => {
  const ids = [error !== undefined ? `${id}-error` : null, hint !== undefined ? `${id}-hint` : null].filter(
    (one): one is string => one !== null,
  );
  return ids.length === 0 ? undefined : ids.join(" ");
};

export const Field = ({
  label,
  hint,
  error,
  required,
  hideLabel = false,
  className,
  as: Shell = "label",
  describe,
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
  /** The id base the hint and error are named by; the control cites them in `aria-describedby`. */
  readonly describe?: string;
  readonly children: ReactNode;
}) => (
  <Shell className={cn("block", className)}>
    <span className={cn("mb-1.5 block text-[12.5px] font-medium", hideLabel && "sr-only")}>
      {label}
      {required === true && (
        <span className="ml-1.5 text-[11px] font-normal text-[var(--ink-3)]">required</span>
      )}
    </span>
    {children}
    {error !== undefined && (
      <FieldError id={describe === undefined ? undefined : `${describe}-error`}>{error}</FieldError>
    )}
    {hint !== undefined && <Hint id={describe === undefined ? undefined : `${describe}-hint`}>{hint}</Hint>}
  </Shell>
);

type InputProps = Omit<ComponentPropsWithRef<"input">, "className" | "size" | "prefix">;
type TextAreaProps = Omit<ComponentPropsWithRef<"textarea">, "className">;

/** What can sit inside the box beside the text. */
interface Adornments {
  /** An icon at the start. Sized here; pass the glyph bare. */
  readonly leading?: ReactNode;
  /** An icon or a small button at the end. */
  readonly trailing?: ReactNode;
  /** Text at the start that is part of the value's meaning — "+234", "₦", "https://". */
  readonly prefix?: string;
  /** Text at the end — "days", "ms", "%". */
  readonly suffix?: string;
  /** `sm` for a toolbar or a table row, where the full height will not fit. */
  readonly size?: keyof typeof SIZES;
  /** Monospace, for a value that is a code, a pattern or an address rather than words. */
  readonly mono?: boolean;
}

export const TextField = ({
  label,
  hint,
  error,
  required,
  hideLabel,
  className,
  leading,
  trailing,
  prefix,
  suffix,
  size = "md",
  mono = false,
  ...input
}: FieldShell & InputProps & Adornments & { readonly className?: string }) => {
  const id = useId();
  const adorned = leading !== undefined || trailing !== undefined || prefix !== undefined || suffix !== undefined;
  const shared = {
    "aria-invalid": error !== undefined,
    "aria-required": required,
    "aria-describedby": describedBy(id, hint, error),
  };
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      required={required}
      hideLabel={hideLabel}
      className={className}
      describe={id}
    >
      {adorned ? (
        <span className={cn(FRAME, SIZES[size].frame)}>
          {leading !== undefined && (
            <span aria-hidden className="flex flex-none items-center text-[var(--ink-3)] [&>svg]:size-4">
              {leading}
            </span>
          )}
          {prefix !== undefined && (
            <span className="flex-none text-[var(--ink-3)] select-none">{prefix}</span>
          )}
          <input className={cn(BARE, SIZES[size].input, mono && "font-mono")} {...shared} {...input} />
          {suffix !== undefined && (
            <span className="flex-none text-[var(--ink-3)] select-none">{suffix}</span>
          )}
          {trailing !== undefined && (
            <span className="flex flex-none items-center text-[var(--ink-3)] [&>svg]:size-4">{trailing}</span>
          )}
        </span>
      ) : (
        <input
          className={cn(CONTROL, size === "sm" && "px-2.5 py-1.5 text-[12.5px]", mono && "font-mono")}
          {...shared}
          {...input}
        />
      )}
    </Field>
  );
};

/**
 * A search box: the magnifier, `type="search"` so the browser offers its clear button, and
 * a caption that is read but not seen — the placeholder says what to type, the caption says
 * what is being searched.
 */
export const SearchField = ({
  hideLabel = true,
  ...field
}: FieldShell & InputProps & Pick<Adornments, "size"> & { readonly className?: string }) => (
  <TextField type="search" leading={<Search />} hideLabel={hideLabel} autoComplete="off" {...field} />
);

export const NumberField = ({
  label,
  hint,
  error,
  required,
  hideLabel,
  className,
  ...input
}: FieldShell & InputProps & Pick<Adornments, "suffix" | "prefix" | "size"> & { readonly className?: string }) => (
  <TextField
    type="number"
    inputMode="decimal"
    label={label}
    hint={hint}
    error={error}
    required={required}
    hideLabel={hideLabel}
    className={className}
    {...input}
  />
);

export const TextAreaField = ({
  label,
  hint,
  error,
  required,
  hideLabel,
  className,
  tall,
  mono = false,
  ...textarea
}: FieldShell &
  TextAreaProps & { readonly className?: string; readonly tall?: boolean; readonly mono?: boolean }) => {
  const id = useId();
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      required={required}
      hideLabel={hideLabel}
      className={className}
      describe={id}
    >
      <textarea
        aria-invalid={error !== undefined}
        aria-required={required}
        aria-describedby={describedBy(id, hint, error)}
        className={cn(
          CONTROL,
          "resize-y leading-relaxed",
          tall === true ? "min-h-36" : "min-h-20",
          mono && "font-mono text-[12.5px]",
        )}
        {...textarea}
      />
    </Field>
  );
};

/**
 * A checkbox with its label beside it.
 *
 * Separate from `Field` because the layout genuinely differs: a checkbox reads
 * as a sentence with the box at the front, and forcing it through the
 * label-on-top shell puts the box under a heading nobody can tell from a
 * section title. `description` goes under the sentence for the consequence of
 * ticking it, in the hint colour.
 */
export const CheckboxField = ({
  label,
  description,
  className,
  ...input
}: { readonly label: ReactNode; readonly description?: ReactNode; readonly className?: string } & InputProps) => (
  <label className={cn("flex cursor-pointer items-start gap-2 text-sm has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-55", className)}>
    <input
      type="checkbox"
      className="mt-0.5 size-4 flex-none rounded border-[var(--hairline)] accent-[var(--accent)]"
      {...input}
    />
    <span className="min-w-0">
      <span className="block leading-5">{label}</span>
      {description !== undefined && (
        <span className="block text-[12.5px] leading-relaxed text-[var(--ink-3)]">{description}</span>
      )}
    </span>
  </label>
);

/**
 * A checkbox drawn as a switch, for a setting that is on or off and takes effect on save.
 *
 * Still a checkbox underneath — `name` and `checked` submit through `FormData` exactly as a
 * box would, which is the whole reason this is not the `Toggle` button: a button drives
 * state, a switch field is part of a form. The row is the click target, so the switch is
 * not the only 38 pixels that flip it.
 */
export const SwitchField = ({
  label,
  description,
  className,
  ...input
}: { readonly label: ReactNode; readonly description?: ReactNode; readonly className?: string } & InputProps) => (
  <label
    className={cn(
      "flex cursor-pointer items-start gap-3.5 rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)] px-3.5 py-3",
      "transition-colors hover:border-[var(--ink-3)] has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-55",
      className,
    )}
  >
    <input type="checkbox" role="switch" className="peer sr-only" {...input} />
    <span
      aria-hidden
      className={cn(
        "relative mt-0.5 h-[22px] w-[38px] flex-none rounded-full bg-[var(--hairline)] transition-colors",
        "peer-checked:bg-[var(--accent)]",
        "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--accent)]",
        "after:absolute after:top-[2px] after:left-[2px] after:size-[18px] after:rounded-full after:bg-[var(--surface-solid)]",
        "after:shadow-[var(--shadow-s)] after:transition-transform peer-checked:after:translate-x-4",
      )}
    />
    <span className="min-w-0">
      <span className="block text-[14px] font-medium">{label}</span>
      {description !== undefined && (
        <span className="block text-[12.5px] text-[var(--ink-3)]">{description}</span>
      )}
    </span>
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
