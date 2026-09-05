"use client";

import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactSelect, { type GroupBase, type StylesConfig } from "react-select";

import { cn } from "@/lib/cn";

import { Field, type FieldShell } from "./form";

/**
 * The select.
 *
 * A listbox rather than the browser's native one, because the native control cannot be typed
 * into and several of the lists here are long enough that scrolling them is the whole task —
 * the IANA timezone picker is three hundred entries, and finding `Africa/Lagos` in it by eye
 * is the small daily cruelty this removes. Typing filters; the keyboard still works; the
 * chosen value still submits.
 *
 * **It keeps the native control's API on purpose.** Options are `<option>` children, not an
 * `options` array, and `onChange` hands back something shaped like a change event so a caller
 * reads `event.target.value` exactly as before. That is not nostalgia: it made this one file's
 * change instead of twenty call sites' change, and twenty hand-edited call sites is twenty
 * chances to invert a condition in a handler nobody re-reads. `<optgroup>` works too, since
 * the underlying library has its own notion of grouped options.
 *
 * **Forms still work.** With a `name` the library renders a hidden input carrying the value,
 * so a Server Action reading `FormData` sees exactly what a native select would have put
 * there. What is lost is submission with JavaScript disabled — a real cost, paid once here
 * and noted rather than discovered.
 *
 * **The menu is portalled to the body, except inside a dialog, where it is not portalled at
 * all.** Both halves of that are load-bearing and both were learned the hard way.
 *
 * On an ordinary page the menu must leave the layout: the flow canvas clips its overflow, and
 * a menu rendered in place there loses its last few options.
 *
 * A modal is the opposite. It is a real `<dialog>` opened with `showModal()`, which lives in
 * the browser's *top layer* — above every stacking context in the document — so a menu
 * portalled to the body renders behind it and no `z-index` will lift it out. Portalling into
 * the dialog does not work either: the dialog carries a `backdrop-filter`, and that makes it
 * a containing block for fixed-position descendants, so the menu is positioned against the
 * dialog rather than the viewport and lands at its foot. Nothing inside the dialog clips, so
 * the answer is to leave the menu where it is and let it overlay the fields below it.
 *
 * Styling is `unstyled` plus Tailwind classes over the same tokens every other control uses,
 * so it inherits both themes rather than carrying a second palette that drifts from the first.
 */

interface Choice {
  readonly value: string;
  readonly label: ReactNode;
  readonly disabled: boolean;
}

type Group = GroupBase<Choice>;

/**
 * Read `<option>` and `<optgroup>` children into the shape the library wants.
 *
 * Anything else in there is ignored rather than thrown over — a stray `{false}` from a
 * conditional is a normal thing to find in JSX and not worth taking a page down for.
 */
const readOptions = (children: ReactNode): readonly (Choice | Group)[] => {
  const out: (Choice | Group)[] = [];
  for (const child of Children.toArray(children)) {
    if (!isValidElement(child)) continue;
    const props = child.props as {
      readonly value?: string | number;
      readonly label?: string;
      readonly disabled?: boolean;
      readonly children?: ReactNode;
    };
    if (child.type === "optgroup") {
      const inner = readOptions(props.children).filter((one): one is Choice => "value" in one);
      out.push({ label: props.label ?? "", options: [...inner] });
      continue;
    }
    if (child.type === "option") {
      out.push({
        value: String(props.value ?? ""),
        /* An option's caption is its children; falling back to the value means a bare
           `<option value="x" />` still reads as something rather than as a blank row. */
        label: props.children ?? String(props.value ?? ""),
        disabled: props.disabled === true,
      });
    }
  }
  return out;
};

const flatten = (options: readonly (Choice | Group)[]): readonly Choice[] =>
  options.flatMap((one) => ("value" in one ? [one] : one.options));

/** How tall the list gets before it scrolls. Short enough to fit inside a modal. */
const MENU_HEIGHT = 216;

