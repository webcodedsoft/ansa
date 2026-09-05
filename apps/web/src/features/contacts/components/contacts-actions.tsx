"use client";

import { useState } from "react";

import { Button, Modal } from "@/components/ui";

import { AddContactForm } from "./add-contact-form";
import { ImportContactsForm } from "./import-contacts-form";

type Mode = "add" | "import" | null;

/**
 * The two write paths on the contacts page, as header actions.
 *
 * Rendered only when the operator holds `contacts:write` — the page decides that, and the API
 * enforces it regardless, so hiding these is a courtesy rather than the guard. One solid button
 * and one outline, the same grammar the rest of the console uses for "the main thing here, and
 * the other thing".
 *
 * Each form is mounted only while its modal is open, keyed to the mode, so closing and
 * reopening starts from a clean slate rather than showing the last result again. A successful
 * add or import has already revalidated `/contacts` from the server action, so the directory
 * behind the modal is up to date the moment it closes.
 */
export const ContactsActions = () => {
  const [mode, setMode] = useState<Mode>(null);
  const close = (): void => setMode(null);

  return (
    <>
      <Button variant="secondary" onClick={() => setMode("import")}>
        Import contacts
      </Button>
      <Button variant="primary" onClick={() => setMode("add")}>
        Add a contact
      </Button>

      <Modal
        open={mode === "add"}
        onClose={close}
        title="Add a contact"
        description="For somebody the office knows about who has not rung yet. Only the number is required."
      >
        {mode === "add" && <AddContactForm onClose={close} />}
      </Modal>

      <Modal
        open={mode === "import"}
        onClose={close}
        title="Import contacts"
        description="Paste a list or upload a CSV. We read it here and show you what we found before anything is saved."
      >
        {mode === "import" && <ImportContactsForm onClose={close} />}
      </Modal>
    </>
  );
};
