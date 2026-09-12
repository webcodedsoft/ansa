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
 * **It reads what people actually paste, not what the curl manual describes.** The command
 * arrives from Postman (bash, cmd or PowerShell export), from a browser's "Copy as cURL" (with
 * `$'…'` quoting and twenty headers the browser added on its own), from a README with `$ ` in
 * front and a code fence around it, from a Windows clipboard with `\r\n`, with `| jq .` on
 * the end, with `-sSL` and `-XPOST` run together, with `--header=` instead of `--header `.
 * Every one of those is the same request, and a person who pastes it should see the same
 * filled form. A shell would refuse half of them; this is not a shell.
 *
 * What it deliberately does not do:
 *
 * - **Credentials never survive.** An `Authorization` or `Cookie` header, a `-u user:pass`, a
 *   `--oauth2-bearer`, a `-b` cookie string — all dropped and reported, never copied into the
 *   draft. Pasting a command with a live key into a form that stores it is exactly how a key
 *   ends up inside a configuration document, and this platform has a vault for that: the
 *   header comes back as a `credentialRef` the person chooses. This is the one rule here that
 *   is not about convenience.
 * - **Browser noise is left behind.** `sec-ch-ua`, `user-agent`, `accept-language` and the
 *   rest of what a browser attaches to its own requests describe the browser, not the API.
 *   Sending them from a server is harmless and pointless, and a headers list twenty long
 *   hides the two that matter.
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
  "cookie",
  "x-api-key",
  "api-key",
  "apikey",
  "api_key",
  "x-api-token",
  "x-auth",
  "x-auth-token",
  "x-access-token",
  "x-access-key",
  "x-secret",
  "x-secret-key",
  "x-client-secret",
  "x-session-token",
  "x-refresh-token",
  "x-csrf-token",
  "x-xsrf-token",
  "token",
  "private-token",
  "ocp-apim-subscription-key",
  "x-amz-security-token",
  "x-goog-api-key",
  "x-rapidapi-key",
  "x-functions-key",
]);

/** What a browser attaches to describe itself. `sec-*` is matched by prefix below. */
const BROWSER_HEADERS: ReadonlySet<string> = new Set([
  "user-agent",
  "accept-encoding",
  "accept-language",
  "origin",
  "referer",
  "referrer",
  "pragma",
  "cache-control",
  "priority",
  "dnt",
  "connection",
  "host",
  "content-length",
  "upgrade-insecure-requests",
  "te",
]);

const isBrowserHeader = (name: string): boolean =>
  BROWSER_HEADERS.has(name) || name.startsWith("sec-");

// ---------------------------------------------------------------------------
// Tokenising
// ---------------------------------------------------------------------------

/**
 * What a `$'…'` string decodes a backslash sequence to. Chrome's "Copy as cURL" uses this
 * quoting for any body with a newline or a quote in it.
 */
const ANSI_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  t: "\t",
  r: "\r",
  "\\": "\\",
  "'": "'",
  '"': '"',
  a: "",
  b: "",
  e: "",
  f: "",
  v: "",
};

/**
 * Where a line continuation ends: the index of the newline that follows a continuation
 * character with nothing but spaces, tabs or a carriage return in between. Null when the
 * character is doing something else.
 *
 * "Before a newline" is read the way a person sees it, not the way a shell does: a command
 * copied out of Postman carries a trailing space between the backslash and the line break,
 * and a Windows clipboard carries a carriage return. Both are invisible in the box, and a
 * shell would choke on both. Here they used to yield a token of pure whitespace, which then
 * won the "last token is the URL" rule and emptied the URL field with no explanation.
 */
const continuationEnd = (command: string, from: number): number | null => {
  let at = from;
  while (at < command.length) {
    const character = command[at] ?? "";
    if (character === "\n") return at;
    if (character !== " " && character !== "\t" && character !== "\r") return null;
    at += 1;
  }
  return null;
};

type Quote = '"' | "'" | "ansi" | null;

/**
 * Split a command the way a shell would, minus the parts a curl command never needs.
 *
 * Three shells' worth of line continuation — bash's backslash, cmd's caret, PowerShell's
 * backtick — because Postman exports all three and a person does not always know which they
 * copied. Single quotes, double quotes and `$'…'`. An unquoted `|`, `;` or `&&` ends the
 * command: what follows is a pipe into `jq` or the next command, not part of this one. It
 * does not handle variable expansion or subshells: a command containing `$(...)` is not
 * something to guess at, and it survives as a literal token the caller reports.
 */