/**
 * The two things that must be real CSS rather than classes.
 *
 * The portal needs a stacking order. And the list needs its `maxHeight` in the library's own
 * styles, not only in a Tailwind class: `unstyled` sets no height, so the library believes the
 * list is its full unscrolled length and never scrolls the chosen option into view — which for
 * a ninety-six row time picker meant opening at midnight with ten in the morning selected.
 */
const PORTAL_STYLES: StylesConfig<Choice, false, Group> = {
  menuPortal: (base) => ({ ...base, zIndex: 70 }),
  menuList: (base) => ({ ...base, maxHeight: MENU_HEIGHT }),
};

export interface SelectFieldProps extends FieldShell {
  readonly name?: string;
  /** `string | number`, as the native element took, so a numeric option list still fits. */
  readonly value?: string | number;
  readonly defaultValue?: string | number;
  readonly onChange?: (event: { target: { value: string; name: string } }) => void;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly className?: string;
  /**
   * Whether the list can be typed into. Left alone it decides for itself: a list long enough
   * to scroll gets a filter, and a choice between two does not, because a search box over
   * "Book it / Hold it" is furniture.
   */
  readonly searchable?: boolean;
  /**
   * Keep the caption for assistive technology but take it off the screen.
   *
   * For the selects that sit in a toolbar or a table row, where the surrounding text already
   * says what the control is and a heading over it would be noise. It is `sr-only` rather
   * than absent because a listbox with no accessible name is a listbox a screen reader
   * announces as nothing at all.
   */
  readonly hideLabel?: boolean;
  /** `sm` for the ones inside table rows and the canvas toolbar, where `md` will not fit. */
  readonly size?: "md" | "sm";
  readonly children: ReactNode;
}

const SEARCH_FROM = 8;

