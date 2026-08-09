/**
 * Keeping a sentence inside the length its response schema declares.
 *
 * Not defensive tidiness. The interceptor projects every response through its schema and
 * answers 500 when the handler returns something the schema rejects, so a detail line that
 * grew past its bound — an organisation with forty tools, a parser message quoting a long
 * value, a dialled number somebody typed a paragraph into — would turn a health endpoint
 * into an error. The one endpoint that must answer when things are wrong is the one that
 * must not fall over on a long string.
 *
 * Truncated rather than dropped: two thirds of the reason is still the reason.
 */
export const clamp = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
