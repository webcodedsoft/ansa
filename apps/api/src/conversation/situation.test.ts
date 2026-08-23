import { describe, expect, it } from "vitest";

import { describeSituation, renderSituation, type SituationInput } from "./situation";

/**
 * The block exists because the agent was doing this arithmetic itself and getting it
 * wrong. So most of what is asserted here is the arithmetic — the boundary hours, the
 * exclusive close, the flooring — and then that the wording only appears when it has
 * something to say.
 */

/** Nigeria is UTC+1 with no daylight saving, so WAT is UTC plus one hour, always. */
const wat = (iso: string): Date => new Date(`${iso}+01:00`);

const OFFICE = { opensAtHour: 9, closesAtHour: 17, openDays: [1, 2, 3, 4, 5] };

/**
 * A call that started the instant it is being described, unless a test says otherwise.
 *
 * `callStartedAtMs` follows `now` rather than sitting at a fixed default — the first
 * version pinned it, so moving the clock to test the closing warning silently aged the
 * call to twenty-eight minutes and fired the long-call line as well.
 */
const at = (over: Partial<SituationInput> = {}): SituationInput => {
  // A Tuesday.
  const now = over.now ?? wat("2026-03-10T14:32:00");
  return {
    now,
    callStartedAtMs: now.getTime(),
    businessHours: OFFICE,
    failedTurns: 0,
    escalationOffered: false,
    history: null,
    ...over,
  };
};

describe("what time it is where the caller is", () => {
  it("reads the clock in WAT, not in the server's timezone", () => {
    // The whole point: a server in Ohio must not tell a Lagos caller it is morning.
    const s = describeSituation(at({ now: new Date("2026-03-10T13:32:00Z") }));
    expect(s.localTime).toBe("14:32");
    expect(s.weekday).toBe("Tuesday");
  });

  it("names the part of day at each boundary", () => {
    const partAt = (hour: number): string =>
      describeSituation(at({ now: wat(`2026-03-10T${String(hour).padStart(2, "0")}:00:00`) }))
        .partOfDay;

    expect(partAt(11)).toBe("morning");
    expect(partAt(12)).toBe("afternoon");
    expect(partAt(16)).toBe("afternoon");
    expect(partAt(17)).toBe("evening");
    expect(partAt(20)).toBe("evening");
    expect(partAt(21)).toBe("night");
  });
});

describe("whether the line is open", () => {
  it("treats the closing hour as exclusive, the way the config is written", () => {
    // A line that shuts at five holds 17. At 17:00 it is shut, not shutting.
    expect(describeSituation(at({ now: wat("2026-03-10T16:59:00") })).openNow).toBe(true);
    expect(describeSituation(at({ now: wat("2026-03-10T17:00:00") })).openNow).toBe(false);
  });

  it("is closed on a day the organisation is not open", () => {
    // A Sunday, inside the hours but not on an open day.
    expect(describeSituation(at({ now: wat("2026-03-15T11:00:00") })).openNow).toBe(false);
  });

  it("counts the minutes to closing from the top of the closing hour", () => {
    expect(describeSituation(at({ now: wat("2026-03-10T16:20:00") })).closesInMinutes).toBe(40);
    expect(describeSituation(at({ now: wat("2026-03-10T14:32:00") })).closesInMinutes).toBe(148);
  });

  it("knows nothing when the organisation configured no hours", () => {
    /* Null and not false. "We are shut" and "nobody told us" are different claims, and the
       renderer says nothing at all rather than guessing a nine to five. */
    const s = describeSituation(at({ businessHours: null }));
    expect(s.openNow).toBeNull();
    expect(s.closesInMinutes).toBeNull();
    // The date line is always there now; what matters is that nothing about hours is.
    expect(renderSituation(s)).not.toContain("closed");
  });
});

describe("how long they have been on the phone", () => {
  it("floors, so forty seconds is nought minutes", () => {
    // Rounding up would have the agent behaving as though the caller had been waiting.
    const s = describeSituation(
      at({
        now: wat("2026-03-10T14:32:40"),
        callStartedAtMs: wat("2026-03-10T14:32:00").getTime(),
      }),
    );
    expect(s.minutesElapsed).toBe(0);
  });

  it("never goes negative when the clocks disagree", () => {
    const s = describeSituation(
      at({
        now: wat("2026-03-10T14:32:00"),
        callStartedAtMs: wat("2026-03-10T14:33:00").getTime(),
      }),
    );
    expect(s.minutesElapsed).toBe(0);
  });
});

