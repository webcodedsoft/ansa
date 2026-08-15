import { z } from "zod";

/**
 * One HTTP tool, as the form collects it.
 *
 * The rules below are a deliberate second copy of `packages/tools/src/connector/config.ts`,
 * and that needs justifying because this codebase argues against second copies. The
 * difference is what each is for: the connector's copy is the *enforcement* and runs on the
 * way into the database, where a refusal is a 422 with a sentence about `http[3].speech`.
 * This copy exists so somebody typing into a box is told which box, before they submit.
 *
 * So: never a rule the connector does not have, and never a laxer one. If these disagree
 * the connector wins, the publish fails, and the operator sees the raw message — worse, but
 * still safe. A rule that existed only here would be the actual mistake.
 */

/** Same as the API's `TOOL_NAME`. The model refers to the tool by this. */
const TOOL_NAME = /^[a-z][a-z0-9_]{2,63}$/;
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const PLACEHOLDER = /\{([A-Za-z0-9_.[\]-]+)\}/g;

/**
 * Header names the vault owns, refused here for the reason the connector refuses them.
 *
 * A static `Authorization: Bearer …` would put the secret in the tool document, and
 * `GET /tools` returns that document to anyone who may read the configuration. Saying so at
 * the field is the difference between a person understanding why and a person retyping it
 * in a different case to see whether that works.
 */
const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
]);

export const RISK_TIERS = ["read", "write", "irreversible"] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type Method = (typeof METHODS)[number];

/** What the builder can express. Anything else keeps its hand-written JSON Schema. */
export const PARAM_TYPES = ["string", "number", "boolean"] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

export interface ParamDraft {
  readonly name: string;
  readonly type: ParamType;
  readonly description: string;
  readonly required: boolean;
}

export interface HeaderDraft {
  readonly name: string;
  readonly value: string;
}

export interface HttpToolDraft {
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly method: Method;
  readonly send: "query" | "body";
  readonly headers: readonly HeaderDraft[];
  readonly credentialRef: string;
  readonly params: readonly ParamDraft[];
  /** Kept verbatim when the builder cannot represent the stored schema. */
  readonly parametersJson: string;
  readonly useRawParameters: boolean;
  readonly riskTier: RiskTier;
  readonly speechTemplate: string;
  readonly speechFallback: string;
  readonly readback: string;
  readonly transferReason: string;
  readonly timeoutMs: string;
}

export const emptyDraft = (): HttpToolDraft => ({
  name: "",
  description: "",
  url: "",
  method: "GET",
  send: "query",
  headers: [],
  credentialRef: "",
  params: [],
  parametersJson: "",
  useRawParameters: false,
  riskTier: "read",
  speechTemplate: "",
  speechFallback: "",
  readback: "",
  transferReason: "",
  timeoutMs: "",
});

export const placeholdersIn = (text: string): readonly string[] => [
  ...new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? "")),
];

/** The host, or null when the URL is not one yet — the form is judged mid-typing. */
export const hostOf = (url: string): string | null => {
  try {
    return new URL(url.replace(PLACEHOLDER, "_")).hostname;
  } catch {
    return null;
  }
};

export const isPlaintext = (url: string): boolean => url.trim().toLowerCase().startsWith("http:");

/**
 * Path parameters, and the reason a placeholder outside the path is not one.
 *
 * A `{hole}` in the host would let an argument — chosen by the model, from words a caller
 * said — decide which server is called, while the egress allowlist still checked the host
 * that was configured. The connector refuses it; this reports it as a field error.
 */
export const pathParamsIn = (url: string): readonly string[] => {
  const names = placeholdersIn(url);
  if (names.length === 0) return [];
  const blanked = url.replace(PLACEHOLDER, "_");
  try {
    const { origin } = new URL(blanked);
    return blanked.indexOf("_") < origin.length ? [] : names;
  } catch {
    return [];
  }
};

export const placeholderOutsidePath = (url: string): boolean =>
  placeholdersIn(url).length > 0 && pathParamsIn(url).length === 0;

/** The JSON Schema the builder rows describe. */
export const schemaFromParams = (params: readonly ParamDraft[]): string => {
  const properties: Record<string, { type: string; description?: string }> = {};
  const required: string[] = [];
  for (const param of params) {
    if (param.name.trim() === "") continue;
    properties[param.name] = {
      type: param.type,
      ...(param.description.trim() === "" ? {} : { description: param.description.trim() }),
    };
    if (param.required) required.push(param.name);
  }
  return JSON.stringify(
    { type: "object", properties, ...(required.length > 0 ? { required } : {}) },
    null,
    2,
  );
};

