"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Pause, Play, Search } from "lucide-react";

import { Card, CONTROL, Notice, Stack, Tag, Td, TextField, type Tone } from "@/components/ui";
import { cn } from "@/lib/cn";

import { loadVoiceCatalogue } from "../agents.actions";
import type { LiveConfiguration, VoiceChoice } from "../agents.service";

/**
 * How the agent sounds, and what it does with what it hears.
 *
 * Two sections, and the split is not cosmetic — it is the line between what an organisation
 * decides and what the deployment decides. **Voice** is theirs: which of the speech
 * account's voices answers the phone. **Listening** is not, and every row in it is
 * read-only for a reason written beside it.
 *
 * That second half used to be a single warning paragraph. It is a table now because "you
 * cannot set this here" is only half an answer; the other half is where it *is* set, and
 * without it the next step is a support ticket. What has not changed is the rule behind it:
 * nothing on this page is a control over a value the API has nowhere to put. A speaking-rate
 * slider that submitted into the void would demonstrate a feature that does not survive a
 * call, which is the one thing this console will not do.
 *
 * The picker is the point of the rest. A voice id is the only configuration field with no
 * shape to check and no forgiving failure — `docs/ONBOARDING_RUNBOOK.md` records a wrong one
 * publishing happily and ending the first real call in silence. Choosing from a list of
 * voices the account actually holds makes that particular mistake unavailable.
 */

interface VoiceTabProps {
  readonly config: LiveConfiguration["config"];
  readonly errors: Readonly<Record<string, string>>;
}

type Catalogue =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly voices: readonly VoiceChoice[];
      readonly libraryUnread: boolean;
    }
  | { readonly status: "unavailable"; readonly message: string };

type Availability = VoiceChoice["availability"];

/**
 * What each state means to the person choosing, rather than what it means to the vendor.
 *
 * Only `usable` is selectable, and that is the whole point of showing the other two: an
 * operator who can see the Nigerian voices sitting in the library knows what to go and add,
 * and cannot accidentally save one that would synthesise nothing tonight.
 */
const AVAILABILITY: Readonly<
  Record<Availability, { readonly tone: Tone; readonly tag: string; readonly why: string }>
> = {
  usable: {
    tone: "ok",
    tag: "on this account",
    why: "Ready to speak on the next call.",
  },
  addable: {
    tone: "warn",
    tag: "add it first",
    why: "In the public library. Add it to the ElevenLabs account and it becomes selectable here.",
  },
  "beyond-plan": {
    tone: "bad",
    tag: "not on this plan",
    why: "In the public library, and this ElevenLabs plan may not add it.",
  },
};

/** The vendor writes labels as `middle_aged` and `narrative_story`. Nobody reads those. */
const readable = (value: string): string => value.replace(/_/g, " ");

const LABEL_ORDER = ["accent", "gender", "age", "useCase"] as const;

const describe = (voice: VoiceChoice): readonly string[] =>
  LABEL_ORDER.map((key) => voice.labels[key])
    .filter((value): value is string => value !== null)
    .map(readable);

/** Everything a search box should match: the name, the labels, and the publisher's blurb. */
const haystack = (voice: VoiceChoice): string =>
  [voice.name, voice.description ?? "", ...describe(voice)].join(" ").toLowerCase();

const SAMPLE_FALLBACK = "Good afternoon, thank you for calling. How may I help you today?";

/** Set once for the deployment, in `apps/api/src/config/env.ts`, and not per agent. */
const LISTENING: readonly {
  readonly setting: string;
  readonly where: string;
  readonly why: string;
}[] = [
  {
    setting: "Transcriber",
    where: "LISTEN_WORDS",
    why: "Which provider turns the caller's audio into words. Chosen once against measured accuracy on Nigerian speech — see docs/STACK_DECISION.md.",
  },
  {
    setting: "Turn detection",
    where: "LISTEN_TURNS",
    why: "Which provider decides the caller has finished speaking. A separate choice from the transcriber on purpose: words and turn boundaries have different best providers.",
  },
  {
    setting: "Wait before answering",
    where: "VAD_SILENCE_MS · DEEPGRAM_EOT_TIMEOUT_MS",
    why: "How much silence counts as the end of a turn, in milliseconds. It trades interrupting the caller against sounding slow, and it is tuned against the line rather than against an agent.",
  },
  {
    setting: "Hold the line with speech",
    where: "always on",
    why: "Any gap over two seconds produces sound. This is guarantee R6.2, enforced in the holding-speech scheduler, and there is deliberately no switch for it — a silent line reads as a dropped call.",
  },
];

