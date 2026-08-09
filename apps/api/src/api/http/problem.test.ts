import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { toProblem, ValidationFailed } from "./problem";

describe("the problem document", () => {
  it("carries a stable type a client can branch on", () => {
    expect(toProblem(new ForbiddenException(), "r1")).toMatchObject({
      type: "urn:ansa:problem:forbidden",
      status: 403,
      requestId: "r1",
    });
  });

  it("lists the fields that failed on a validation error", () => {
    const problem = toProblem(new ValidationFailed([{ path: "email", message: "is required" }]), "r2");
    expect(problem.status).toBe(422);
    expect(problem.errors).toEqual([{ path: "email", message: "is required" }]);
  });

  /**
   * Anything that is not an HttpException is a bug, and its message is as likely to be a
   * stack frame or a connection string as it is to be useful.
   */
  it("never puts an unexpected error's message on the wire", () => {
    const problem = toProblem(new Error("connect ECONNREFUSED 10.0.0.5:5432"), "r3");
    expect(problem.status).toBe(500);
    expect(problem.detail).toBeUndefined();
    expect(JSON.stringify(problem)).not.toContain("10.0.0.5");
  });

  it("omits a detail that only repeats the title", () => {
    expect(toProblem(new NotFoundException(), "r4").detail).toBeUndefined();
  });

  it("keeps a detail that says something the title does not", () => {
    expect(toProblem(new ForbiddenException("this needs the members:write capability"), "r5").detail).toBe(
      "this needs the members:write capability",
    );
  });
});
