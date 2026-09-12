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
 *
 * Failures come through here too, since the console settled on one place for them: a
 * failed action raises an error toast that stays longer than a confirmation and until it
 * is dismissed if the person is reading it. Field errors are the exception — "is not an
 * email address" belongs under the field it names and stays inline.
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
/** An error is read, not glanced at; it stays long enough to be read twice. */
const ERROR_VISIBLE_MS = 12000;

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  show: (tone, message) => {
    const id = crypto.randomUUID();
    set((state) => ({
      /* One of each message at a time: a retry that fails the same way should not stack the
         same sentence three deep. */
      toasts: [...state.toasts.filter((toast) => toast.message !== message || toast.tone !== tone), { id, tone, message }],
    }));
    // Self-dismissing. A confirmation is worth no click; an error gets longer, and a click
    // if somebody wants it gone sooner.
    setTimeout(
      () => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
      tone === "error" ? ERROR_VISIBLE_MS : VISIBLE_MS,
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
    if (announced.current === state) return;
    if (state.status === "succeeded" && state.data !== null) {
      announced.current = state;
      const said = describe.current(state.data);
      if (said !== null) show("ok", said);
      return;
    }
    if (failedOutright(state)) {
      announced.current = state;
      show("error", state.message);
    }
  }, [state, show]);
};

/**
 * A failure worth a toast: the action failed, or it was refused with a message and no field
 * to pin the complaint on. A refusal that names fields is shown under those fields.
 */
const failedOutright = <TData>(state: FormState<TData>): state is FormState<TData> & { readonly message: string } =>
  state.message !== null &&
  (state.status === "failed" || (state.status === "invalid" && Object.keys(state.fieldErrors).length === 0));

/** Raise an error toast when an action fails. For forms whose success is shown on the page itself. */
export const useFailureToast = <TData>(state: FormState<TData>): void => {
  useFormToast(state, () => null);
};
