/**
 * The two facts about uploading that both sides need to agree on.
 *
 * Separate from `./index` because that module reaches `node:zlib` to inflate a .docx, while the
 * file picker offering these extensions runs in the browser. Importing the extractor from a
 * client component just to read one array would pull a ZIP reader and a PDF parser into the
 * bundle, and Next would refuse the build long before that mattered.
 */

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** What the file picker offers, and the only extensions the extractor will attempt. */
export const ACCEPTED_EXTENSIONS = [".pdf", ".docx", ".txt", ".md", ".csv", ".tsv"] as const;
