import { pivot } from "@/features/calls/captures";
import { listCaptures } from "@/features/calls/calls.service";
import { toCsv } from "@/features/calls/export/csv";
import { toPdf } from "@/features/calls/export/pdf";
import { sheetOf, toJson } from "@/features/calls/export/sheet";
import { toXlsx } from "@/features/calls/export/xlsx";
import { AnsaApiError } from "@/lib/api/generated";

export const dynamic = "force-dynamic";

/**
 * The dataset as a file, in whichever format the operator asked for.
 *
 * A route handler rather than four buttons building files in the browser. Writing Excel and
 * PDF is real work — a ZIP writer, a CRC, a cross-reference table — and none of it has any
 * business in a page bundle that everyone who opens the console downloads. Here it runs on
 * the server, the download is a plain link, and the page needs no client JavaScript at all.
 *
 * The filters arrive as the same query parameters the page itself reads, so the file and the
 * table are the same view by construction. The rows are re-fetched rather than passed in: a
 * link cannot carry a few thousand of them, and refetching means the file reflects the
 * moment it was asked for rather than the moment the page happened to render.
 */

type Format = "csv" | "xlsx" | "pdf" | "json";

const FORMATS: Record<Format, { readonly type: string; readonly extension: string }> = {
  csv: { type: "text/csv; charset=utf-8", extension: "csv" },
  // The real thing. A `.xls` serving CSV is what Excel warns about on open.
  xlsx: {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: "xlsx",
  },
  pdf: { type: "application/pdf", extension: "pdf" },
  json: { type: "application/json; charset=utf-8", extension: "json" },
};

const isFormat = (value: string | null): value is Format =>
  value !== null && Object.hasOwn(FORMATS, value);

export const GET = async (request: Request): Promise<Response> => {
  const params = new URL(request.url).searchParams;
  const format = params.get("format");
  if (!isFormat(format)) {
    return new Response("Unknown format. Use csv, xlsx, pdf or json.", { status: 400 });
  }

  let captures;
  try {
    captures = await listCaptures({
      agentId: params.get("agentId") ?? undefined,
      from: params.get("from") ?? undefined,
      to: params.get("to") ?? undefined,
    });
  } catch (error) {
    /* A download is not a page, so there is nowhere useful to redirect to. The status is the
       answer, and the browser shows it rather than saving a file full of HTML. */
    if (error instanceof AnsaApiError) {
      return new Response(error.problem.title, { status: error.problem.status });
    }
    throw error;
  }

  const generatedAt = new Date();
  const pivoted = pivot(captures.rows);
  const sheet = sheetOf(pivoted);

  const body =
    format === "csv"
      ? toCsv(sheet)
      : format === "json"
        ? toJson(pivoted, generatedAt)
        : format === "xlsx"
          ? toXlsx(sheet)
          : toPdf(sheet, generatedAt);

  const name = `ansa-collected-${generatedAt.toISOString().slice(0, 10)}.${FORMATS[format].extension}`;

  return new Response(body as BodyInit, {
    headers: {
      "content-type": FORMATS[format].type,
      // `attachment` so the browser saves it rather than displaying a PDF inline and leaving
      // the operator with no file.
      "content-disposition": `attachment; filename="${name}"`,
      /* Said in a header as well as on the page. Somebody who bookmarks this link never sees
         the page's warning, and a truncated export that looks complete is the failure worth
         repeating yourself over. */
      "x-ansa-truncated": String(captures.truncated),
      "cache-control": "no-store",
    },
  });
};
