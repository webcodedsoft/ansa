import { describe, expect, it, vi } from "vitest";

import {
  BOOK_APPOINTMENT,
  FIND_SLOTS,
  appointmentDefinitions,
  appointmentTools,
  sayInstant,
  type BookingAnswer,
  type OfferedSlot,
} from "./appointments";

const SLOTS: readonly OfferedSlot[] = [
  { startsAt: "2026-03-03T14:00:00+01:00", spoken: "Tuesday at 2" },
  { startsAt: "2026-03-03T14:30:00+01:00", spoken: "Tuesday at half past 2" },
  { startsAt: "2026-03-03T15:00:00+01:00", spoken: "Tuesday at 3" },
  { startsAt: "2026-03-03T15:30:00+01:00", spoken: "Tuesday at half past 3" },
];

const NOT_CALLED = () => {
  throw new Error("this test should not have reached the diary");
};

const tool = (name: string, options: Partial<Parameters<typeof appointmentTools>[0]>) => {
  const found = appointmentTools({
    hasCalendar: true,
    findSlots: NOT_CALLED,
    book: NOT_CALLED,
    ...options,
  }).find((t) => t.definition.name === name);
  if (found === undefined) throw new Error(`no ${name}`);
  return found;
};

describe("the tiers these two carry", () => {
  it("looks freely and commits only after a spoken yes", () => {
    /* Offering times and taking one are different acts with different risk. Fusing them would
       force the whole thing to the higher tier, and a caller asking "what have you got on
       Thursday?" would be read a confirmation to hear the answer. */
    expect(FIND_SLOTS.riskTier).toBe("read");
    expect(BOOK_APPOINTMENT.riskTier).toBe("write");
  });

  it("supplies the readback its tier requires", () => {
    // Registration refuses a write tool without one, so this is what makes it registrable.
    expect(typeof BOOK_APPOINTMENT.readback).toBe("function");
    expect(BOOK_APPOINTMENT.readback?.({ startsAt: "2026-03-03T14:00:00+01:00" })).toContain(
      "3 March at 2pm",
    );
  });

  it("never reads a raw instant out loud", () => {
    /* Nobody agrees to "2026-03-03T14:00:00+01:00". A readback that said it would be worse
       than no readback, because it sounds like confirmation and carries none. */
    const spoken = BOOK_APPOINTMENT.readback?.({ startsAt: "2026-03-03T14:00:00+01:00" }) ?? "";
    expect(spoken).not.toContain("2026-03-03T14:00");
    expect(spoken).not.toContain("+01:00");
  });
});

describe("saying an instant", () => {
  it("reads the offset it carries rather than the machine's zone", () => {
    // The slots come from `toOffsetIso`, so the offset is already the calendar's own.
    expect(sayInstant("2026-03-03T14:00:00+01:00")).toBe("3 March at 2pm");
    expect(sayInstant("2026-03-03T09:30:00+01:00")).toBe("3 March at 9:30am");
    expect(sayInstant("2026-03-03T00:00:00+01:00")).toBe("3 March at 12am");
    expect(sayInstant("2026-03-03T12:00:00+01:00")).toBe("3 March at 12pm");
  });

  it("says something rather than nothing when handed nonsense", () => {
    expect(sayInstant("not a time")).toBe("that time");
  });
});

describe("offering times", () => {
  it("hands back what the diary said", async () => {
    const findSlots = vi.fn(async () => SLOTS);
    const answer = await tool("find_appointment_slots", { findSlots }).handler({ args: {} });

    expect(findSlots).toHaveBeenCalledWith(null);
    expect(answer).toMatchObject({ known: true });
  });

  it("passes a day through, and ignores one the model made up", async () => {
    const findSlots = vi.fn(async () => SLOTS);
    const t = tool("find_appointment_slots", { findSlots });

    await t.handler({ args: { day: "2026-03-05" } });
    expect(findSlots).toHaveBeenLastCalledWith("2026-03-05");

    /* A malformed day is not a reason to fail the lookup — it falls back to "the next few
       times", which is what the caller asked for anyway. */
    await t.handler({ args: { day: "next Thursday" } });
    expect(findSlots).toHaveBeenLastCalledWith(null);
  });

  it("reads out three at most", () => {
    /* A speech decision, not a data one: nine times read down a phone is a list nobody
       remembers the start of. */
    const spoken = FIND_SLOTS.summarise({ known: true, slots: SLOTS });
    expect(spoken).toContain("Tuesday at 2");
    expect(spoken).not.toContain("half past 3");
  });

  it("says so plainly when there is nothing free", () => {
    expect(FIND_SLOTS.summarise({ known: true, slots: [] })).toBe("There is nothing free then.");
  });
});

describe("an agent with no calendar", () => {
  it("registers neither tool", () => {
    /* Not "registers them and refuses". A tool the model can see is a tool it will offer,
       and "let me book you in" followed by a refusal is worse than never raising it. */
    expect(appointmentTools({ hasCalendar: false, findSlots: NOT_CALLED, book: NOT_CALLED })).toEqual([]);
  });

  it("is described to the model on exactly the condition it is registered", () => {
    /* The prompt list and the registry read one gate, so the model cannot be told about a
       booking the dispatcher would refuse. Same argument as CALL_CONTROL_DEFINITIONS. */
    expect(appointmentDefinitions(false)).toEqual([]);
    expect(appointmentDefinitions(true).map((d) => d.name)).toEqual(
      appointmentTools({ hasCalendar: true, findSlots: NOT_CALLED, book: NOT_CALLED }).map(
        (t) => t.definition.name,
      ),
    );
  });
});

describe("taking one", () => {
  it("passes the time and the name through", async () => {
    const book = vi.fn(async (): Promise<BookingAnswer> => ({ booked: true, spoken: "Tuesday at 2" }));
    const answer = await tool("book_appointment", { book }).handler({
      args: { startsAt: "2026-03-03T14:00:00+01:00", name: "Adaeze" },
    });

    expect(book).toHaveBeenCalledWith("2026-03-03T14:00:00+01:00", "Adaeze");
    expect(BOOK_APPOINTMENT.summarise(answer)).toBe("Booked Tuesday at 2.");
  });

  it("refuses without a time rather than guessing one", async () => {
    const book = vi.fn();
    const answer = await tool("book_appointment", { book: book as never }).handler({ args: {} });

    expect(book).not.toHaveBeenCalled();
    expect(answer).toMatchObject({ booked: false, reason: "no time was given" });
  });

  it("says why when the diary refused", async () => {
    const book = async (): Promise<BookingAnswer> => ({
      booked: false,
      reason: "somebody has just taken that time",
    });
    const answer = await tool("book_appointment", { book }).handler({
      args: { startsAt: "2026-03-03T14:00:00+01:00" },
    });
    expect(BOOK_APPOINTMENT.summarise(answer)).toContain("somebody has just taken that time");
  });
});
