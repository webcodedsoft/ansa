import { describe, expect, it } from "vitest";

import { contextOf, nameOf } from "./contacts.display";

/* The API's own shape, narrowed to the fields these functions read. Casting keeps the test
   about the display rule rather than about assembling a full contact response. */
const person = (
  values: readonly { readonly fieldType: string; readonly value: string }[],
  displayName: string | null = null,
) =>
  ({
    displayName,
    phone: "+2348034112290",
    values: values.map((value) => ({ ...value, fieldKey: value.fieldType, sourceCallId: null })),
  }) as never;

describe("what a directory row says this person wanted", () => {
  it("joins the confirmed values into one line", () => {
    expect(
      contextOf(
        person([
          { fieldType: "area", value: "Lekki Phase 1" },
          { fieldType: "budget", value: "₦4.5m/yr" },
        ]),
      ),
    ).toBe("Lekki Phase 1 · ₦4.5m/yr");
  });

  it("leaves the name out, because it is already the heading of the row", () => {
    /* The whole column is one line wide. Spending it on the name the reader has just read is
       the one way this column can be worse than empty. */
    expect(
      contextOf(
        person([
          { fieldType: "name", value: "Amaka Obi" },
          { fieldType: "area", value: "Ikeja" },
        ]),
      ),
    ).toBe("Ikeja");
  });

  it("says nothing at all when a name is all they confirmed", () => {
    // Not an em dash: a placeholder in every such row is noise in the column meant to be scanned.
    expect(contextOf(person([{ fieldType: "name", value: "Amaka Obi" }]))).toBe("");
    expect(contextOf(person([]))).toBe("");
  });

  it("stops at three, so a talkative caller cannot push the columns around", () => {
    const many = ["a", "b", "c", "d", "e"].map((one) => ({ fieldType: one, value: one }));
    expect(contextOf(person(many))).toBe("a · b · c");
  });

  it("drops a value that is confirmed but blank", () => {
    /* An empty string is a capture that fired and caught nothing. Joining it produces a
       leading separator — " · Ikeja" — which reads as a missing first word. */
    expect(
      contextOf(
        person([
          { fieldType: "area", value: "   " },
          { fieldType: "budget", value: "₦4.5m/yr" },
        ]),
      ),
    ).toBe("₦4.5m/yr");
  });
});

describe("what a person is called", () => {
  it("prefers the operator's correction over the captured name", () => {
    expect(nameOf(person([{ fieldType: "name", value: "A Marker Obey" }], "Amaka Obi"))).toBe(
      "Amaka Obi",
    );
  });

  it("falls back to the captured name, then to saying nobody gave one", () => {
    expect(nameOf(person([{ fieldType: "name", value: "Amaka Obi" }]))).toBe("Amaka Obi");
    expect(nameOf(person([{ fieldType: "area", value: "Ikeja" }]))).toBe("Unnamed caller");
  });
});
