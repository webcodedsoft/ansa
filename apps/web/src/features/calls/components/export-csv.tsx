"use client";

import { Download } from "lucide-react";
import { useState } from "react";

/**
 * Hands the operator the dataset as a file.
 *
 * Built in the browser from rows the page already has, rather than fetched from a CSV
 * endpoint. The table and the file are then the same data by construction — a second
 * endpoint would be a second query to keep in step with the filters, and the first time
 * they drifted somebody would export a different set from the one they were reading.
 *
 * A client component because saving a file is a browser action. It is the only one on this
 * page; everything else is server-rendered.
 */
export const ExportCsv = ({
  csv,
  filename,
  disabled = false,
}: {
  readonly csv: string;
  readonly filename: string;
  readonly disabled?: boolean;
}) => {
  const [saving, setSaving] = useState(false);

  const save = (): void => {
    setSaving(true);
    /* An object URL rather than a `data:` one: a data URL of a large export runs into
       per-browser length limits, and this file grows with the organisation. */
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    // Revoked on the next tick, not immediately: Safari has not started reading the blob
    // when `click()` returns, and revoking synchronously gives an empty file.
    setTimeout(() => {
      URL.revokeObjectURL(url);
      setSaving(false);
    }, 0);
  };

  return (
    <button
      type="button"
      onClick={save}
      disabled={disabled || saving}
      className="inline-flex h-[34px] items-center gap-2 rounded-lg border border-[var(--hairline)] bg-[var(--glass-hi)] px-3.5 text-sm font-medium shadow-[var(--spec)] disabled:opacity-50"
    >
      <Download aria-hidden className="size-4" />
      Export CSV
    </button>
  );
};
