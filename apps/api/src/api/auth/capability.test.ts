import { MEMBER_ROLES } from "@ansa/db";
import { describe, expect, it } from "vitest";

import { ALL_CAPABILITIES, can, capabilitiesOf } from "./capability";

describe("roles and capabilities", () => {
  it("gives a member no way to change anything", () => {
    const writes = ALL_CAPABILITIES.filter((capability) => capability.endsWith(":write"));
    expect(writes.filter((capability) => can("member", capability))).toEqual([]);
  });

  /** An admin runs the agent; only an owner decides who is in the organisation. */
  it("keeps people management away from admins", () => {
    expect(can("admin", "config:write")).toBe(true);
    expect(can("admin", "members:write")).toBe(false);
    expect(can("admin", "invitations:write")).toBe(false);
  });

  it("gives an owner everything", () => {
    for (const capability of ALL_CAPABILITIES) expect(can("owner", capability)).toBe(true);
  });

  it("lets every role read its organisation's calls", () => {
    for (const role of MEMBER_ROLES) expect(can(role, "calls:read")).toBe(true);
  });

  /**
   * The dashboard hides controls the caller cannot use, from this list. If it did not
   * match what the guard enforces, a button would appear that always returns 403.
   */
  it("reports exactly what the guard would allow", () => {
    for (const role of MEMBER_ROLES) {
      for (const capability of ALL_CAPABILITIES) {
        expect(capabilitiesOf(role).includes(capability)).toBe(can(role, capability));
      }
    }
  });
});
