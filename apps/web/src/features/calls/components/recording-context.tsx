"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * The one player on a call page, and the bubbles that seek into it.
 *
 * "Click any message to hear it" is a promise two components have to keep together: the
 * timeline knows where each line is on the media clock, the player owns the audio. This is
 * the seam between them — the player registers a `seek`, a bubble asks for one.
 *
 * The first seek before any audio exists is the interesting case. The recording is not
 * fetched until somebody asks, because asking is logged against their name (see
 * `CallRecording`). So a bubble clicked cold *is* that ask: the player mints the link,
 * loads the audio, and then jumps — one ticket, one log line, same as pressing play.
 */
interface Handlers {
  readonly seek: (ms: number) => void;
  readonly load: (thenMs: number) => void;
}

interface RecordingSeam {
  /** Jump to a moment. Loads the audio first if nothing has been fetched yet. */
  readonly seek: (offsetMs: number) => void;
  /** Whether audio is loaded — a bubble draws itself as playable once it is. */
  readonly ready: boolean;
  /** For the player: how to be found. */
  readonly register: (handlers: Handlers) => void;
  readonly setReady: (ready: boolean) => void;
}

const Seam = createContext<RecordingSeam | null>(null);

export const RecordingProvider = ({ children }: { readonly children: ReactNode }) => {
  const handlers = useRef<Handlers | null>(null);
  const [ready, setReady] = useState(false);

  const seek = useCallback(
    (offsetMs: number) => {
      const current = handlers.current;
      if (current === null) return;
      if (ready) current.seek(offsetMs);
      else current.load(offsetMs);
    },
    [ready],
  );

  const register = useCallback((next: Handlers) => {
    handlers.current = next;
  }, []);

  const value = useMemo<RecordingSeam>(
    () => ({ seek, ready, register, setReady }),
    [seek, ready, register],
  );
  return <Seam.Provider value={value}>{children}</Seam.Provider>;
};

export const useRecording = (): RecordingSeam | null => useContext(Seam);

/**
 * A bubble that can be heard.
 *
 * Keyboard-reachable and announced, because a bubble that only answers a mouse is a
 * promise kept for some readers. Rendered as a plain wrapper when there is no player on the
 * page — the same markup, without the promise.
 */
export const HearAt = ({
  offsetMs,
  className,
  children,
}: {
  readonly offsetMs: number;
  readonly className?: string;
  readonly children: ReactNode;
}) => {
  const seam = useRecording();
  if (seam === null) return <div className={className}>{children}</div>;
  return (
    <div
      role="button"
      tabIndex={0}
      title="Hear this"
      onClick={() => seam.seek(offsetMs)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          seam.seek(offsetMs);
        }
      }}
      className={cn("cursor-pointer transition-[filter] hover:brightness-110", className)}
    >
      {children}
    </div>
  );
};
