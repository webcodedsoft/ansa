import type { CallRecord, MetricEvent } from "@ansa/db";

/**
 * What a call consumed, and what that costs (Slice 8).
 *
 * The split here is the whole design: **usage is a fact and price is a configuration.**
 * Usage is derived from the event log and is true whatever anybody charges; a rate is an
 * operator's contract with a vendor, changes without any code changing, and differs between
 * two deployments of the same build. So nothing in this file contains a number. With no
 * rates configured it reports units and no money at all, which is the honest answer rather
 * than a plausible one.
 *
 * Pure arithmetic over the same `CallRecord[]` that `scoreCalls` reads, for the same reason
 * it is: a figure computed one way in SQL and another way in TypeScript is two figures with
 * one name. Nothing here touches the database.
 *
 * **The known gap: the model.** A vendor bills tokens, `LlmProvider` does not report them,
 * and no amount of arithmetic over this log will produce them. What is reported instead is
 * turns and characters — a proxy that moves with the real number and is not the real number
 * — and there is deliberately no rate field to price it with, because a per-character LLM
 * price would be a made-up figure wearing a decimal point. Closing it means the completion
 * stream carrying usage back from the adapter.
 */

/** Per-second, so a 40-second call is not rounded into a minute it did not use. */
export interface CallUsage {
  readonly calls: number;
  /**
   * Carrier time. Our own measure of the media stream's lifetime, which is conversation
   * time rather than billing time — a carrier rounds up and bills its own way, so this is
   * the floor of what will be invoiced, never the invoice.
   */
  readonly telephonySeconds: number;
  /**
   * Listening, by vendor (R4.1.9). Two entries on a composite call, because two
   * connections are open and both are metered for the whole call whichever one produced
   * the words. Tracking it per provider is the only way the second connection can be shown
   * to earn what it costs.
   */
  readonly listenSecondsByProvider: ReadonlyMap<string, number>;
  /**
   * Characters handed to the voice, including a sentence re-sent after a failure — that is
   * a second charge for the same words and hiding it would understate the bill on exactly
   * the calls that went worst.
   *
   * Excludes the greeting and the thinking-gap phrases when they were pre-rendered, and
   * that is correct rather than a simplification: those are synthesised once per process
   * per voice and shared by every call, so charging them to a call would be double counting.
   */
  readonly ttsCharacters: number;
  readonly llmTurns: number;
  /** System prompt plus the whole history, resent every turn. See the note at the top. */
  readonly llmPromptCharacters: number;
  readonly llmReplyCharacters: number;
  /** Calls with no duration recorded. Everything above is a floor by this many calls. */
  readonly callsWithoutDuration: number;
}

const EMPTY: CallUsage = {
  calls: 0,
  telephonySeconds: 0,
  listenSecondsByProvider: new Map(),
  ttsCharacters: 0,
  llmTurns: 0,
  llmPromptCharacters: 0,
  llmReplyCharacters: 0,
  callsWithoutDuration: 0,
};

const detailOf = (event: MetricEvent): Record<string, unknown> =>
  typeof event.detail === "object" && event.detail !== null
    ? (event.detail as Record<string, unknown>)
    : {};

