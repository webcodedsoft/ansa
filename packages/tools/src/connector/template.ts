/**
 * How a organization's JSON becomes a sentence.
 *
 * R5.4.3 says raw JSON is never spoken, and every platform tool satisfies it with a
 * `summarise` function written in TypeScript. A organization-supplied tool cannot do that: it
 * arrives as configuration, and configuration that contains executable code is a remote
 * code execution feature with extra steps.
 *
 * So the organization writes a sentence with holes in it — "Policy {policyNumber} is {status}
 * and renews on {renewsOn}." — and this fills them from the response. A hole that cannot
 * be filled makes the whole render fail rather than emitting "undefined": half a sentence
 * about somebody's policy is worse than the fallback line the organization also had to write.
 */

const PLACEHOLDER = /\{([A-Za-z0-9_.[\]-]+)\}/g;

/**
 * Dotted paths, with numeric segments indexing arrays: `items.0.name`.
 *
 * Only scalars come back. An object or an array at the end of a path is a missing value
 * as far as speech is concerned, which is what stops `{data}` from stringifying the whole
 * response into the caller's ear.
 */
const valueAt = (root: unknown, path: string): string | null => {
  let current: unknown = root;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return null;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return null;
      current = current[Number(segment)];
      continue;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  if (typeof current === "string") return current.trim() === "" ? null : current;
  if (typeof current === "number") return Number.isFinite(current) ? String(current) : null;
  if (typeof current === "boolean") return current ? "yes" : "no";
  return null;
};

/**
 * Null when any placeholder has no scalar behind it — including when the response was
 * null, which is how a connector reports "no such record" (see http.ts).
 */
export const renderTemplate = (template: string, data: unknown): string | null => {
  let missing = false;
  const rendered = template.replace(PLACEHOLDER, (_match, path: string) => {
    const value = valueAt(data, path);
    if (value === null) {
      missing = true;
      return "";
    }
    return value;
  });
  if (missing) return null;
  const trimmed = rendered.trim();
  return trimmed === "" ? null : trimmed;
};

/**
 * The placeholders a template asks for, so a organization's typo is caught at registration
 * rather than discovered on a call as a fallback line nobody understands.
 */
export const templateFields = (template: string): readonly string[] => [
  ...new Set([...template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? "")),
];