const tokenise = (command: string): readonly string[] => {
  const tokens: string[] = [];
  let current = "";
  let quote: Quote = null;
  let started = false;

  const push = (): void => {
    if (started) tokens.push(current);
    current = "";
    started = false;
  };

  for (let at = 0; at < command.length; at += 1) {
    const character = command[at] ?? "";
    const next = command[at + 1] ?? "";

    if (quote === null) {
      if (character === "$" && next === "'") {
        quote = "ansi";
        started = true;
        at += 1;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        // An empty pair of quotes is still an argument — `-d ''` means a body of nothing.
        started = true;
        continue;
      }
      if (character === "\\" || character === "^" || character === "`") {
        const lineBreak = continuationEnd(command, at + 1);
        if (lineBreak !== null) {
          at = lineBreak;
          continue;
        }
        if (character === "\\") {
          current += next;
          started = true;
          at += 1;
          continue;
        }
      }
      // The end of this command. `&` alone is not: an unquoted URL with `?a=1&b=2` is far
      // more often what somebody pasted than a backgrounded process.
      if (character === "|" || character === ";" || (character === "&" && next === "&")) {
        push();
        break;
      }
      if (/\s/.test(character)) {
        push();
        continue;
      }
      current += character;
      started = true;
      continue;
    }

    if (quote === "ansi") {
      if (character === "'") {
        quote = null;
        continue;
      }
      if (character === "\\") {
        if (next === "x") {
          const hex = command.slice(at + 2, at + 4);
          if (/^[0-9a-fA-F]{2}$/.test(hex)) {
            current += String.fromCharCode(Number.parseInt(hex, 16));
            at += 3;
            continue;
          }
        }
        const decoded = ANSI_ESCAPES[next];
        current += decoded ?? next;
        at += 1;
        continue;
      }
      current += character;
      continue;
    }

    if (character === quote) {
      quote = null;
      continue;
    }
    if (quote === '"' && character === "\\") {
      // Inside double quotes a backslash escapes only these; anything else stays literal.
      if (next === "\n") {
        at += 1;
        continue;
      }
      if (next === '"' || next === "\\" || next === "$" || next === "`") {
        current += next;
        at += 1;
        continue;
      }
    }
    current += character;
  }
  push();
  return tokens;
};

// ---------------------------------------------------------------------------
// Unwrapping what surrounds the command
// ---------------------------------------------------------------------------

/**
 * The command without the things a person copied along with it: a Markdown code fence, the
 * `$ ` or `> ` of the prompt it was shown behind, Windows line endings.
 */
const unwrap = (raw: string): string => {
  let text = raw.replace(/\r\n/g, "\n").trim();
  text = text.replace(/^```[\w-]*\n?/, "").replace(/\n?```$/, "");
  text = text.replace(/^(?:\$|>|PS [^>\n]*>)\s+/, "");
  return text.trim();
};

/** `curl`, `curl.exe`, `/usr/bin/curl`, `\curl` — all the same program. */
const isCurl = (token: string): boolean => /(^|[\\/])\\?curl(\.exe)?$/i.test(token);

/** What was pasted instead of curl, named so the message can say so. */
const notCurl = (token: string): string => {
  const lower = token.toLowerCase();
  if (/^(invoke-webrequest|invoke-restmethod|iwr|irm)$/.test(lower)) {
    return "a PowerShell command rather than curl — in Postman or the browser, choose the cURL export";
  }
  if (lower === "wget" || lower === "http" || lower === "https" || lower === "fetch") {
    return `a ${lower} command rather than curl`;
  }
  return "anything from it — it does not look like a curl command";
};

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

/** Short flags that take a value, so `-XPOST` and `-H'Accept: x'` can be split. */
const SHORT_WITH_VALUE = "XHdubAoewFTEcmKrxUD";

/** Short flags that take none, so `-sSL` can be spread into three. */
const SHORT_ALONE = "sSLivkfgGIN46qZ";

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
  "-m",
  "-w",
  "--write-out",
  "--cacert",
  "--cert",
  "-E",
  "--key",
  "--resolve",
  "--retry",
  "--retry-delay",
  "--retry-max-time",
  "-c",
  "--cookie-jar",
  "--max-redirs",
  "--proto",
  "--proto-default",
  "--interface",
  "--dns-servers",
  "-K",
  "--config",
  "-r",
  "--range",
  "--limit-rate",
  "--stderr",
  "--trace",
  "--trace-ascii",
  "--dump-header",
  "-D",
  "--ciphers",
  "--tls-max",
]);