export const SelectField = ({
  label,
  hint,
  error,
  required,
  className,
  name,
  value,
  defaultValue,
  onChange,
  disabled = false,
  placeholder = "Choose…",
  searchable,
  hideLabel = false,
  size = "md",
  children,
}: SelectFieldProps) => {
  const instanceId = useId();
  const labelId = `${instanceId}-label`;

  /* Whether to portal, decided after mount because it depends on what this select turned out
     to be inside of. Undefined on the first render, which is safe: the menu is shut then. */
  const anchor = useRef<HTMLDivElement | null>(null);
  const [host, setHost] = useState<HTMLElement | undefined>(undefined);
  useEffect(() => {
    const inDialog = anchor.current?.closest("dialog") !== null;
    setHost(inDialog ? undefined : document.body);
  }, []);

  const options = useMemo(() => readOptions(children), [children]);
  const flat = useMemo(() => flatten(options), [options]);

  /* Controlled when a `value` is given, uncontrolled otherwise — the same distinction the
     native element draws, so a call site that passed `defaultValue` keeps its meaning. */
  const chosen =
    value === undefined ? undefined : (flat.find((one) => one.value === String(value)) ?? null);
  const initial =
    defaultValue === undefined
      ? undefined
      : flat.find((one) => one.value === String(defaultValue));

  const canSearch = searchable ?? flat.length >= SEARCH_FROM;

  /**
   * Put the chosen option on screen when the list opens.
   *
   * The library styles the selected option but does not scroll to it: with a searchable list
   * it focuses the first row, so a ninety-six row time picker opened at midnight while ten in
   * the morning sat forty rows down, marked and invisible. The option ids are the library's
   * own documented shape, and a miss is a no-op rather than an error.
   */
  const revealChosen = (): void => {
    const index = chosen == null ? -1 : flat.findIndex((one) => one.value === chosen.value);
    if (index < 0) return;
    requestAnimationFrame(() => {
      document
        .getElementById(`react-select-${instanceId}-option-${index}`)
        ?.scrollIntoView({ block: "center" });
    });
  };

  return (
    <Field
      as="div"
      label={<span id={labelId} className={cn(hideLabel && "sr-only")}>{label}</span>}
      hint={hint}
      error={error}
      required={required}
      className={cn(className, hideLabel && "[&>span:first-child]:mb-0")}
    >
      <div ref={anchor}>
      <ReactSelect<Choice, false, Group>
        instanceId={instanceId}
        aria-labelledby={labelId}
        aria-invalid={error !== undefined}
        name={name}
        value={chosen}
        defaultValue={initial}
        options={[...options]}
        isDisabled={disabled}
        isSearchable={canSearch}
        placeholder={placeholder}
        isOptionDisabled={(option) => option.disabled}
        /* Rendered into the body so a modal's or the canvas's `overflow-hidden` cannot clip
           the menu. Guarded because this file is also rendered on the server, where there is
           no document to portal into. */
        /* Told in a number, not only in a class. `unstyled` means the library sets no height
           of its own, so without this it cannot work out where the selected option sits and
           opens a long list at the top — a ninety-six row time picker opening at midnight
           when ten in the morning is chosen. Must match the `menuList` class below. */
        maxMenuHeight={MENU_HEIGHT}
        onMenuOpen={revealChosen}
        menuPortalTarget={host}
        /* Downward inside a dialog. `auto` measures against the viewport, which inside a
           modal is the wrong box — it sees room above the dialog, opens up into it, and the
           dialog's own top edge cuts the first options off. Below the control there is always
           the rest of the panel, and the panel scrolls if the list outgrows it. */
        menuPlacement={host === undefined ? "bottom" : "auto"}
        styles={PORTAL_STYLES}
        onChange={(option) =>
          onChange?.({ target: { value: option?.value ?? "", name: name ?? "" } })
        }
        unstyled
        classNames={{
          control: ({ isFocused, isDisabled }) =>
            cn(
              "w-full cursor-pointer rounded-lg border bg-[var(--surface-2)] transition-colors",
              /* `text-left` because a native select always aligned its value left, and some
                 of the surfaces these sit on — the modals — centre their text. Without it a
                 select in a dialog reads centred and every other control beside it does not. */
              "text-left text-[var(--ink)]",
              size === "sm" ? "px-2 py-1 text-[12px]" : "px-[11px] py-2 text-[13.5px]",
              error !== undefined
                ? "border-[var(--bad)]"
                : isFocused
                  ? "border-[var(--accent)]"
                  : "border-[var(--hairline)] hover:border-[var(--ink-3)]",
              isDisabled && "cursor-default opacity-55",
            ),
          valueContainer: () => "gap-1",
          placeholder: () => "text-[var(--ink-3)]",
          input: () => "text-[var(--ink)]",
          indicatorsContainer: () => "gap-1 pl-1",
          dropdownIndicator: () => "text-[var(--ink-3)]",
          indicatorSeparator: () => "hidden",
          menu: () =>
            cn(
              "mt-1 overflow-hidden rounded-lg border border-[var(--hairline)]",
              "bg-[var(--surface-solid)] shadow-xl",
            ),
          /* The height itself is in `PORTAL_STYLES`, where the library can read it. */
          menuList: () => "py-1 text-left",
          groupHeading: () =>
            "px-2.5 pt-2 pb-1 text-[10.5px] font-medium tracking-wide text-[var(--ink-3)] uppercase",
          option: ({ isSelected, isFocused, isDisabled }) =>
            cn(
              "cursor-pointer px-2.5 py-1.5 text-[13px]",
              isDisabled && "cursor-default opacity-45",
              isSelected
                ? "bg-[var(--accent-soft)] font-medium text-[var(--accent)]"
                : isFocused
                  ? "bg-[var(--surface-2)] text-[var(--ink)]"
                  : "text-[var(--ink-2)]",
            ),
          noOptionsMessage: () => "px-2.5 py-3 text-[12.5px] text-[var(--ink-3)]",
        }}
      />
      </div>
    </Field>
  );
};
