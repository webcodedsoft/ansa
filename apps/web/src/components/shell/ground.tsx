/**
 * The colour field the glass catches, its light source, and its grain.
 *
 * Fixed and non-interactive, sitting at z-0 under everything. Three elements
 * rather than one because they blend differently: the sheen is a plain
 * overlay, the grain multiplies, and stacking them in one background would
 * lose that.
 */
export const Ground = () => (
  <>
    <div className="ansa-ground" aria-hidden />
    <div className="ansa-sheen" aria-hidden />
    <div className="ansa-grain" aria-hidden />
  </>
);
