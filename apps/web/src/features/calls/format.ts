/**
 * Formatting for the numbers the metrics endpoints hand back.
 *
 * Rates arrive as strings — "0.5000" — so their precision survives the trip from Postgres
 * without a float rounding it on the way. This is the one place that turns one into a
 * percentage, so the quality table, the trend table and the headline stat cards never round
 * differently from each other.
 */
export const percent = (rate: string | null): string =>
  rate === null ? "—" : `${(Number(rate) * 100).toFixed(1)}%`;

/** A millisecond duration, always shown in milliseconds — the unit these fields are in. */
export const msLabel = (value: number | null): string =>
  value === null ? "—" : `${Math.round(value)}ms`;