const Sample = ({ url, name }: { readonly url: string | null; readonly name: string }) => {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  // The clip belongs to whichever voice is selected, so switching voices mid-play has to
  // stop the old one — otherwise the button says "play" while the previous voice talks.
  useEffect(() => {
    audio.current?.pause();
    setPlaying(false);
  }, [url]);

  if (url === null) {
    return <span className="text-[12.5px] text-[var(--ink-3)]">No sample published for {name}.</span>;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          const element = audio.current;
          if (element === null) return;
          if (playing) element.pause();
          else void element.play();
        }}
        className="inline-flex h-8 flex-none items-center gap-1.5 rounded-lg border border-[var(--hairline)] bg-[var(--glass-hi)] px-3 text-[13px] font-medium shadow-[var(--spec)]"
      >
        {playing ? <Pause aria-hidden className="size-3.5" /> : <Play aria-hidden className="size-3.5" />}
        {playing ? "Stop sample" : "Play sample"}
      </button>
      <audio
        ref={audio}
        src={url}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
    </>
  );
};

const VoiceRow = ({
  voice,
  selected,
  onSelect,
}: {
  readonly voice: VoiceChoice;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) => {
  const state = AVAILABILITY[voice.availability];
  const pickable = voice.availability === "usable";

  return (
    <button
      type="button"
      disabled={!pickable}
      aria-pressed={selected}
      onClick={onSelect}
      title={state.why}
      className={cn(
        "flex w-full items-start gap-3 border-b border-[var(--surface-line)] px-3 py-2.5 text-left last:border-b-0",
        pickable ? "hover:bg-[var(--surface-2)]" : "cursor-not-allowed opacity-60",
        selected && "bg-[var(--accent-soft)]",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium">{voice.name}</span>
        <span className="mt-0.5 block truncate text-[12px] text-[var(--ink-3)]">
          {describe(voice).join(" · ") || "no labels"}
        </span>
      </span>
      <span className="flex-none pt-0.5">
        <Tag tone={state.tone}>{state.tag}</Tag>
      </span>
    </button>
  );
};

const Picker = ({
  voices,
  selectedId,
  onSelect,
}: {
  readonly voices: readonly VoiceChoice[];
  readonly selectedId: string;
  readonly onSelect: (voiceId: string) => void;
}) => {
  const [query, setQuery] = useState("");
  const [accent, setAccent] = useState("all");
  const [usableOnly, setUsableOnly] = useState(false);

  const accents = useMemo(() => {
    const found = new Set<string>();
    for (const voice of voices) if (voice.labels.accent !== null) found.add(voice.labels.accent);
    return [...found].sort((left, right) => left.localeCompare(right, "en"));
  }, [voices]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return voices.filter(
      (voice) =>
        (accent === "all" || voice.labels.accent === accent) &&
        (!usableOnly || voice.availability === "usable") &&
        (needle === "" || haystack(voice).includes(needle)),
    );
  }, [voices, query, accent, usableOnly]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="relative min-w-52 flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-[var(--ink-3)]"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name, accent or description"
            aria-label="Search voices"
            className={cn(CONTROL, "pl-8")}
          />
        </span>
        <select
          value={accent}
          onChange={(event) => setAccent(event.target.value)}
          aria-label="Filter by accent"
          className={cn(CONTROL, "h-9 w-auto py-0")}
        >
          <option value="all">Every accent</option>
          {accents.map((option) => (
            <option key={option} value={option}>
              {readable(option)}
            </option>
          ))}
        </select>
        <label className="flex flex-none cursor-pointer items-center gap-2 text-[12.5px]">
          <input
            type="checkbox"
            checked={usableOnly}
            onChange={(event) => setUsableOnly(event.target.checked)}
            className="size-4 rounded border-[var(--hairline)] accent-[var(--accent)]"
          />
          Only what this account holds
        </label>
      </div>

      <div className="mt-2.5 max-h-80 overflow-y-auto rounded-lg border border-[var(--hairline)]">
        {shown.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12.5px] text-[var(--ink-3)]">
            No voice matches that.
          </p>
        ) : (
          shown.map((voice) => (
            <VoiceRow
              key={voice.voiceId}
              voice={voice}
              selected={voice.voiceId === selectedId}
              onSelect={() => onSelect(voice.voiceId)}
            />
          ))
        )}
      </div>

      <p className="mt-2 text-xs text-[var(--ink-3)]">
        {shown.length} of {voices.length} shown. Only voices already on the account can be
        selected; the rest are there so you know what to add.
      </p>
    </div>
  );
};

