import type { NextConfig } from "next";

/**
 * The API base URL is read at request time from the environment, never baked in here and
 * never exposed to the browser. There is no `NEXT_PUBLIC_` anything in this app on purpose:
 * every call to Ansa happens on the server, so the browser has no use for the API's address
 * and no way to reach it directly. See `src/lib/api/server.ts`.
 */
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  /**
   * Development only, and it costs an afternoon to work out the first time.
   *
   * Next refuses to serve `/_next/static/**` to a host it does not recognise as its own.
   * The dev server answers on localhost, so opening the app at `127.0.0.1:3100` — the same
   * machine, a different name for it — silently blocks every JavaScript chunk. Pages still
   * render, because they are server-rendered, so it looks like a working app in which
   * nothing is clickable: no theme toggle, no command palette, no tabs, no Server Actions.
   * The only clue is a warning in the terminal.
   *
   * Listing both names makes either address work. It has no effect on a production build.
   */
  allowedDevOrigins: ["127.0.0.1", "localhost"],

  /**
   * Uploading a knowledge source sends the file through a Server Action, and the default cap
   * on one of those is 1MB — small enough that a forty-page PDF is refused by the framework
   * before any of our own code sees it, with an error naming no file and suggesting nothing.
   *
   * 10MB rather than the 8MB `MAX_UPLOAD_BYTES` the extractor enforces, so that the refusal an
   * operator reads is ours and says what to do about it. See
   * `src/features/agents/extract/index.ts`.
   */
  experimental: {
    serverActions: { bodySizeLimit: "10mb" },
  },

  // `typedRoutes` is deliberately off. It writes its route union into `.next/types` during a
  // build, so `pnpm typecheck` on a clean checkout fails until something has been built —
  // a typecheck that depends on a build is a typecheck that gets skipped.
};

export default config;
