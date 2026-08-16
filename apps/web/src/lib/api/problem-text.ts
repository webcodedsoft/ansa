/**
 * Turning an API refusal into words for the person who caused it.
 *
 * Separated from `server.ts` so it can be tested: that module reaches for `next/headers` at
 * import time and cannot be loaded outside a request. Nothing here touches the network, a
 * cookie or a session — it is string work, and the strings end up in a red box somebody has
 * to act on.
 */

/**
 * The machine path a 422 names a field by, as the words on the screen beside it.
 *
 * `body.http.1.name` is precise and unreadable, and it went straight to the operator: the
 * tool form showed "body.http.1.name must be at least 3 characters. body.http.1.description
 * must be at least 1 characters." — four of those run together in one red box. The path is
 * how the API points at a field; it is not how a person refers to one.
 *
 * Three rules, all of them reversible by eye:
 *
 *   `body.` / `query.` / `path.`   dropped. Everything a form submits is the body, and
 *                                  saying so tells nobody anything.
 *   `.1.`                          becomes `#2`. Array indices are zero-based and people
 *                                  are not, and "the second tool" is the only reading that
 *                                  helps somebody find it.
 *   `camelCase`                    spaced out and capitalised at the front, so `ringSeconds`
 *                                  reads as "Ring seconds".
 *
 * Deliberately not a lookup table of field names. One would read better and would rot the
 * first time a field was renamed, silently, into a label for something that no longer
 * exists — and this has to work for every endpoint, including ones added later.
 */
export const fieldName = (path: string): string => {
  const parts = path.replace(/^(body|query|path)\./, "").split(".");
  const spoken = parts
    .map((part) => (/^\d+$/.test(part) ? `#${Number(part) + 1}` : part))
    .join(" ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return spoken.charAt(0).toUpperCase() + spoken.slice(1);
};

/** Full stops between, one at the end. Four fragments run together read as one long fault. */
export const sentences = (parts: readonly string[]): string =>
  parts.map((part) => (/[.!?]$/.test(part) ? part : `${part}.`)).join(" ");

/**
 * Drop the part of a path that names something the reader is already looking at.
 *
 * `PUT /tools` validates the whole registry, so a form editing one tool is told about
 * `http.1.name` — and somebody on a screen headed "Add a tool" does not think of it as the
 * second one. The caller knows which index it just wrote, so it can say so and have the
 * refusal read "Name is required" instead of "Http #2 name is required".
 *
 * Only strips an exact segment prefix. A path that does not start with it is left whole,
 * because a refusal about a *different* tool is exactly the case where the index matters.
 */
export const withoutPrefix = (path: string, prefix: string): string => {
  const bare = path.replace(/^(body|query|path)\./, "");
  return bare.startsWith(`${prefix}.`) ? bare.slice(prefix.length + 1) : bare;
};
