import { afterEach, describe, expect, it, vi } from "vitest";

import { asCallId } from "./call";
import { createLogger } from "./logger";

const written: string[] = [];

const writeSpy = vi
  .spyOn(process.stdout, "write")
  .mockImplementation((chunk: string | Uint8Array): boolean => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });

const lines = (): Record<string, unknown>[] =>
  written.map((line) => JSON.parse(line) as Record<string, unknown>);

afterEach(() => {
  written.length = 0;
  writeSpy.mockClear();
});

describe("createLogger", () => {
  it("writes one newline-terminated JSON object per call", () => {
    createLogger().info("answered");

    expect(written).toHaveLength(1);
    expect(written[0]?.endsWith("\n")).toBe(true);
    expect(written[0]?.slice(0, -1).includes("\n")).toBe(false);
    expect(lines()[0]).toMatchObject({ level: "info", msg: "answered" });
  });

  it("stamps an ISO-8601 timestamp on every line", () => {
    createLogger().warn("slow turn");

    const ts = lines()[0]?.["ts"];
    expect(typeof ts).toBe("string");
    expect(new Date(ts as string).toISOString()).toBe(ts);
  });

  it("emits every level", () => {
    const log = createLogger();
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");

    expect(lines().map((l) => l["level"])).toEqual(["debug", "info", "warn", "error"]);
  });

  it("carries base fields onto every line", () => {
    const log = createLogger({ component: "api" });
    log.info("first");
    log.info("second");

    expect(lines().every((l) => l["component"] === "api")).toBe(true);
  });

  // The property Slice 1 actually needs: once a call is bound, no line escapes without
  // its call_id. Slice 2 binds organization_id through the same mechanism.
  it("stamps call_id on every line from a child logger", () => {
    const callId = asCallId("CA-test-0001");
    const log = createLogger({ component: "api" }).child({ callId });

    log.info("stream opened");
    log.debug("frame", { bytes: 160 });
    log.error("stream closed");

    expect(lines()).toHaveLength(3);
    expect(lines().every((l) => l["callId"] === "CA-test-0001")).toBe(true);
    expect(lines().every((l) => l["component"] === "api")).toBe(true);
  });

  it("does not leak child fields back into the parent", () => {
    const parent = createLogger({ component: "api" });
    parent.child({ callId: asCallId("CA-1") }).info("child line");
    parent.info("parent line");

    expect(lines()[0]?.["callId"]).toBe("CA-1");
    expect(lines()[1]).not.toHaveProperty("callId");
  });

  it("nests children cumulatively", () => {
    const log = createLogger({ component: "api" })
      .child({ callId: asCallId("CA-1") })
      .child({ stage: "tts" });

    log.info("synthesising");

    expect(lines()[0]).toMatchObject({
      component: "api",
      callId: "CA-1",
      stage: "tts",
    });
  });

  it("lets per-call fields override bound fields", () => {
    createLogger({ stage: "tts" }).info("done", { stage: "telephony" });

    expect(lines()[0]?.["stage"]).toBe("telephony");
  });
});