/**
 * Rows from a stored schema, or null when the builder would lose something.
 *
 * Null is the important return. A schema with nested objects, enums or `oneOf` came from
 * somebody who meant it, and showing it as three simplified rows would silently rewrite it
 * on the next save. When this returns null the form shows the JSON instead and says why.
 */
export const paramsFromSchema = (json: string): readonly ParamDraft[] | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const known = new Set(["type", "properties", "required"]);
  if (Object.keys(record).some((key) => !known.has(key))) return null;
  if (record["type"] !== "object") return null;

  const properties = record["properties"];
  if (properties === undefined) return [];
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    return null;
  }

  const required = new Set(
    Array.isArray(record["required"])
      ? record["required"].filter((entry): entry is string => typeof entry === "string")
      : [],
  );

  const rows: ParamDraft[] = [];
  for (const [name, raw] of Object.entries(properties as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const field = raw as Record<string, unknown>;
    if (Object.keys(field).some((key) => key !== "type" && key !== "description")) return null;
    const type = field["type"];
    if (typeof type !== "string" || !PARAM_TYPES.includes(type as ParamType)) return null;
    const description = field["description"];
    if (description !== undefined && typeof description !== "string") return null;
    rows.push({
      name,
      type: type as ParamType,
      description: description ?? "",
      required: required.has(name),
    });
  }
  return rows;
};

export type Problems = Readonly<Record<string, string>>;

/**
 * Everything wrong with the draft, keyed by field.
 *
 * All of them rather than the first, because a form that reveals one problem per save makes
 * somebody submit five times to learn five things.
 */
export const problemsWith = (
  draft: HttpToolDraft,
  context: {
    readonly takenNames: readonly string[];
    readonly allowPlaintextHttp: boolean;
    readonly credentials: readonly string[];
  },
): Problems => {
  const out: Record<string, string> = {};

  if (!TOOL_NAME.test(draft.name)) {
    out["name"] =
      "Lowercase letters, numbers and underscores, starting with a letter. At least three characters.";
  } else if (context.takenNames.includes(draft.name)) {
    out["name"] = "Another tool already has this name.";
  }

  if (draft.description.trim() === "") {
    out["description"] =
      "The model picks the tool by this sentence. Without one it will not know when to use it.";
  }

  const host = hostOf(draft.url);
  if (draft.url.trim() === "") out["url"] = "Required.";
  else if (host === null) out["url"] = "That is not a URL.";
  else if (placeholderOutsidePath(draft.url)) {
    out["url"] =
      "A {placeholder} may only appear in the path. One in the host would let an argument choose which server is called.";
  } else if (isPlaintext(draft.url) && !context.allowPlaintextHttp) {
    out["url"] = "This is plain http. Turn on plaintext HTTP in the registry settings, or use https.";
  }

  if (draft.method === "GET" && draft.send === "body") {
    out["send"] = "A GET cannot carry a body.";
  }

  if (draft.credentialRef !== "" && !context.credentials.includes(draft.credentialRef)) {
    out["credentialRef"] = "No credential is stored under that name.";
  }

  draft.headers.forEach((header, index) => {
    if (header.name.trim() === "" && header.value.trim() === "") return;
    if (!HEADER_NAME.test(header.name)) out[`headers.${index}`] = "That is not a header name.";
    else if (RESERVED_HEADERS.has(header.name.toLowerCase())) {
      out[`headers.${index}`] =
        "Authentication belongs in the credential vault. A header here would store the secret in the configuration, where anyone who can read the tool list can read it.";
    } else if (/[\r\n]/.test(header.value)) {
      out[`headers.${index}`] = "A header value cannot contain a line break.";
    }
  });

  const paramNames = new Set<string>();
  if (draft.useRawParameters) {
    try {
      const parsed: unknown = JSON.parse(draft.parametersJson);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        out["parametersJson"] = "Must be a JSON object.";
      } else {
        const properties = (parsed as Record<string, unknown>)["properties"];
        if (typeof properties === "object" && properties !== null) {
          for (const key of Object.keys(properties as Record<string, unknown>)) paramNames.add(key);
        }
      }
    } catch {
      out["parametersJson"] = "That is not valid JSON.";
    }
  } else {
    draft.params.forEach((param, index) => {
      if (param.name.trim() === "") out[`params.${index}`] = "Name it, or remove the row.";
      else if (!PARAM_NAME.test(param.name)) {
        out[`params.${index}`] = "Letters, numbers and underscores only.";
      } else if (paramNames.has(param.name)) {
        out[`params.${index}`] = "Two parameters cannot share a name.";
      }
      paramNames.add(param.name);
    });
  }

  /* A path placeholder with no matching parameter is the quiet one. The tool saves, the
     model is never told to supply that argument, and every call fails inside the adapter
     with a missing path parameter — after the caller has already been made to wait. */
  for (const name of pathParamsIn(draft.url)) {
    if (!paramNames.has(name)) {
      out["url"] = `The path uses {${name}}, but no parameter is called ${name}.`;
    }
  }

  if (draft.riskTier === "irreversible") {
    if (draft.transferReason.trim() === "") {
      out["transferReason"] = "Say why the call is going to a person. The caller hears this.";
    }
  } else {
    if (draft.speechTemplate.trim() === "") {
      out["speechTemplate"] = "Required. Raw JSON is never spoken.";
    } else if (placeholdersIn(draft.speechTemplate).length === 0) {
      out["speechTemplate"] =
        "Add a {placeholder} from the response, or the agent says the same thing every time.";
    }
    if (draft.speechFallback.trim() === "") {
      out["speechFallback"] = "Required. This is what the caller hears when there is no record.";
    }
    if (draft.riskTier === "write") {
      if (draft.readback.trim() === "") {
        out["readback"] = "A write tool reads the values back before it fires.";
      } else if (placeholdersIn(draft.readback).length === 0) {
        out["readback"] =
          "Quote the caller's own values back with {placeholders}, or they cannot check them.";
      }
    }
  }

  if (draft.timeoutMs !== "" && !/^\d+$/.test(draft.timeoutMs)) {
    out["timeoutMs"] = "Whole milliseconds, or leave it blank.";
  }

  return out;
};

