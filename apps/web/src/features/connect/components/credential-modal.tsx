"use client";

import { Modal } from "@/components/ui";

import { CredentialForm } from "./credential-form";

/**
 * Store a credential without leaving the form that needs it.
 *
 * The tool builder used to send somebody to the Credentials page with a link, and the link
 * threw away the five steps they had filled in. A credential is a thirty-second job in the
 * middle of a five-minute one; it belongs in a dialog over the work, not on another page.
 * On save the stored name goes back to the caller so the field that asked for it is filled.
 */
export const CredentialModal = ({
  open,
  onClose,
  onStored,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onStored: (ref: string) => void;
}) => (
  <Modal
    open={open}
    onClose={onClose}
    title="Store a credential"
    description="Under a name the tool refers to. The value is sealed on save and never shown again — not even masked."
  >
    {/* Remounted each time it opens, so a second credential starts from a blank form rather
        than from the last one's success state. */}
    {open && <CredentialForm mode="add" onSaved={onStored} />}
  </Modal>
);