/** Flags taking no value and changing nothing this form expresses. Reporting them is noise. */
const IGNORED_ALONE: ReadonlySet<string> = new Set([
  "-s",
  "--silent",
  "-S",
  "--show-error",
  "-L",
  "--location",
  "--location-trusted",
  "-i",
  "--include",
  "-v",
  "--verbose",
  "-k",
  "--insecure",
  "-f",
  "--fail",
  "--fail-with-body",
  "-g",
  "--globoff",
  "--compressed",
  "-N",
  "--no-buffer",
  "-4",
  "-6",
  "-q",
  "--disable",
  "-Z",
  "--parallel",
  "--tlsv1",
  "--tlsv1.0",
  "--tlsv1.1",
  "--tlsv1.2",
  "--tlsv1.3",
  "--http1.0",
  "--http1.1",
  "--http2",
  "--http3",
  "--no-progress-meter",
  "--progress-bar",
  "--ssl-no-revoke",
  "--ssl",
  "--no-keepalive",
  "--basic",
  "--digest",
  "--ntlm",
  "--negotiate",
  "--anyauth",
]);

/** Credentials in flag form. The value is dropped whatever it is. */
const CREDENTIAL_FLAGS: ReadonlySet<string> = new Set([
  "-u",
  "--user",
  "-b",
  "--cookie",
  "--oauth2-bearer",
  "--proxy-user",
  "-U",
  "--aws-sigv4",
  "--netrc-file",
]);

const DATA_FLAGS: ReadonlySet<string> = new Set([
  "-d",
  "--data",
  "--data-raw",
  "--data-binary",
  "--data-ascii",
  "--data-urlencode",
]);

/**
 * A short-flag token as curl reads it: `-XPOST` is `-X POST`, `-sSL` is `-s -S -L`, and
 * `-sSXPOST` is `-s -S -X POST`. A run of letters that ends in a value-taking flag carries
 * the rest of the token as that flag's value.
 */
const spreadShort = (token: string): readonly string[] => {
  if (token.startsWith("--") || !/^-[^\s-]{2,}/.test(token)) return [token];
  const out: string[] = [];
  const letters = token.slice(1);
  for (let at = 0; at < letters.length; at += 1) {
    const letter = letters[at] ?? "";
    if (SHORT_WITH_VALUE.includes(letter)) {
      const rest = letters.slice(at + 1);
      out.push(`-${letter}`);
      if (rest !== "") out.push(rest);
      return out;
    }
    if (!SHORT_ALONE.includes(letter)) return [token];
    out.push(`-${letter}`);
  }
  return out;
};

/** `--header=Accept: x` is `--header 'Accept: x'`. Only long flags use `=`. */
const splitLongEquals = (token: string): readonly string[] => {
  if (!token.startsWith("--")) return [token];
  const equals = token.indexOf("=");
  if (equals < 0) return [token];
  return [token.slice(0, equals), token.slice(equals + 1)];
};

/**
 * `Name: value`, split on the first colon only — a value may contain colons. curl's own
 * `Name;` means "send this header empty", and `Name:` with nothing after is the same thing.
 */
const parseHeader = (raw: string): HeaderDraft | null => {
  const trimmed = raw.trim();
  if (/^[^:;\s]+;$/.test(trimmed)) return { name: trimmed.slice(0, -1), value: "" };
  const colon = trimmed.indexOf(":");
  if (colon <= 0) return null;
  return { name: trimmed.slice(0, colon).trim(), value: trimmed.slice(colon + 1).trim() };
};

const asMethod = (raw: string): Method | null => {
  const upper = raw.trim().toUpperCase();
  return METHODS.find((method) => method === upper) ?? null;
};

/**
 * Which of the bare tokens is the URL. The last one, matching curl — but a token that looks
 * like an address beats one that does not, so the value of a flag this parser did not
 * recognise cannot displace the URL that was already read.
 */
