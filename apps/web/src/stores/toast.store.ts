"use client";

import { useEffect, useRef } from "react";
import { create } from "zustand";

import type { NoticeTone } from "@/components/ui";
import type { FormState } from "@/lib/form-state";

/**
 * Transient confirmations.
 *
 * This exists because of `revalidatePath`. When a publish succeeds the action revalidates
 * the page, the server re-renders the form with the new configuration, and the success
 * message rendered from action state goes with it — the work landed and the screen said
 * nothing. A toast lives outside the tree being replaced, so it survives the refresh that
 * proves it worked.
 *
 * A store rather than context because the publisher and the renderer are in different
 * subtrees: the form is deep inside a page, the toast stack sits in the workspace layout,
 * and threading a provider between them to move one string is more machinery than this.
 * Failures deliberately do not come through here — an error belongs next to the field or
 * the form that caused it, where it stays put and can be re-read.
 */

export interface Toast {
  readonly id: string;
  readonly tone: NoticeTone;
  readonly message: string;
}

interface ToastStore {
  readonly toasts: readonly Toast[];
  readonly show: (tone: NoticeTone, message: string) => void;
  readonly dismiss: (id: string) => void;
}

const VISIBLE_MS = 6000;

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  show: (tone, message) => {
    const id = crypto.randomUUID();
    set((state) => ({ toasts: [...state.toasts, { id, tone, message }] }));
    // Self-dismissing, because nothing that comes through here is worth a click to
    // acknowledge. Anything that is belongs on the page, not in a corner that disappears.
    setTimeout(
      () => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
      VISIBLE_MS,
    );
  },
  dismiss: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}));

/**
 * Raise a toast when an action's state turns from anything to succeeded.
 *
 * The guard on the previous status is the whole point. `useActionState` keeps the last
 * result in state, so an effect watching only the current value fires again on every
 * unrelated re-render and the same "Published version 5" stacks up three deep.
 */
export const useFormToast = <TData>(
  state: FormState<TData>,
  /** What to say — or null to say nothing, for a success that asked not to be announced. */
  message: (data: TData) => string | null,
): void => {
  const show = useToastStore((store) => store.show);
  /* Each result is its own object, so identity is what tells a new success from the last
     one still sitting in state. Watching the status alone missed a second success following
     a first — a save after a save — because the status never changed. */
  const announced = useRef<FormState<TData> | null>(null);
  // Read through a ref so the effect does not depend on a closure that is new every render.
  const describe = useRef(message);
  describe.current = message;

  useEffect(() => {
    if (state.status !== "succeeded" || announced.current === state || state.data === null) return;
    announced.current = state;
    const said = describe.current(state.data);
    if (said !== null) show("ok", said);
  }, [state, show]);
};
