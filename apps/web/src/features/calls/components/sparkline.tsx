/**
 * A trend line with no axes, no legend and no tooltip — a shape to glance at, not a chart
 * to read values off. Anything worth reading precisely already has its own column in the
 * table beside it. `null` entries are gaps in the data, not zeroes, so they are dropped
 * from the line rather than plotted as a dip that never happened.
 */
export const Sparkline = ({
  values,
  width = 96,
  height = 26,
}: {
  readonly values: readonly (number | null)[];
  readonly width?: number;
  readonly height?: number;
}) => {
  const points = values
    .map((value, index) => (value === null ? null : { index, value }))
    .filter((point): point is { index: number; value: number } => point !== null);

  if (points.length < 2) {
    return <span className="text-xs text-[var(--ink-3)]">not enough data</span>;
  }

  const xs = points.map((point) => point.index);
  const ys = points.map((point) => point.value);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const inset = 3;

  const at = (point: { readonly index: number; readonly value: number }) => ({
    x: ((point.index - minX) / spanX) * (width - inset * 2) + inset,
    y: height - inset - ((point.value - minY) / spanY) * (height - inset * 2),
  });

  const path = points.map((point) => {
    const { x, y } = at(point);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const last = points[points.length - 1];
  const lastAt = last === undefined ? null : at(last);

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Trend">
      <polyline
        points={path.join(" ")}
        fill="none"
        style={{ stroke: "var(--accent)" }}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {lastAt !== null && <circle cx={lastAt.x} cy={lastAt.y} r={2.25} style={{ fill: "var(--accent)" }} />}
    </svg>
  );
};
