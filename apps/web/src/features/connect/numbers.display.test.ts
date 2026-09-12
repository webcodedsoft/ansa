import { describe, expect, it } from "vitest";

import { countryOf, spaced } from "./numbers.display";

describe("what a card says about a number", () => {
  it("prefers the stored country and reads the dialling code otherwise", () => {
    expect(countryOf("+17065517550", "US")).toBe("US");
    expect(countryOf("+2348031234567", null)).toBe("NG");
    expect(countryOf("+442071234567", null)).toBe("GB");
    expect(countryOf("+9991234", null)).toBe("—");
  });

  it("spaces the numbers it knows the shape of and leaves the rest alone", () => {
    expect(spaced("+17065517550")).toBe("+1 706 551 7550");
    expect(spaced("+2348031234567")).toBe("+234 803 123 4567");
    expect(spaced("+442071234567")).toBe("+44 20 7123 4567");
    expect(spaced("+35312345678")).toBe("+35312345678");
  });
});
