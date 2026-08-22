import { emptyDraft, type HeaderDraft, type HttpToolDraft, type Method } from "./http-tool.schema";

/**
 * A curl command, turned into the form somebody would otherwise fill in by hand.
 *
 * Every organisation with an API has a curl command for it already — in a runbook, in a
 * vendor's docs, in the reply from whoever built the endpoint. Retyping it into eight boxes is
 * where the typos come from, and a wrong header is a tool that fails on a call rather than in
 * review.
 *
 * **It fills the form, it does not submit it.** The result is a draft the builder renders and a
 * person checks, which is what makes a lenient parser safe: the worst a misread flag can do is
 * put the wrong thing in a visible box. That is also why nothing here throws — a command it
 * cannot fully understand still yields the parts it could, and `unsupported` names the rest so
 * the screen can say what it ignored rather than pretending it understood.
 *
 * What it deliberately does not do:
 *
 * - **Credentials never survive.** An `Authorization` header or a `-u user:pass` is dropped and
 *   reported, not copied into the draft. Pasting a curl command with a live key into a form
 *   that stores it is exactly how a key ends up inside a configuration document, and this
 *   platform has a vault for that: the header comes back as a `credentialRef` the person
 *   chooses. This is the one rule here that is not about convenience.
 * - **No risk tier is guessed.** A `POST` is not necessarily a write and a `GET` is not
 *   necessarily safe, and the tier decides whether the agent reads a value back to a caller
 *   before acting. Wrong there is worse than absent, so it stays at the default and a person
 *   picks it.
 */

export interface CurlImport {
  readonly draft: HttpToolDraft;
  /** What was recognised and dropped, in words a person can act on. Empty when nothing was. */
  readonly unsupported: readonly string[];
}

const METHODS: readonly Method[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/**
 * Headers that carry a secret, matched on name alone.
 *
 * Deliberately by name rather than by inspecting the value: a token that happens not to look
 * like one is still a token, and the cost of dropping a harmless header is somebody re-adding
 * it. These are the names vendors actually use.
 */
const SECRET_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
  "x-access-token",
  "x-secret",
]);

/**
 * Split a command the way a shell would, minus the parts a curl command never needs.
 *
 * Handles single quotes, double quotes, backslash escapes and line continuations, because
 * every real command copied out of documentation is wrapped across lines with trailing
 * backslashes. It does not handle variable expansion or subshells: a command containing
 * `$(...)` is not something to guess at, and it survives as a literal token the caller reports.
 */
const tokenise = (command: string): readonly string[] => {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  const push = (): void => {
    if (started) tokens.push(current);
    current = "";
    started = false;
  };

  for (let at = 0; at < command.length; at += 1) {
    const character = command[at] ?? "";

    if (quote === null && (character === '"' || character === "'")) {
      quote = character;
      // An empty pair of quotes is still an argument — `-d ''` means a body of nothing.
      started = true;
      continue;
    }
    if (quote !== null && character === quote) {
      quote = null;
      continue;
    }
    if (character === "\\") {
      const next = command[at + 1] ?? "";
      // A backslash before a newline is a line continuation and disappears with it.
      if (next === "\n") {
        at += 1;
        continue;
      }
      if (quote !== "'") {
        current += next;
        started = true;
        at += 1;
        continue;
      }
    }
    if (quote === null && /\s/.test(character)) {
      push();
      continue;
    }
    current += character;
    started = true;
  }
  push();
  return tokens;
};

/** `Name: value`, split on the first colon only — a value may contain colons. */
const parseHeader = (raw: string): HeaderDraft | null => {
  const colon = raw.indexOf(":");
  if (colon <= 0) return null;
  return { name: raw.slice(0, colon).trim(), value: raw.slice(colon + 1).trim() };
};

const asMethod = (raw: string): Method | null => {
  const upper = raw.trim().toUpperCase();
  return METHODS.find((method) => method === upper) ?? null;
};

/** Flags taking a value this form does not use, listed so the value is not read as the URL. */
const IGNORED_WITH_VALUE: ReadonlySet<string> = new Set([
  "-o",
  "--output",
  "-A",
  "--user-agent",
  "-e",
  "--referer",
  "--connect-timeout",
  "--max-time",
  "-w",
  "--write-out",
  "--cacert",
  "--cert",
  "--key",
  "--resolve",
  "--retry",
]);

/** Flags taking no value and changing nothing this form expresses. Reporting them is noise. */
const IGNORED_ALONE: ReadonlySet<string> = new Set([
  "-s",
  "--silent",
  "-L",
  "--location",
  "-i",
  "--include",
  "-v",
  "--verbose",
  "-k",
  "--insecure",
  "-f",
  "--fail",
  "-g",
  "--globoff",
  "--compressed",
]);

export const parseCurl = (command: string): CurlImport => {
  const tokens = tokenise(command);
  const unsupported: string[] = [];

  let url = "";
  let method: Method | null = null;
  let body: string | null = null;
  const headers: HeaderDraft[] = [];
  let droppedSecret = false;

  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at] ?? "";
    const next = (): string => {
      at += 1;
      return tokens[at] ?? "";
    };

    if (token === "curl") continue;

    if (token === "-X" || token === "--request") {
      const named = asMethod(next());
      if (named === null) unsupported.push("a request method this form does not offer");
      else method = named;
      continue;
    }

    if (token === "-H" || token === "--header") {
      const header = parseHeader(next());
      if (header === null) continue;
      if (SECRET_HEADERS.has(header.name.toLowerCase())) {
        droppedSecret = true;
        continue;
      }
      headers.push(header);
      continue;
    }

    if (token === "-u" || token === "--user") {
      next();
      droppedSecret = true;
      continue;
    }

    if (
      token === "-d" ||
      token === "--data" ||
      token === "--data-raw" ||
      token === "--data-binary"
    ) {
      body = next();
      continue;
    }

    if (token === "--url") {
      url = next();
      continue;
    }

    if (IGNORED_WITH_VALUE.has(token)) {
      next();
      continue;
    }

    if (IGNORED_ALONE.has(token)) continue;

    if (token.startsWith("-")) {
      unsupported.push(`the flag ${token}`);
      continue;
    }

    // Anything left that is not a flag is the URL. The last one wins, matching curl.
    if (token !== "") url = token;
  }

  if (droppedSecret) {
    unsupported.push(
      "the credentials it carried — add them as a stored credential instead, so they are sealed rather than saved inside this tool",
    );
  }
  if (url.includes("$(") || url.includes("`")) {
    unsupported.push("a shell substitution in the URL, which has been left exactly as written");
  }

  /* A body means the arguments travel in one. Inferred rather than asked, because a command
     carrying `-d` and a form left on "query" is a tool that silently drops every argument. */
  const send = body === null ? "query" : "body";

  return {
    draft: {
      ...emptyDraft(),
      url,
      /* `-d` with no `-X` is a POST in curl. Copying that beats defaulting to GET and sending
         a body nobody reads. */
      method: method ?? (body === null ? "GET" : "POST"),
      send,
      headers,
    },
    unsupported,
  };
};
