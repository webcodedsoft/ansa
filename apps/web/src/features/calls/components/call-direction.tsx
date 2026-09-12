import { PhoneIncoming, PhoneOutgoing } from "lucide-react";

import { cn } from "@/lib/cn";
import { directionLabel } from "@/lib/format";

/**
 * Which way a call went, with the arrow to match.
 *
 * The words come from `directionLabel`, which is the one place the carrier's `inbound` and
 * `outbound` become something a person says; this only adds the glyph. An icon and a label
 * together read faster than either alone in a column of forty rows, and the arrow is the same
 * one the "Test call" button already uses, so the two agree on what "out" looks like.
 */
export const CallDirection = ({
  direction,
  className,
}: {
  readonly direction: string;
  readonly className?: string;
}) => {
  const Icon = direction === "outbound" ? PhoneOutgoing : PhoneIncoming;
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap", className)}>
      <Icon aria-hidden className="size-3.5 flex-none" />
      {directionLabel(direction)}
    </span>
  );
};
