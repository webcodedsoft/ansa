"use client";

import { Loader2, Pause, Play } from "lucide-react";
import { startTransition, useActionState, useEffect, useMemo, useRef, useState } from "react";

import { Notice } from "@/components/ui";
import { cn } from "@/lib/cn";
import { idleForm } from "@/lib/form-state";

import { fetchRecording, type RecordingState } from "../calls.actions";
import { useRecording } from "./recording-context";

const START: RecordingState = idleForm();

/** How many bars the strip has. Enough to read as a waveform, few enough to draw per frame. */
const BARS = 96;

/** A span of somebody speaking, on the media clock. What the strip is drawn from before audio. */
export interface SpeechSpan {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * The call, heard.
 *
 * **Nothing is requested until somebody asks.** The API writes a row to the organisation's
 * audio access log for every link it mints, and that log is what answers "who has heard my
 * call" — filling it with everyone who merely opened the page would make it useless for the
 * one question it exists to answer. So pressing play, or clicking a bubble, is the act being
 * recorded, and it is the first moment any audio leaves the server.
 *
 * The link works once. It is fetched exactly once, into memory: the bytes become the
 * `<audio>` source *and* the waveform, so a second ticket is never needed for either. Before
 * that fetch the strip is not invented — it is drawn from the call's own turns, who was
 * speaking when, which is what a waveform of a phone call mostly shows anyway. After it, the
 * bars are the real amplitude.
 *
 * A call with no audio is the common case rather than an error. Most calls happened when the
 * organisation was not recording, and every recording eventually passes its retention window;
 * the message says which, instead of showing a player that does nothing.
 */
export const CallRecording = ({
  callId,
  durationSeconds,
  speech,
}: {
  readonly callId: string;
  readonly durationSeconds: number | null;
  readonly speech: readonly SpeechSpan[];
}) => {
  const [state, action, pending] = useActionState(fetchRecording, START);
  const link = state.status === "succeeded" ? state.data : null;
  const seam = useRecording();

  const audio = useRef<HTMLAudioElement | null>(null);
  const pendingSeekMs = useRef<number | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [amplitude, setAmplitude] = useState<readonly number[] | null>(null);
  const [current, setCurrent] = useState(0);
  const [total, setTotal] = useState(durationSeconds ?? 0);
  const [playing, setPlaying] = useState(false);

  /* The bars before any audio: for each slice of the call, how much of it had somebody
     speaking. Derived from turns the record already holds, so it is true of this call
     rather than decorative. */
  const activity = useMemo<readonly number[]>(() => {
    const lengthMs = Math.max(1, (durationSeconds ?? 0) * 1000);
    const slice = lengthMs / BARS;
    return Array.from({ length: BARS }, (_, i) => {
      const from = i * slice;
      const to = from + slice;
      let covered = 0;
      for (const span of speech) {
        covered += Math.max(0, Math.min(to, span.endMs) - Math.max(from, span.startMs));
      }
      return Math.min(1, covered / slice);
    });
  }, [durationSeconds, speech]);

  const ask = (thenMs: number | null): void => {
    pendingSeekMs.current = thenMs;
    const form = new FormData();
    form.set("callId", callId);
    startTransition(() => action(form));
  };

  /* One fetch of the single-use link, into memory, feeding both the element and the strip. */
  useEffect(() => {
    if (link === null || src !== null) return;
    let cancelled = false;
    void (async () => {
      const response = await fetch(link.url);
      const bytes = await response.arrayBuffer();
      if (cancelled) return;
      setSrc(
        URL.createObjectURL(
          new Blob([bytes], { type: response.headers.get("content-type") ?? "audio/wav" }),
        ),
      );
      try {
        const context = new AudioContext();
        const decoded = await context.decodeAudioData(bytes.slice(0));
        await context.close();
        if (cancelled) return;
        /* Both legs are mixed for the picture: the strip is "was there sound", not "whose".
           The transcript beside it already says whose. */
        const channels = Array.from({ length: decoded.numberOfChannels }, (_, c) =>
          decoded.getChannelData(c),
        );
        const perBar = Math.max(1, Math.floor(decoded.length / BARS));
        const bars = Array.from({ length: BARS }, (_, i) => {
          let peak = 0;
          const from = i * perBar;
          const to = Math.min(decoded.length, from + perBar);
          for (const channel of channels) {
            for (let s = from; s < to; s += 4) {
              const v = Math.abs(channel[s] ?? 0);
              if (v > peak) peak = v;
            }
          }
          return peak;
        });
        const max = Math.max(0.05, ...bars);
        setAmplitude(bars.map((b) => b / max));
      } catch {
        // Undecodable in this browser: the activity strip stays, the audio still plays.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [link, src]);

  /* The player makes itself findable, and answers a seek asked for before it existed. */
  useEffect(() => {
    seam?.register({
      seek: (ms) => {
        const el = audio.current;
        if (el === null) return;
        el.currentTime = ms / 1000;
        void el.play();
      },
      load: (thenMs) => {
        if (link === null && !pending) ask(thenMs);
        else pendingSeekMs.current = thenMs;
      },
    });
    // `ask` closes over `action`, which useActionState keeps stable.
  }, [seam, link, pending]);

  useEffect(() => {
    if (src === null) return;
    seam?.setReady(true);
  }, [src, seam]);

  const bars = amplitude ?? activity;
  const fraction = total > 0 ? Math.min(1, current / total) : 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={pending}
          aria-label={playing ? "Pause" : "Play the recording"}
          onClick={() => {
            const el = audio.current;
            if (el === null || src === null) {
              ask(null);
              return;
            }
            if (playing) el.pause();
            else void el.play();
          }}
          className="grid size-9 flex-none place-items-center rounded-full bg-[var(--accent)] text-[var(--accent-on)] shadow-[var(--shadow-s)] transition-[transform,filter] hover:brightness-110 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-55"
        >
          {pending ? (
            <Loader2 aria-hidden className="size-4 animate-spin" />
          ) : playing ? (
            <Pause aria-hidden className="size-4 fill-current" />
          ) : (
            <Play aria-hidden className="ml-0.5 size-4 fill-current" />
          )}
        </button>

        {/* The strip. Clicking it seeks, once there is something to seek in. */}
        <div
          role={src === null ? undefined : "slider"}
          aria-label="Position in the recording"
          aria-valuemin={0}
          aria-valuemax={Math.round(total)}
          aria-valuenow={Math.round(current)}
          onClick={(event) => {
            const el = audio.current;
            if (el === null || src === null || total <= 0) return;
            const rect = event.currentTarget.getBoundingClientRect();
            el.currentTime = ((event.clientX - rect.left) / rect.width) * total;
          }}
          className={cn(
            "flex h-8 min-w-0 flex-1 items-center gap-px",
            src === null ? "" : "cursor-pointer",
          )}
        >
          {bars.map((height, i) => (
            <span
              key={i}
              aria-hidden
              className={cn(
                "min-h-[2px] flex-1 rounded-sm",
                i / BARS < fraction ? "bg-[var(--accent)]" : "bg-[var(--ink-3)]/35",
              )}
              style={{ height: `${Math.max(6, Math.round(height * 100))}%` }}
            />
          ))}
        </div>

        <span className="flex-none font-mono text-[11.5px] tabular-nums text-[var(--ink-3)]">
          {clock(current)} / {clock(total)}
        </span>
      </div>

      {src !== null && (
        <audio
          ref={audio}
          src={src}
          preload="auto"
          autoPlay
          onLoadedMetadata={(event) => {
            const el = event.currentTarget;
            if (Number.isFinite(el.duration)) setTotal(el.duration);
            const jump = pendingSeekMs.current;
            if (jump !== null) {
              pendingSeekMs.current = null;
              el.currentTime = jump / 1000;
            }
          }}
          onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          className="hidden"
        />
      )}

      {/* Nothing is said under the player until there is something to say: a failure, the
          fetch in progress, or which voices the audio holds. The access-log disclosure lives
          in the audit log itself, where the person it protects can read it. */}
      {state.status === "failed" ? (
        <Notice tone="warn">{state.message}</Notice>
      ) : link !== null ? (
        <p className="m-0 text-[11.5px] text-[var(--ink-3)]">
          {link.bothLegs
            ? "Both voices: the caller on the left channel, the agent on the right."
            : "The caller only — this call was recorded before the agent's own audio was captured."}
        </p>
      ) : null}
    </div>
  );
};

/** Seconds as `m:ss`, for a player's clock — where clock notation is the right notation. */
const clock = (seconds: number): string => {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};
