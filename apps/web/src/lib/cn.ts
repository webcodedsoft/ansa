import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Compose class names, letting the caller win.
 *
 * `clsx` flattens the conditional forms — arrays, objects, false, undefined — and
 * `tailwind-merge` resolves the conflicts that come out of it. Without the second half, a
 * component with `px-4` that accepts `className="px-2"` renders both, and which one applies
 * depends on the order Tailwind happened to emit them in, not on the order they were
 * written. That makes a prop that looks like an override behave like a suggestion.
 */
export const cn = (...inputs: readonly ClassValue[]): string => twMerge(clsx(inputs));
