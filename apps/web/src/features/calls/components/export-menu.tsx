import { FileJson, FileSpreadsheet, FileText, Table2 } from "lucide-react";

/**
 * The same view, in whichever format the operator needs it.
 *
 * Four links, not a dropdown and not a button that assembles a file in the browser. Each is
 * a plain `<a>` to the export route, so this component ships no JavaScript, every format is
 * bookmarkable, and a right-click "save as" behaves the way a download should. The heavy
 * writing — a ZIP for Excel, a cross-reference table for the PDF — happens on the server,
 * where it costs the page nothing.
 *
 * The filters travel with the link, so what somebody exports is what they were looking at.
 */

const FORMATS = [
  {
    format: "xlsx",
    label: "Excel",
    Icon: FileSpreadsheet,
    // Named because it is the difference people actually notice: a CSV opened in Excel
    // turns 08138178550 into 8138178550.
    title: "Excel workbook. Keeps leading zeros on phone and policy numbers.",
  },
  { format: "csv", label: "CSV", Icon: Table2, title: "Comma-separated, for any spreadsheet." },
  {
    format: "pdf",
    label: "PDF",
    Icon: FileText,
    title: "For printing or sending on. Accents are simplified to plain letters.",
  },
  {
    format: "json",
    label: "JSON",
    Icon: FileJson,
    title: "Keyed by field name, for another system to read.",
  },
] as const;

export const ExportMenu = ({
  query,
  disabled = false,
}: {
  readonly query: { readonly agentId?: string; readonly from?: string; readonly to?: string };
  readonly disabled?: boolean;
}) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") search.set(key, value);
  }

  const className =
    "inline-flex h-[34px] items-center gap-1.5 rounded-lg border border-[var(--hairline)] bg-[var(--glass-hi)] px-3 text-sm font-medium shadow-[var(--spec)]";

  return (
    <div className="flex items-center gap-1.5">
      <span className="mr-1 text-xs text-[var(--ink-3)]">Export</span>
      {FORMATS.map(({ format, label, Icon, title }) => {
        /* A disabled anchor is not something the platform has, and `pointer-events: none`
           alone would still leave it in the tab order — so with nothing to export it renders
           as a span and stops being a link at all. */
        if (disabled) {
          return (
            <span key={format} aria-disabled className={`${className} opacity-50`}>
              <Icon aria-hidden className="size-4" />
              {label}
            </span>
          );
        }
        const params = new URLSearchParams(search);
        params.set("format", format);
        return (
          <a
            key={format}
            href={`/data/export?${params.toString()}`}
            title={title}
            className={className}
          >
            <Icon aria-hidden className="size-4" />
            {label}
          </a>
        );
      })}
    </div>
  );
};
