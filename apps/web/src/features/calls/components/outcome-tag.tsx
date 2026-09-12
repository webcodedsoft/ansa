import {
  CircleCheck,
  CircleX,
  Phone,
  PhoneForwarded,
  PhoneMissed,
  PhoneOff,
  UserRound,
  Voicemail,
  type LucideIcon,
} from "lucide-react";

import { Blip, Tag } from "@/components/ui";

import { type Outcome, type OutcomeIcon } from "../outcome";

/**
 * An outcome as a tag: the glyph that means it, then the word.
 *
 * Seven outcomes share one column, and at forty rows the eye reads shapes before words — a
 * missed-call arrow and a tick are told apart from across the room where "no answer" and
 * "completed" are not. The icon carries the same meaning as the label and never a different
 * one; a person who cannot see it loses nothing.
 *
 * "live" keeps its pulse rather than taking a phone glyph, because a pulse is the only thing
 * on the page that says *now*.
 */
const GLYPHS: Readonly<Record<Exclude<OutcomeIcon, "live">, LucideIcon>> = {
  done: CircleCheck,
  human: UserRound,
  forwarded: PhoneForwarded,
  missed: PhoneMissed,
  busy: PhoneOff,
  voicemail: Voicemail,
  failed: CircleX,
  "hung-up": PhoneOff,
  ended: Phone,
};

export const OutcomeTag = ({ outcome }: { readonly outcome: Outcome }) => {
  if (outcome.icon === "live") {
    return (
      <Tag tone={outcome.tone}>
        <Blip pulse />
        {outcome.label}
      </Tag>
    );
  }
  const Glyph = GLYPHS[outcome.icon];
  return (
    <Tag tone={outcome.tone}>
      <Glyph aria-hidden className="size-3 flex-none" />
      {outcome.label}
    </Tag>
  );
};