const headersRecord = (headers: readonly HeaderDraft[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const header of headers) {
    if (header.name.trim() === "") continue;
    out[header.name.trim()] = header.value;
  }
  return out;
};

/** The draft as the API takes it. Only reached once `problemsWith` is empty. */
export const toApiTool = (draft: HttpToolDraft): Record<string, unknown> => {
  const headers = headersRecord(draft.headers);
  const tierFields =
    draft.riskTier === "irreversible"
      ? { transferReason: draft.transferReason.trim() }
      : {
          speech: { template: draft.speechTemplate.trim(), fallback: draft.speechFallback.trim() },
          ...(draft.riskTier === "write" ? { readback: draft.readback.trim() } : {}),
        };

  return {
    name: draft.name,
    description: draft.description.trim(),
    parametersJson: draft.useRawParameters ? draft.parametersJson : schemaFromParams(draft.params),
    riskTier: draft.riskTier,
    url: draft.url.trim(),
    method: draft.method,
    send: draft.send,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(draft.credentialRef === "" ? {} : { credentialRef: draft.credentialRef }),
    ...(draft.timeoutMs === "" ? {} : { timeoutMs: Number(draft.timeoutMs) }),
    ...tierFields,
  };
};

export const draftFromApi = (tool: Record<string, unknown>): HttpToolDraft => {
  const speech = (tool["speech"] ?? {}) as Record<string, unknown>;
  const parametersJson = typeof tool["parametersJson"] === "string" ? tool["parametersJson"] : "{}";
  const rows = paramsFromSchema(parametersJson);
  const headers = (tool["headers"] ?? {}) as Record<string, string>;

  return {
    ...emptyDraft(),
    name: String(tool["name"] ?? ""),
    description: String(tool["description"] ?? ""),
    url: String(tool["url"] ?? ""),
    method: (tool["method"] as Method | undefined) ?? "GET",
    send: (tool["send"] as "query" | "body" | undefined) ?? "query",
    headers: Object.entries(headers).map(([name, value]) => ({ name, value: String(value) })),
    credentialRef: String(tool["credentialRef"] ?? ""),
    params: rows ?? [],
    parametersJson,
    // The escape hatch opens itself. A schema this builder cannot hold is shown as JSON
    // rather than flattened into rows that would overwrite it on the next save.
    useRawParameters: rows === null,
    riskTier: (tool["riskTier"] as RiskTier | undefined) ?? "read",
    speechTemplate: String(speech["template"] ?? ""),
    speechFallback: String(speech["fallback"] ?? ""),
    readback: String(tool["readback"] ?? ""),
    transferReason: String(tool["transferReason"] ?? ""),
    timeoutMs: tool["timeoutMs"] === undefined ? "" : String(tool["timeoutMs"]),
  };
};

export const httpToolBodySchema = z.object({
  expectedVersion: z.coerce.number().int(),
  /** The tool as JSON, already checked by `problemsWith` on the client. */
  tool: z.string(),
  /** The name being replaced, empty when adding. Lets a rename keep its place in the list. */
  replacing: z.string(),
});
