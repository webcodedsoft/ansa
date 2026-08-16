"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Pause, Play, Search } from "lucide-react";

import {
  Card,
  CONTROL,
  Notice,
  Stack,
  Tag,
  TextField,
  type Tone,
} from "@/components/ui";
import { cn } from "@/lib/cn";

import { loadVoiceCatalogue } from "../agents.actions";
import type { LiveConfiguration, VoiceChoice } from "../agents.service";

/**
 * How the agent sounds.
 *
 * Two things an organisation decides: which of the speech account's voices answers, and how
 * fast it reads. They sit together because a rate is meaningless without hearing it — the
 * slider changes the sample's playback so 0.85 is something you listen to rather than a
 * number you guess at.
 *
 * A read-only table of listening settings used to sit below, naming the transcriber, the
 * turn detector and the silence threshold with the environment variable each comes from.
 * It was removed: they are deployment-level, an operator cannot act on any of them from
 * here, and a panel whose every row says "not here" is furniture on the screen somebody
 * opens to change the voice. Nothing about those settings changed with it.
 *
 * The rule that shaped this page still holds: nothing here is a control over a value the API
 * has nowhere to put. The rate slider exists because migration 0035 gave it a column — until
 * then it was a sentence saying so, not a slider submitting into the void.
 *
 * The picker is the point of the rest. A voice id is the only configuration field with no
 * shape to check and no forgiving failure — `docs/ONBOARDING_RUNBOOK.md` records a wrong one
 * publishing happily and ending the first real call in silence. Choosing from a list of
 * voices the account actually holds makes that particular mistake unavailable.
 */

interface VoiceTabProps {
  readonly config: LiveConfiguration["config"];
  readonly errors: Readonly<Record<string, string>>;
  /** The id of the page's publish form, which the voice is part of. */
  readonly publishForm: string;
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

/**
 * The voice's own clip, played at the rate this agent is set to.
 *
 * `playbackRate` on the element, not a re-synthesis. ElevenLabs' `speed` changes how the
 * audio is generated and this only changes how it is played, so the two are close but not
 * the same thing — enough to judge "is 0.9 too slow to bear", not enough to judge the timbre.
 * The alternative was a synthesis endpoint, which puts the speech key and its per-character
 * bill behind a button anybody with `config:read` can hold down. The label under the player
 * says which one this is rather than letting somebody assume.
 */
/**
 * The shape of the picker, before the picker.
 *
 * Reading the speech account takes a second or two cold — two calls to ElevenLabs and a
 * plan lookup — and a single line of text for that long reads as a page that failed rather
 * than one that is working. The blocks mirror what replaces them, so nothing jumps when the
 * voices land and nobody loses their place.
 *
 * `aria-busy` with a live region because none of the above reaches a screen reader: a
 * shimmering rectangle is not an announcement, and "reading the speech account" is.
 */
const LoadingVoices = () => (
  <div aria-busy="true" aria-live="polite">
    <span className="sr-only">Reading the speech account.</span>

    <div className="rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)] p-3.5">
      <div className="flex items-center gap-2.5">
        <span className="min-w-0 flex-1">
          <Bar className="h-3.5 w-40" />
          <Bar className="mt-2 h-3 w-64" />
        </span>
        <Bar className="h-8 w-28 rounded-lg" />
      </div>
    </div>

    <div className="mt-3.5 flex gap-2">
      <Bar className="h-9 flex-1 rounded-lg" />
      <Bar className="h-9 w-36 rounded-lg" />
    </div>

    <div className="mt-2.5 overflow-hidden rounded-lg border border-[var(--hairline)]">
      {[0, 1, 2, 3, 4].map((row) => (
        <div
          key={row}
          className="flex items-center gap-3 border-b border-[var(--surface-line)] px-3 py-2.5 last:border-b-0"
        >
          <Bar className="size-4 rounded-full" />
          <span className="min-w-0 flex-1">
            <Bar className="h-3.5 w-44" />
            <Bar className="mt-1.5 h-3 w-56" />
          </span>
        </div>
      ))}
    </div>

    <p className="mt-2 text-xs text-[var(--ink-3)]">Reading the speech account&hellip;</p>
  </div>
);

/** One shimmering block. `motion-reduce` because a pulsing page is a real complaint. */
const Bar = ({ className }: { readonly className: string }) => (
  <span
    aria-hidden
    className={cn(
      "block animate-pulse rounded bg-[var(--hairline)] motion-reduce:animate-none",
      className,
    )}
  />
);

const Sample = ({
  url,
  name,
  rate,
}: {
  readonly url: string | null;
  readonly name: string;
  readonly rate: number;
}) => {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  // Applied on every change, not only at play: somebody dragging the rate while it plays
  // should hear the difference, which is the whole reason the two controls sit together.
  useEffect(() => {
    if (audio.current !== null) audio.current.playbackRate = rate;
  }, [rate]);

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
          else {
            element.playbackRate = rate;
            void element.play();
          }
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
      {/* A visible control rather than a background tint. The row was selectable and looked
          like a list item, so which voice was chosen read as "whichever is highlighted" —
          fine once you know, invisible the first time. */}
      <span
        aria-hidden
        className={cn(
          "mt-0.5 grid size-4 flex-none place-items-center rounded-full border",
          selected ? "border-[var(--accent)] bg-[var(--accent)]" : "border-[var(--hairline)]",
        )}
      >
        {selected && <span className="size-1.5 rounded-full bg-[var(--surface)]" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium">{voice.name}</span>
        <span className="mt-0.5 block truncate text-[12px] text-[var(--ink-3)]">
          {describe(voice).join(" · ") || "no labels"}
        </span>
      </span>
      {/* Every row in the picker is on the account, so a tag saying so on all of them is
          noise. What is worth marking is which one answers the phone. */}
      <span className="flex-none pt-0.5">
        {selected ? <Tag tone="ok">answering</Tag> : !pickable && <Tag tone={state.tone}>{state.tag}</Tag>}
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

  /**
   * The account's own voices, and only those.
   *
   * There was a switch for this and it was the wrong shape of question. Every other voice in
   * the catalogue has to be added inside ElevenLabs before it can be used, so offering them
   * here means offering a hundred rows that answer a click with instructions — and the
   * twenty-two real choices were scattered among them. A picker should contain things you
   * can pick.
   *
   * The rest are not hidden so much as moved: the line under the list says how many the
   * library holds and where to add them, which is the only thing anybody needed from
   * seeing them.
   */
  const held = useMemo(
    () => voices.filter((voice) => voice.availability === "usable"),
    [voices],
  );

  const accents = useMemo(() => {
    const found = new Set<string>();
    for (const voice of held) if (voice.labels.accent !== null) found.add(voice.labels.accent);
    return [...found].sort((left, right) => left.localeCompare(right, "en"));
  }, [held]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return held
      .filter(
        (voice) =>
          (accent === "all" || voice.labels.accent === accent) &&
          (needle === "" || haystack(voice).includes(needle)),
      )
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
  }, [held, query, accent]);

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
      </div>

      <div className="mt-2.5 max-h-80 overflow-y-auto rounded-lg border border-[var(--hairline)]">
        {held.length === 0 ? (
          /* Not "no match" — there is nothing to match against. An account with no voices is
             a different problem from a search with no hits, and saying so is the difference
             between somebody adjusting a filter and somebody going to add a voice. */
          <p className="px-3 py-6 text-center text-[12.5px] text-[var(--ink-3)]">
            This ElevenLabs account holds no voices yet. Add one there and it appears here.
          </p>
        ) : shown.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12.5px] text-[var(--ink-3)]">
            No voice on this account matches that.
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
        {shown.length === held.length
          ? `${held.length} voice${held.length === 1 ? "" : "s"} on this account.`
          : `${shown.length} of ${held.length} on this account.`}
        {voices.length > held.length && (
          <>
            {" "}
            The ElevenLabs library holds {voices.length - held.length} more — add one to the
            account there and it appears here.
          </>
        )}
      </p>
    </div>
  );
};

