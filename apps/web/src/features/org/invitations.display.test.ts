import { describe, expect, it } from "vitest";

import { expiry, initials, pendingFirst, statusOf } from "./invitations.display";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");
const DAY = 86_400_000;

const invitation = (over: Partial<Record<string, unknown>>) =>
  ({
    id: "i1",
    email: "person@example.com",
    role: "member",
    createdAt: "2026-09-10T12:00:00.000Z",
    expiresAt: new Date(NOW + 6 * DAY).toISOString(),
    acceptedAt: null,
    revokedAt: null,
    ...over,
  }) as never;

describe("where an invitation stands", () => {
  it("ranks revoked over accepted over expired over pending", () => {
    const at = "2026-09-11T00:00:00.000Z";
    expect(statusOf(invitation({ revokedAt: at, acceptedAt: at }), NOW)).toBe("revoked");
    expect(statusOf(invitation({ acceptedAt: at }), NOW)).toBe("accepted");
    expect(statusOf(invitation({ expiresAt: new Date(NOW - DAY).toISOString() }), NOW)).toBe("expired");
    expect(statusOf(invitation({}), NOW)).toBe("pending");
  });

  it("says how long is left in days, and never 'in 0 days'", () => {
    expect(expiry(new Date(NOW + 6 * DAY).toISOString(), NOW)).toBe("expires in 6 days");
    expect(expiry(new Date(NOW + DAY).toISOString(), NOW)).toBe("expires in 1 day");
    expect(expiry(new Date(NOW + 3_600_000).toISOString(), NOW)).toBe("expires today");
    expect(expiry(new Date(NOW - 2 * DAY).toISOString(), NOW)).toBe("expired 2 days ago");
  });

  it("puts pending first, newest first within each", () => {
    const rows = pendingFirst(
      [
        invitation({ id: "old-pending", createdAt: "2026-09-01T00:00:00.000Z" }),
        invitation({
          id: "accepted",
          acceptedAt: "2026-09-11T00:00:00.000Z",
          createdAt: "2026-09-11T00:00:00.000Z",
        }),
        invitation({ id: "new-pending", createdAt: "2026-09-11T00:00:00.000Z" }),
      ],
      NOW,
    );
    expect(rows.map((row) => (row as { id: string }).id)).toEqual([
      "new-pending",
      "old-pending",
      "accepted",
    ]);
  });
});

describe("a person's two letters", () => {
  it("takes them from the name, or the email when there is none", () => {
    expect(initials("Vera Hillman", "vera@example.com")).toBe("VH");
    expect(initials("Vera", "vera@example.com")).toBe("VE");
    expect(initials(null, "ade@example.com")).toBe("AD");
  });
});