describe("the block the model reads", () => {
  it("still tells the agent the date on an otherwise unremarkable turn", () => {
    /* This asserted the empty string, on the argument that a paragraph about a quiet
       Tuesday costs prompt budget and teaches the model nothing. That was right while the
       line was only a clock, and wrong once it carried the date: the date is the one thing
       the agent cannot work out from anywhere else, and a caller saying "next Tuesday" is
       unanswerable without it. One line, not a paragraph.

       What the suppression was really protecting against — the clock inviting "good
       afternoon!" as an opener — is handled where it belongs now: `prompts/conversation.ts`
       opens by saying the greeting has already been spoken. */
    const quiet = renderSituation(describeSituation(at()));
    expect(quiet).toContain("Today is");
    expect(quiet.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);
  });

  it("warns about closing only inside the last hour", () => {
    expect(
      renderSituation(describeSituation(at({ now: wat("2026-03-10T15:00:00") }))),
    ).not.toContain("closes in");

    const closing = renderSituation(describeSituation(at({ now: wat("2026-03-10T16:20:00") })));
    expect(closing).toContain("closes in 40 minutes");
    expect(closing).toContain("cannot finish");
  });

  it("says the line is shut outside hours, and does not promise today", () => {
    const shut = renderSituation(describeSituation(at({ now: wat("2026-03-10T21:00:00") })));
    expect(shut).toContain("closed right now");
    expect(shut).toContain("Do not promise anything for today");
  });

  it("raises a long call once it is genuinely long", () => {
    const started = wat("2026-03-10T14:32:00").getTime();
    const after = (minutes: number): string =>
      renderSituation(
        describeSituation(at({ now: new Date(started + minutes * 60_000), callStartedAtMs: started })),
      );

    expect(after(3)).not.toContain("running");
    expect(after(6)).toContain("running 6 minutes");
    expect(after(6)).toContain("start resolving");
  });

  it("counts failed turns so the agent can give up before the hard rule does", () => {
    /* The rule transfers at three whatever the prompt does. Seeing two is what lets the
       agent offer a person itself, rather than being cut off mid-sentence on the third. */
    expect(renderSituation(describeSituation(at({ failedTurns: 1 })))).toContain("One turn has");
    expect(renderSituation(describeSituation(at({ failedTurns: 2 })))).toContain("2 turns have");
  });

  it("stops asking once a person has been offered", () => {
    // Offering twice reads as not having listened the first time.
    const offered = renderSituation(
      describeSituation(at({ failedTurns: 2, escalationOffered: true })),
    );
    expect(offered).toContain("already offered them a person");
    expect(offered).not.toContain("gone nowhere");
  });

  it("puts the clock line in whenever anything else fires", () => {
    // The other lines are meaningless without it — "closes in 40 minutes" from when?
    const closing = renderSituation(describeSituation(at({ now: wat("2026-03-10T16:20:00") })));
    expect(closing).toContain("Today is Tuesday 10 March 2026");
    expect(closing).toContain("It is 16:20 in the afternoon");
  });
});

describe("what we already know about this caller", () => {
  const rang = (over: Partial<{
    lastContactDaysAgo: number | null;
    contactsThisWeek: number;
    lastCallAbout: string | null;
    lastCallHandedOver: boolean;
  }> = {}) => ({
    lastContactDaysAgo: 1,
    contactsThisWeek: 1,
    lastCallAbout: null as string | null,
    lastCallHandedOver: false,
    ...over,
  });

  it("says nothing at all when the history has not arrived", () => {
    /* Null covers a withheld number, no database, a read still in flight and a read that
       failed. The agent's correct behaviour is identical in all four: treat them as new. */
    expect(renderSituation(describeSituation(at({ history: null })))).not.toContain("before");
  });

  it("says nothing for a caller with no calls in the window", () => {
    const s = describeSituation(
      at({ history: rang({ lastContactDaysAgo: null, contactsThisWeek: 0 }) }),
    );
    expect(renderSituation(s)).not.toContain("before");
  });

  it("quotes what they opened with last time, and says it is only a transcript", () => {
    /* The line above it is right that an agent told "their issue is unresolved" invents the
       issue. Attribution is the difference: quoting the caller's own words cannot invent a
       delivery, and 8kHz transcripts are wrong often enough that it must not be repeated
       as fact. */
    const block = renderSituation(
      describeSituation(at({ history: rang({ lastCallAbout: "I want to book a viewing in Lekki" }) })),
    );
    expect(block).toContain('"I want to book a viewing in Lekki"');
    expect(block).toContain("rough transcript");
    expect(block).toContain("never as something you know");
  });

  it("says nothing about a previous subject when there is none", () => {
    const block = renderSituation(describeSituation(at({ history: rang({ lastCallAbout: null }) })));
    expect(block).not.toContain("Last time they opened");
  });

  it("tells the agent not to make a returning caller start over", () => {
    // The complaint people actually make about these systems.
    const block = renderSituation(describeSituation(at({ history: rang() })));
    expect(block).toContain("They called before, yesterday");
    expect(block).toContain("do not make them explain it again");
  });

  it("says when they rang in words rather than a date", () => {
    const said = (days: number): string =>
      renderSituation(describeSituation(at({ history: rang({ lastContactDaysAgo: days }) })));

    expect(said(0)).toContain("earlier today");
    expect(said(1)).toContain("yesterday");
    expect(said(4)).toContain("4 days ago");
    // Past a week the exact figure stops mattering and starts sounding like surveillance.
    expect(said(40)).toContain("a while back");
  });

  it("reports a handover as a handover, never as an unresolved issue", () => {
    /* Nothing on disk knows what the last call was about. An agent told "their issue is
       unresolved" will invent the issue; told "a person took over", it can only say that. */
    const block = renderSituation(
      describeSituation(at({ history: rang({ lastCallAbout: null,
      lastCallHandedOver: true }) })),
    );
    expect(block).toContain("a person taking over");
    expect(block).not.toContain("unresolved");
  });

  it("stops trying after three calls in a week and asks for a person", () => {
    // Three contacts means the process failed, not the caller.
    const twice = renderSituation(describeSituation(at({ history: rang({ contactsThisWeek: 2 }) })));
    expect(twice).not.toContain("call this week");

    const thrice = renderSituation(
      describeSituation(at({ history: rang({ contactsThisWeek: 3 }) })),
    );
    // Their fourth: three before this one.
    expect(thrice).toContain("their 4th call this week");
    expect(thrice).toContain("get them to a person now");
  });
});