const numberOf = (detail: Record<string, unknown>, key: string): number => {
  const value = Number(detail[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
};

const textOf = (detail: Record<string, unknown>, key: string): string => {
  const value = detail[key];
  return typeof value === "string" ? value : "";
};

/**
 * Which vendors listened to this call.
 *
 * A composite call names its two halves separately; anything else is one connection under
 * its own name. Falls back to the recorded provider string rather than guessing, so a
 * provider added later appears in the breakdown without this file changing.
 */
const listenersOn = (call: CallRecord): readonly string[] => {
  const configured = call.events.find((e) => e.kind === "call configuration");
  if (configured === undefined) return [];
  const detail = detailOf(configured);
  const provider = textOf(detail, "listenProvider");
  if (provider !== "composite") return provider === "" ? [] : [provider];

  const words = textOf(detail, "listenWords");
  const turns = textOf(detail, "listenTurns");
  // Two sessions are opened even when one vendor serves both, so both are billed. Recorded
  // as two entries under the same name rather than deduplicated.
  return [words, turns].filter((name) => name !== "");
};

export const usageOf = (call: CallRecord): CallUsage => {
  const seconds = call.durationSeconds ?? 0;
  const listen = new Map<string, number>();
  for (const provider of listenersOn(call)) {
    listen.set(provider, (listen.get(provider) ?? 0) + seconds);
  }

  let ttsCharacters = 0;
  let llmTurns = 0;
  let llmPromptCharacters = 0;
  let llmReplyCharacters = 0;

  for (const event of call.events) {
    const detail = detailOf(event);
    switch (event.kind) {
      case "tts_start":
        ttsCharacters += numberOf(detail, "chars");
        break;
      case "llm_start":
        llmTurns += 1;
        llmPromptCharacters += numberOf(detail, "promptChars");
        break;
      case "agent said":
        // Only the model's own turns. A readback, a recovery line and a tool's reply all
        // land here too and none of them cost a completion, so they are excluded by the
        // absence of the action a budgeted model turn always carries.
        if (detail["action"] !== undefined) llmReplyCharacters += textOf(detail, "text").length;
        break;
      default:
        break;
    }
  }

  return {
    calls: 1,
    telephonySeconds: seconds,
    listenSecondsByProvider: listen,
    ttsCharacters,
    llmTurns,
    llmPromptCharacters,
    llmReplyCharacters,
    callsWithoutDuration: call.durationSeconds === null ? 1 : 0,
  };
};

const addUsage = (a: CallUsage, b: CallUsage): CallUsage => {
  const listen = new Map(a.listenSecondsByProvider);
  for (const [provider, seconds] of b.listenSecondsByProvider) {
    listen.set(provider, (listen.get(provider) ?? 0) + seconds);
  }
  return {
    calls: a.calls + b.calls,
    telephonySeconds: a.telephonySeconds + b.telephonySeconds,
    listenSecondsByProvider: listen,
    ttsCharacters: a.ttsCharacters + b.ttsCharacters,
    llmTurns: a.llmTurns + b.llmTurns,
    llmPromptCharacters: a.llmPromptCharacters + b.llmPromptCharacters,
    llmReplyCharacters: a.llmReplyCharacters + b.llmReplyCharacters,
    callsWithoutDuration: a.callsWithoutDuration + b.callsWithoutDuration,
  };
};

export const usageOverCalls = (calls: readonly CallRecord[]): CallUsage =>
  calls.map(usageOf).reduce(addUsage, EMPTY);

/**
 * What each unit costs, in whatever currency the operator configured them in.
 *
 * Every field is optional and nothing is defaulted. An unset rate produces `null` money
 * rather than zero: "we do not know what this costs" and "this costs nothing" are opposite
 * statements and a dashboard that confuses them will be used to set a price.
 */
export interface CostRates {
  readonly currency: string;
  readonly telephonyPerMinute?: number;
  /** By vendor, because they do not charge the same and the point is comparing them. */
  readonly listenPerMinute: ReadonlyMap<string, number>;
  readonly ttsPer1kCharacters?: number;
}

export interface CostLine {
  readonly label: string;
  /** The billable quantity, and the unit it is counted in. Always present. */
  readonly quantity: number;
  readonly unit: string;
  /** Null when no rate is configured for it, or when it cannot be priced at all. */
  readonly amount: number | null;
  /** Why there is no amount, when there is none. Empty when there is one. */
  readonly note: string;
}

export interface CallCost {
  readonly currency: string;
  readonly lines: readonly CostLine[];
  /** Null unless every line that could be priced was priced. A partial total is a lie. */
  readonly total: number | null;
  readonly perCall: number | null;
}

const UNPRICEABLE_LLM =
  "the vendor bills tokens and the completion stream does not report them";

const line = (
  label: string,
  quantity: number,
  unit: string,
  rate: number | undefined,
  per: number,
): CostLine =>
  rate === undefined
    ? { label, quantity, unit, amount: null, note: "no rate configured" }
    : { label, quantity, unit, amount: (quantity / per) * rate, note: "" };

export const priceUsage = (usage: CallUsage, rates: CostRates): CallCost => {
  const lines: CostLine[] = [
    line("Telephony", usage.telephonySeconds, "seconds", rates.telephonyPerMinute, 60),
    ...[...usage.listenSecondsByProvider].map(([provider, seconds]) =>
      line(`Listen · ${provider}`, seconds, "seconds", rates.listenPerMinute.get(provider), 60),
    ),
    line("Voice", usage.ttsCharacters, "characters", rates.ttsPer1kCharacters, 1_000),
    {
      label: "Model",
      quantity: usage.llmTurns,
      unit: "turns",
      amount: null,
      note: UNPRICEABLE_LLM,
    },
  ];

  // Every priced line, or nothing. A total missing the model and one of the listeners looks
  // like a number and is not one, and somebody will divide by call count and quote it.
  const priced = lines.every((l) => l.amount !== null);
  const total = priced ? lines.reduce((n, l) => n + (l.amount ?? 0), 0) : null;
  return {
    currency: rates.currency,
    lines,
    total,
    perCall: total === null || usage.calls === 0 ? null : total / usage.calls,
  };
};

/**
 * Rates from the environment, because they are an operator's contract and not a constant.
 *
 * `LISTEN_RATES` is `provider=amount` pairs — `openai=0.36,deepgram=0.24` — so the shape
 * follows whichever providers a deployment actually runs rather than a list baked in here.
 * Anything unparseable is left out rather than guessed at, which surfaces as "no rate
 * configured" beside the units instead of as a wrong number.
 */
const rateFrom = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value >= 0 ? value : undefined;
};

const perProviderRates = (raw: string | undefined): ReadonlyMap<string, number> => {
  const rates = new Map<string, number>();
  if (raw === undefined) return rates;
  for (const pair of raw.split(",")) {
    const [name, amount] = pair.split("=");
    const value = rateFrom(amount);
    if (name !== undefined && name.trim() !== "" && value !== undefined) {
      rates.set(name.trim(), value);
    }
  }
  return rates;
};

export const readCostRates = (env: NodeJS.ProcessEnv): CostRates => ({
  // Named rather than assumed. A deployment billed in naira and one billed in dollars
  // produce identical-looking dashboards otherwise.
  currency: env["COST_CURRENCY"]?.trim() ?? "",
  telephonyPerMinute: rateFrom(env["COST_TELEPHONY_PER_MINUTE"]),
  listenPerMinute: perProviderRates(env["COST_LISTEN_PER_MINUTE"]),
  ttsPer1kCharacters: rateFrom(env["COST_TTS_PER_1K_CHARACTERS"]),
});