export const VoiceTab = ({ config, errors, publishForm }: VoiceTabProps) => {
  const [catalogue, setCatalogue] = useState<Catalogue>({ status: "loading" });
  /* Held here rather than inside the rate card so the sample can be played at it. Trying a
     rate you cannot hear is guessing, and 0.85 versus 1.0 is not a thing anybody knows the
     sound of from the number. */
  /* From the configuration, not from the agent row. 0037 moved the rate into the published
     document, and with a draft in play the agent row holds what is live while the document
     holds what is being edited — reading the row would show somebody the pace they had
     before they changed it. */
  const [rate, setRate] = useState(config.speakingRate ?? 1);
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

          {catalogue.status === "loading" && <LoadingVoices />}

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
                    <Sample url={selected.previewUrl} name={selected.name} rate={rate} />
                  )}
                </div>

                {/* Part of the publish, not a second save. The rate belongs to the voice it
                    describes: one button, one version, and "what did this call sound like"
                    answerable from it — which a `PATCH`-only rate never was. */}
                <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-[var(--surface-line)] pt-3">
                  <label className="text-[12.5px] text-[var(--ink-3)]" htmlFor="speaking-rate">
                    Speaking rate
                  </label>
                  <input
                    id="speaking-rate"
                    type="range"
                    min={0.7}
                    max={1.2}
                    step={0.05}
                    value={rate}
                    onChange={(event) => setRate(Number(event.target.value))}
                    className="h-9 w-48 accent-[var(--accent)]"
                  />
                  <span className="font-mono text-[13px] tabular-nums">{rate.toFixed(2)}&times;</span>
                  {/* Blank at 1.00: a slider cannot express "unset", and unset is the default
                      and the common case — it leaves a cloned voice at its speaker's own pace,
                      which pinning it to 1.0 would flatten. */}
                  <input
                    type="hidden"
                    form={publishForm}
                    name="speakingRate"
                    value={rate === 1 ? "" : String(rate)}
                  />
                  <span className="text-[12.5px] text-[var(--ink-3)]">
                    Play the sample to hear it. Slower is easier to follow on a poor line.
                  </span>
                </div>

                {/* No save button here on purpose. There is one endpoint and one
                    configuration document, so a button on this panel did not save the voice
                    — it published every tab, live, under a label that said "Save". Publish
                    in the header is the only thing that makes a change real. */}
                <p className="mt-3 text-[12.5px] text-[var(--ink-3)]">
                  The voice and the rate go live with everything else, when you publish.
                </p>

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

      {/* After the voice, because it is a property of how that voice reads rather than a
          thing you choose first. It was above and made the tab open on a text box. */}
    </Stack>
  );
};