const pickUrl = (candidates: readonly string[]): string => {
  const trimmed = candidates.map((candidate) => candidate.trim()).filter((candidate) => candidate !== "");
  const withScheme = trimmed.filter((candidate) => /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate));
  if (withScheme.length > 0) return withScheme[withScheme.length - 1] ?? "";
  const hostLike = trimmed.filter((candidate) => /^[\w.-]+\.[a-z]{2,}(?:[:/?#]|$)/i.test(candidate));
  if (hostLike.length > 0) return hostLike[hostLike.length - 1] ?? "";
  return trimmed[trimmed.length - 1] ?? "";
};

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

export const parseCurl = (command: string): CurlImport => {
  const unsupported: string[] = [];
  const blank = (reason: string): CurlImport => ({ draft: emptyDraft(), unsupported: [reason] });

  const raw = tokenise(unwrap(command));
  // `sudo curl …` and `FOO=bar curl …` are still curl.
  let start = 0;
  while (start < raw.length && (raw[start] === "sudo" || raw[start] === "env" || /^\w+=/.test(raw[start] ?? ""))) {
    start += 1;
  }
  const program = raw[start];
  if (program === undefined) return blank("anything from it — the box was empty");
  if (!isCurl(program)) return blank(notCurl(program));

  const tokens = raw.slice(start + 1).flatMap(splitLongEquals).flatMap(spreadShort);

  const candidates: string[] = [];
  let method: Method | null = null;
  const bodyParts: string[] = [];
  let json = false;
  let dataInQuery = false;
  const headers: HeaderDraft[] = [];
  let droppedSecret = false;
  let browserHeaders = 0;
  let multipart = false;
  let bodyFromFile = false;

  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at] ?? "";
    const next = (): string => {
      at += 1;
      return tokens[at] ?? "";
    };

    if (token === "-X" || token === "--request") {
      const wanted = next();
      const named = asMethod(wanted);
      if (named === null) unsupported.push(`the ${wanted.toUpperCase()} method, which this form does not offer`);
      else method = named;
      continue;
    }

    if (token === "-I" || token === "--head") {
      unsupported.push("a HEAD request, which this form does not offer");
      continue;
    }

    if (token === "-H" || token === "--header") {
      const header = parseHeader(next());
      if (header === null) continue;
      const name = header.name.toLowerCase();
      if (SECRET_HEADERS.has(name)) {
        droppedSecret = true;
        continue;
      }
      if (isBrowserHeader(name)) {
        browserHeaders += 1;
        continue;
      }
      headers.push(header);
      continue;
    }

    if (CREDENTIAL_FLAGS.has(token)) {
      next();
      droppedSecret = true;
      continue;
    }

    if (DATA_FLAGS.has(token)) {
      const part = next();
      if (part.startsWith("@")) bodyFromFile = true;
      bodyParts.push(part);
      continue;
    }

    if (token === "--json") {
      bodyParts.push(next());
      json = true;
      continue;
    }

    if (token === "-G" || token === "--get") {
      dataInQuery = true;
      continue;
    }

    if (token === "-F" || token === "--form" || token === "--form-string") {
      next();
      multipart = true;
      continue;
    }

    if (token === "-T" || token === "--upload-file") {
      next();
      unsupported.push("an upload (-T), which this tool cannot send");
      continue;
    }

    if (token === "--url") {
      candidates.push(next());
      continue;
    }

    if (IGNORED_WITH_VALUE.has(token)) {
      next();
      continue;
    }

    if (IGNORED_ALONE.has(token)) continue;

    if (token.startsWith("-") && token.length > 1) {
      unsupported.push(`the flag ${token}`);
      continue;
    }

    // Anything left that is not a flag is a URL candidate.
    candidates.push(token);
  }

  let url = pickUrl(candidates);
  let body: string | null = bodyParts.length === 0 ? null : bodyParts.join("&");

  /* `-G` moves the data into the query string, which is what curl does with it; a form left
     on "body" would send a GET with a body nobody reads. */
  if (dataInQuery && body !== null) {
    if (url !== "" && body !== "") url = `${url}${url.includes("?") ? "&" : "?"}${body}`;
    body = null;
  }

  if (json) {
    const has = (name: string): boolean => headers.some((header) => header.name.toLowerCase() === name);
    if (!has("content-type")) headers.push({ name: "Content-Type", value: "application/json" });
    if (!has("accept")) headers.push({ name: "Accept", value: "application/json" });
  }

  if (droppedSecret) {
    unsupported.push(
      "the credentials it carried — add them as a stored credential instead, so they are sealed rather than saved inside this tool",
    );
  }
  if (browserHeaders > 0) {
    unsupported.push(
      browserHeaders === 1
        ? "one header a browser adds on its own behalf, which an API does not need"
        : `${browserHeaders} headers a browser adds on its own behalf, which an API does not need`,
    );
  }
  if (multipart) unsupported.push("a multipart form field (-F), which this tool cannot send");
  if (bodyFromFile) unsupported.push("a body read from a file (@…); the tool builds its own from the arguments");
  if (url.includes("$(") || url.includes("`")) {
    unsupported.push("a shell substitution in the URL, which has been left exactly as written");
  } else if (/\$\{?\w+\}?/.test(url)) {
    unsupported.push("a shell variable in the URL, which has been left exactly as written — put the real address in");
  }
  if (url.includes("{{")) {
    unsupported.push("a Postman variable in the URL ({{…}}), which has been left as written — put the real address in");
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