export const VoiceTab = ({ config, errors }: VoiceTabProps) => {
  const [catalogue, setCatalogue] = useState<Catalogue>({ status: "loading" });
  const [voiceId, setVoiceId] = useState(config.voiceId ?? "");

  useEffect(() => {
    let live = true;
    void loadVoiceCatalogue().then((result) => {
      if (!live) return;
      setCatalogue(
        result.ok
          ? { status: "ready", voices: result.voices, libraryUnread: result.libraryUnread }
          : { status: "unavailable", message: result.message },
      );
    });
    return () => {
      live = false;
    };
  }, []);

  const selected =
    catalogue.status === "ready"
      ? (catalogue.voices.find((voice) => voice.voiceId === voiceId) ?? null)
      : null;

  const sample = config.greeting ?? SAMPLE_FALLBACK;

  return (
    <Stack>
      <Card
        title="Voice"
        description="Which of the speech account's voices answers the phone."
      >
        <Stack>
          {/* Rendered before the list arrives, not with it. The publish button lives in the
              header and works from any tab, so a publish during the second the catalogue
              takes to load would submit no `voiceId` at all — and `publishFormInput` reads a
              missing field as an empty one, which clears the voice. The field exists from the
              first paint holding what is already stored. */}
          {catalogue.status !== "unavailable" && (
            <input type="hidden" name="voiceId" value={voiceId} />
          )}

          {catalogue.status === "loading" && (
            <p className="text-[13px] text-[var(--ink-3)]">Reading the speech account…</p>
          )}

          {/* The picker is gone, so the field it filled in comes back. Losing the list must
              not mean losing the ability to fix a voice id during an incident — and the
              reason it is a plain field again is on screen rather than in a console log. */}
          {catalogue.status === "unavailable" && (
            <>
              <Notice tone="warn">
                The voice list could not be loaded, so this is the id on its own. {catalogue.message}
              </Notice>
              <TextField
                label="Voice"
                name="voiceId"
                defaultValue={config.voiceId ?? ""}
                maxLength={200}
                placeholder="Provider voice id"
                error={errors["voiceId"]}
                hint="Leave empty to use the platform default."
              />
            </>
          )}

          {catalogue.status === "ready" && (
            <>
              {catalogue.libraryUnread && (
                <Notice tone="warn">
                  The vendor&rsquo;s public library did not answer, so this is only what the
                  account already holds. Everything listed still works; what is missing is
                  everything you could add.
                </Notice>
              )}

              <div className="rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)] p-3.5">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] font-medium">
                      {selected?.name ?? (voiceId === "" ? "No voice chosen" : voiceId)}
                    </span>
                    <span className="mt-0.5 block text-[12.5px] text-[var(--ink-3)]">
                      {selected === null
                        ? voiceId === ""
                          ? "The platform's default voice answers until one is chosen here."
                          : "This id is not on the account. It will publish, and the first call will hear nothing."
                        : describe(selected).join(" · ") || "no labels"}
                    </span>
                  </span>
                  {selected !== null && (
                    <Sample url={selected.previewUrl} name={selected.name} />
                  )}
                </div>

                {/* A stored id the picker would refuse today. It cannot be reached through
                    this list, so it was typed before there was one — and it is the failure
                    the list exists to prevent, sitting in the field rather than ahead of it. */}
                {selected !== null && selected.availability !== "usable" && (
                  <p className="mt-2.5 text-[12.5px] text-[var(--bad)]">
                    {AVAILABILITY[selected.availability].why} Until then this agent answers in
                    silence.
                  </p>
                )}

                {/* The sample is the publisher's own recording, and saying so is not
                    pedantry: nothing on this page synthesises, and a button that implied
                    it had spoken this greeting would be the demonstration rather than the
                    thing. The greeting is here because it is what the voice will actually
                    say first, and reading it next to the clip is the closest honest
                    approximation the console can offer. Placing a test call is the real one. */}
                <p className="mt-3 border-t border-[var(--surface-line)] pt-3 text-[13px] leading-relaxed">
                  <span className="text-[var(--ink-3)]">First thing a caller hears · </span>
                  {sample}
                </p>
                <p className="mt-1 text-xs text-[var(--ink-3)]">
                  The sample plays the voice&rsquo;s own recording, not this line. Nothing here
                  synthesises — place a test call to hear the two together.
                </p>
              </div>

              <Picker voices={catalogue.voices} selectedId={voiceId} onSelect={setVoiceId} />

              {errors["voiceId"] !== undefined && (
                <p className="text-[12.5px] text-[var(--bad)]">{errors["voiceId"]}</p>
              )}
            </>
          )}
        </Stack>
      </Card>

      <Card
        title="Listening"
        description="How the agent hears a caller. Set for the deployment, not for this agent — the row says where."
      >
        <table className="w-full border-collapse text-sm">
          <tbody>
            {LISTENING.map((row) => (
              <tr key={row.setting}>
                <Td className="align-top whitespace-nowrap text-[var(--ink-3)]">{row.setting}</Td>
                <Td className="align-top">
                  <span className="font-mono text-[12.5px]">{row.where}</span>
                  <span className="mt-0.5 block max-w-[62ch] text-[12.5px] text-[var(--ink-3)]">
                    {row.why}
                  </span>
                </Td>
              </tr>
            ))}
            {/* Not a listening setting, but the same answer and the same reason for being
                written down: the prototype drew a slider, no column stores a rate, and a
                slider over nothing is worse than a sentence. */}
            <tr>
              <Td className="border-b-0 align-top whitespace-nowrap text-[var(--ink-3)]">
                Speaking rate
              </Td>
              <Td className="border-b-0 align-top">
                <span className="font-mono text-[12.5px]">not stored</span>
                <span className="mt-0.5 block max-w-[62ch] text-[12.5px] text-[var(--ink-3)]">
                  Nothing in the agent row or the published configuration carries a rate, so
                  each voice speaks at its own. Adding one is a migration and a change to the
                  synthesis request, not a control on this page.
                </span>
              </Td>
            </tr>
          </tbody>
        </table>
      </Card>
    </Stack>
  );
};
