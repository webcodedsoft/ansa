// Generated from openapi.json by `pnpm --filter @ansa/api openapi`. Do not edit.
//
// One file, no dependencies, fetch only. Every method throws `AnsaApiError` on a
// non-2xx response, carrying the RFC 9457 problem document the API returned.

export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly requestId?: string;
  readonly errors?: readonly { readonly path: string; readonly message: string }[];
}

export class AnsaApiError extends Error {
  constructor(readonly problem: Problem) {
    super(`${problem.title}${problem.detail === undefined ? "" : `: ${problem.detail}`}`);
    this.name = "AnsaApiError";
  }
}

export interface AnsaClientOptions {
  readonly baseUrl: string;
  /**
   * The session token. A function rather than a string so a client created once can
   * follow a sign-in and a sign-out without being rebuilt.
   */
  readonly token?: () => string | null;
  readonly fetch?: typeof fetch;
}

interface RequestInput {
  // Not every path parameter is a string: the configuration version endpoints take an
  // integer, and narrowing this to string made the generated file fail to compile at the
  // two call sites that pass one. encodeURIComponent accepts both, so widening is the fix.
  readonly path?: Readonly<Record<string, string | number>>;
  readonly query?: Readonly<Record<string, unknown>>;
  readonly body?: unknown;
}

const send = async <T>(
  options: AnsaClientOptions,
  method: string,
  path: string,
  input: RequestInput,
): Promise<T> => {
  const url = new URL(`${options.baseUrl.replace(/\/+$/, "")}${path}`);
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const token = options.token?.() ?? null;
  const response = await (options.fetch ?? fetch)(url, {
    method,
    headers: {
      accept: "application/json",
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });

  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => undefined);
  if (response.ok) return payload as T;

  throw new AnsaApiError(
    (payload as Problem | undefined) ?? {
      type: "urn:ansa:problem:error",
      title: "Request failed",
      status: response.status,
    },
  );
};

export const createAnsaClient = (options: AnsaClientOptions) => ({
  agents: {
    /**
     * List this organisation's agents, oldest first
     * Includes retired agents, because a call log that references one still needs its name. Filter on `deletedAt` when offering a choice.
     */
    list: () =>
      send<{
        readonly items: readonly ({
        readonly agentId: string;
        readonly name: string;
        readonly persona: string | null;
        readonly greeting: string | null;
        readonly instructions: string | null;
        readonly voiceId: string | null;
        readonly speakingRate: number | null;
        readonly dialledNumber: string | null;
        readonly configVersion: number;
        readonly enabledTools: readonly (string)[];
        readonly knowledgeSources: readonly (string)[];
        readonly bargeIn: boolean;
        readonly answeringMachineDetection: boolean;
        readonly capturedFields: readonly ({
        readonly key: string;
        readonly type: "name" | "reference" | "phone" | "email" | "address" | "date" | "time" | "amount" | "nin" | "bvn" | "otp" | "quantity" | "choice" | "text";
        readonly prompt: string;
        readonly capture: "speech" | "keypad" | "either";
        readonly confirm: "none" | "readback" | "spellback";
        readonly pattern: string;
        readonly attempts: number;
        readonly required: boolean;
        readonly options: readonly (string)[];
      })[];
        readonly deletedAt: string | null;
        readonly createdAt: string;
      })[];
      }>(options, "GET", `/api/v1/agents`, {}),

    /**
     * Add an agent to this organisation
     * Starts at version 1 with no tools selected — a new agent does not inherit permission to call the organisation's endpoints. `dialledNumber` is optional; an agent can be written and reviewed before it is given a line. Refuses with 409 if the number is not available to route.
     */
    create: (input: {
        readonly body: {
          readonly name: string;
          readonly persona?: string | null;
          readonly greeting?: string | null;
          readonly instructions?: string | null;
          readonly voiceId?: string | null;
          readonly dialledNumber?: string | null;
        };
      }) =>
      send<{
        readonly agentId: string;
        readonly name: string;
        readonly persona: string | null;
        readonly greeting: string | null;
        readonly instructions: string | null;
        readonly voiceId: string | null;
        readonly speakingRate: number | null;
        readonly dialledNumber: string | null;
        readonly configVersion: number;
        readonly enabledTools: readonly (string)[];
        readonly knowledgeSources: readonly (string)[];
        readonly bargeIn: boolean;
        readonly answeringMachineDetection: boolean;
        readonly capturedFields: readonly ({
        readonly key: string;
        readonly type: "name" | "reference" | "phone" | "email" | "address" | "date" | "time" | "amount" | "nin" | "bvn" | "otp" | "quantity" | "choice" | "text";
        readonly prompt: string;
        readonly capture: "speech" | "keypad" | "either";
        readonly confirm: "none" | "readback" | "spellback";
        readonly pattern: string;
        readonly attempts: number;
        readonly required: boolean;
        readonly options: readonly (string)[];
      })[];
        readonly deletedAt: string | null;
        readonly createdAt: string;
      }>(options, "POST", `/api/v1/agents`, input),

    /**
     * One agent
     */
    read: (input: {
        readonly path: {
          readonly agentId: string;
        };
      }) =>
      send<{
        readonly agentId: string;
        readonly name: string;
        readonly persona: string | null;
        readonly greeting: string | null;
        readonly instructions: string | null;
        readonly voiceId: string | null;
        readonly speakingRate: number | null;
        readonly dialledNumber: string | null;
        readonly configVersion: number;
        readonly enabledTools: readonly (string)[];
        readonly knowledgeSources: readonly (string)[];
        readonly bargeIn: boolean;
        readonly answeringMachineDetection: boolean;
        readonly capturedFields: readonly ({
        readonly key: string;
        readonly type: "name" | "reference" | "phone" | "email" | "address" | "date" | "time" | "amount" | "nin" | "bvn" | "otp" | "quantity" | "choice" | "text";
        readonly prompt: string;
        readonly capture: "speech" | "keypad" | "either";
        readonly confirm: "none" | "readback" | "spellback";
        readonly pattern: string;
        readonly attempts: number;
        readonly required: boolean;
        readonly options: readonly (string)[];
      })[];
        readonly deletedAt: string | null;
        readonly createdAt: string;
      }>(options, "GET", `/api/v1/agents/${encodeURIComponent(input.path.agentId)}`, input),

    /**
     * Rename an agent, or move which number reaches it
     * Only the fields present are written. Send `dialledNumber: null` to unroute the agent, or a number to move it. Refuses with 409 if that number is not available to route.
     */
    update: (input: {
        readonly path: {
          readonly agentId: string;
        };
        readonly body: {
          readonly name?: string;
          readonly persona?: string | null;
          readonly greeting?: string | null;
          readonly instructions?: string | null;
          readonly voiceId?: string | null;
          readonly dialledNumber?: string | null;
          readonly bargeIn?: boolean;
          readonly speakingRate?: number | null;
          readonly answeringMachineDetection?: boolean;
        };
      }) =>
      send<{
        readonly agentId: string;
        readonly name: string;
        readonly persona: string | null;
        readonly greeting: string | null;
        readonly instructions: string | null;
        readonly voiceId: string | null;
        readonly speakingRate: number | null;
        readonly dialledNumber: string | null;
        readonly configVersion: number;
        readonly enabledTools: readonly (string)[];
        readonly knowledgeSources: readonly (string)[];
        readonly bargeIn: boolean;
        readonly answeringMachineDetection: boolean;
        readonly capturedFields: readonly ({
        readonly key: string;
        readonly type: "name" | "reference" | "phone" | "email" | "address" | "date" | "time" | "amount" | "nin" | "bvn" | "otp" | "quantity" | "choice" | "text";
        readonly prompt: string;
        readonly capture: "speech" | "keypad" | "either";
        readonly confirm: "none" | "readback" | "spellback";
        readonly pattern: string;
        readonly attempts: number;
        readonly required: boolean;
        readonly options: readonly (string)[];
      })[];
        readonly deletedAt: string | null;
        readonly createdAt: string;
      }>(options, "PATCH", `/api/v1/agents/${encodeURIComponent(input.path.agentId)}`, input),

    /**
     * Retire an agent and release its number
     * Archived, not deleted: calls point at the agent that handled them for the life of the call log. The number is released in the same statement, because an archived agent does not answer and a number left attached would ring nobody and could not be reassigned.
     */
    archive: (input: {
        readonly path: {
          readonly agentId: string;
        };
      }) =>
      send<void>(options, "DELETE", `/api/v1/agents/${encodeURIComponent(input.path.agentId)}`, input),

    /**
     * Replace the form this agent conducts
     * Sent whole rather than patched: the order of the fields is the order the caller is asked, so a partial update would be a reorder protocol nobody asked for. The agent conducts this form on the next call it takes — the order here is the order it asks, and a field with a pattern is re-asked until the value matches or the attempts run out.
     */
    setFields: (input: {
        readonly path: {
          readonly agentId: string;
        };
        readonly body: {
          readonly fields: readonly ({
          readonly key: string;
          readonly type: "name" | "reference" | "phone" | "email" | "address" | "date" | "time" | "amount" | "nin" | "bvn" | "otp" | "quantity" | "choice" | "text";
          readonly prompt: string;
          readonly capture: "speech" | "keypad" | "either";
          readonly confirm: "none" | "readback" | "spellback";
          readonly pattern: string;
          readonly attempts: number;
          readonly required: boolean;
          readonly options: readonly (string)[];
        })[];
        };
      }) =>
      send<{
        readonly agentId: string;
        readonly name: string;
        readonly persona: string | null;
        readonly greeting: string | null;
        readonly instructions: string | null;
        readonly voiceId: string | null;
        readonly speakingRate: number | null;
        readonly dialledNumber: string | null;
        readonly configVersion: number;
        readonly enabledTools: readonly (string)[];
        readonly knowledgeSources: readonly (string)[];
        readonly bargeIn: boolean;
        readonly answeringMachineDetection: boolean;
        readonly capturedFields: readonly ({
        readonly key: string;
        readonly type: "name" | "reference" | "phone" | "email" | "address" | "date" | "time" | "amount" | "nin" | "bvn" | "otp" | "quantity" | "choice" | "text";
        readonly prompt: string;
        readonly capture: "speech" | "keypad" | "either";
        readonly confirm: "none" | "readback" | "spellback";
        readonly pattern: string;
        readonly attempts: number;
        readonly required: boolean;
        readonly options: readonly (string)[];
      })[];
        readonly deletedAt: string | null;
        readonly createdAt: string;
      }>(options, "PUT", `/api/v1/agents/${encodeURIComponent(input.path.agentId)}/fields`, input),

    /**
     * Replace which of the organisation's sources this agent may answer from
     * Sources belong to the organisation; this is one agent's slice, exactly as tools are. An empty list means the agent has no knowledge base at all — `search_knowledge_base` is then not registered and the model is never told it can look anything up, rather than being offered a search that can only come back empty.
     */
    setKnowledge: (input: {
        readonly path: {
          readonly agentId: string;
        };
        readonly body: {
          readonly sources: readonly (string)[];
        };
      }) =>
      send<{
        readonly agentId: string;
        readonly name: string;
        readonly persona: string | null;
        readonly greeting: string | null;
        readonly instructions: string | null;
        readonly voiceId: string | null;
        readonly speakingRate: number | null;
        readonly dialledNumber: string | null;
        readonly configVersion: number;
        readonly enabledTools: readonly (string)[];
        readonly knowledgeSources: readonly (string)[];
        readonly bargeIn: boolean;
        readonly answeringMachineDetection: boolean;
        readonly capturedFields: readonly ({
        readonly key: string;
        readonly type: "name" | "reference" | "phone" | "email" | "address" | "date" | "time" | "amount" | "nin" | "bvn" | "otp" | "quantity" | "choice" | "text";
        readonly prompt: string;
        readonly capture: "speech" | "keypad" | "either";
        readonly confirm: "none" | "readback" | "spellback";
        readonly pattern: string;
        readonly attempts: number;
        readonly required: boolean;
        readonly options: readonly (string)[];
      })[];
        readonly deletedAt: string | null;
        readonly createdAt: string;
      }>(options, "PUT", `/api/v1/agents/${encodeURIComponent(input.path.agentId)}/knowledge`, input),

    /**
     * Replace which shared tools this agent may call
     * The registry belongs to the organisation; this is one agent's slice of it. Sent whole rather than patched, so the selection on screen is the selection saved. An empty list means the agent reaches none of the organisation's tools — it keeps the platform's own, so it can still end a call and transfer to a human.
     */
    setTools: (input: {
        readonly path: {
          readonly agentId: string;
        };
        readonly body: {
          readonly tools: readonly (string)[];
        };
      }) =>
      send<{
        readonly agentId: string;
        readonly name: string;
        readonly persona: string | null;
        readonly greeting: string | null;
        readonly instructions: string | null;
        readonly voiceId: string | null;
        readonly speakingRate: number | null;
        readonly dialledNumber: string | null;
        readonly configVersion: number;
        readonly enabledTools: readonly (string)[];
        readonly knowledgeSources: readonly (string)[];
        readonly bargeIn: boolean;
        readonly answeringMachineDetection: boolean;
        readonly capturedFields: readonly ({
        readonly key: string;
        readonly type: "name" | "reference" | "phone" | "email" | "address" | "date" | "time" | "amount" | "nin" | "bvn" | "otp" | "quantity" | "choice" | "text";
        readonly prompt: string;
        readonly capture: "speech" | "keypad" | "either";
        readonly confirm: "none" | "readback" | "spellback";
        readonly pattern: string;
        readonly attempts: number;
        readonly required: boolean;
        readonly options: readonly (string)[];
      })[];
        readonly deletedAt: string | null;
        readonly createdAt: string;
      }>(options, "PUT", `/api/v1/agents/${encodeURIComponent(input.path.agentId)}/tools`, input),
  },

  auth: {
    /**
     * The signed-in user, their organisation, and what they may do in it
     */
    me: () =>
      send<{
        readonly user: {
        readonly id: string;
        readonly email: string;
        readonly displayName: string;
      };
        readonly organisation: {
        readonly id: string;
        readonly name: string;
      };
        readonly role: "owner" | "admin" | "member";
        readonly capabilities: readonly ("calls:read" | "calls:write" | "members:read" | "members:write" | "invitations:read" | "invitations:write" | "config:read" | "config:write")[];
      }>(options, "GET", `/api/v1/auth/me`, {}),

    /**
     * List the organisations an email and password can sign in to
     * Returns an empty list for a wrong password and for an address with no account, and takes the same time to do it.
     */
    organisations: (input: {
        readonly body: {
          readonly email: string;
          readonly password: string;
        };
      }) =>
      send<{
        readonly organisations: readonly ({
        readonly id: string;
        readonly name: string;
        readonly role: "owner" | "admin" | "member";
      })[];
      }>(options, "POST", `/api/v1/auth/organisations`, input),

    /**
     * Sign in to one organisation
     */
    signIn: (input: {
        readonly body: {
          readonly email: string;
          readonly password: string;
          readonly organisationId: string;
        };
      }) =>
      send<{
        readonly token: string;
        readonly expiresAt: string;
        readonly organisation: {
        readonly id: string;
        readonly name: string;
      };
        readonly role: "owner" | "admin" | "member";
      }>(options, "POST", `/api/v1/auth/sessions`, input),

    /**
     * Sign out, revoking the token that made this request
     * Idempotent. The session row is kept and marked revoked, so it stays in the audit trail.
     */
    signOut: () =>
      send<void>(options, "DELETE", `/api/v1/auth/sessions/current`, {}),

    /**
     * Create an organisation and an account to own it
     * The self-serve half of onboarding, for somebody arriving without an invitation. An address that already has an account may create a further organisation using the password it already has, and a wrong one is refused with the same 401 as a failed sign-in. Answers with a session, so there is no second step.
     */
    signUp: (input: {
        readonly body: {
          readonly organisationName: string;
          readonly displayName: string;
          readonly email: string;
          readonly password: string;
        };
      }) =>
      send<{
        readonly token: string;
        readonly expiresAt: string;
        readonly organisation: {
        readonly id: string;
        readonly name: string;
      };
        readonly role: "owner" | "admin" | "member";
        readonly createdUser: boolean;
      }>(options, "POST", `/api/v1/auth/sign-ups`, input),
  },

  calls: {
    /**
     * List this organisation's calls, newest first
     * Filters combine with AND. `from` is inclusive and `to` exclusive, so two consecutive ranges do not both contain a call on the boundary. `reviewed` selects calls where somebody has ruled on at least one transcript.
     */
    list: (input: {
        readonly query?: {
          readonly page?: number;
          readonly perPage?: number;
          readonly from?: string;
          readonly to?: string;
          readonly endReason?: string;
          readonly agentId?: string;
          readonly caller?: string;
          readonly dialled?: string;
          readonly minDurationSeconds?: number;
          readonly reviewed?: boolean;
        };
      }) =>
      send<{
        readonly items: readonly ({
        readonly id: string;
        readonly direction: string;
        readonly dialled: string;
        readonly caller: string | null;
        readonly answeredAt: string | null;
        readonly endedAt: string | null;
        readonly endReason: string | null;
        readonly durationSeconds: number | null;
        readonly createdAt: string;
        readonly responseP50Ms: number | null;
      })[];
        readonly page: number;
        readonly perPage: number;
        readonly total: number;
        readonly totalPages: number;
      }>(options, "GET", `/api/v1/calls`, input),

    /**
     * One call, turn by turn
     * Turns with their barge-in offsets, final transcripts with confidence and the provider that produced them, the event timeline ordered by offset, and the configuration version that served the call. There is no audio; see the API README.
     */
    detail: (input: {
        readonly path: {
          readonly callId: string;
        };
      }) =>
      send<{
        readonly id: string;
        readonly carrierCallId: string;
        readonly direction: string;
        readonly dialled: string;
        readonly caller: string | null;
        readonly answeredAt: string | null;
        readonly endedAt: string | null;
        readonly endReason: string | null;
        readonly durationSeconds: number | null;
        readonly configVersion: number | null;
        readonly createdAt: string;
        readonly responseP50Ms: number | null;
        readonly turns: readonly ({
        readonly seq: number;
        readonly speaker: string;
        readonly startedOffsetMs: number;
        readonly endedOffsetMs: number | null;
        readonly bargedInAtMs: number | null;
      })[];
        readonly transcripts: readonly ({
        readonly id: string;
        readonly text: string;
        readonly correctedText: string | null;
        readonly correctedAt: string | null;
        readonly confidence: string | null;
        readonly offsetMs: number;
        readonly provider: string;
      })[];
        readonly events: readonly ({
        readonly kind: string;
        readonly offsetMs: number | null;
        readonly at: string;
        readonly detail: {
        readonly stage: string | null;
        readonly ms: number | null;
        readonly seq: number | null;
        readonly attempt: number | null;
        readonly reason: string | null;
        readonly subject: string | null;
        readonly outcome: string | null;
        readonly tool: string | null;
        readonly chars: number | null;
      };
      })[];
      }>(options, "GET", `/api/v1/calls/${encodeURIComponent(input.path.callId)}`, input),

    /**
     * Record a review verdict on one transcript
     * Submitting the transcriber's own words back is a verdict, not a no-op: it marks the transcript reviewed and correct. `changed` says which it was.
     */
    correct: (input: {
        readonly path: {
          readonly callId: string;
          readonly transcriptId: string;
        };
        readonly body: {
          readonly correctedText: string;
        };
      }) =>
      send<{
        readonly transcriptId: string;
        readonly callId: string;
        readonly text: string;
        readonly correctedText: string;
        readonly correctedAt: string;
        readonly changed: boolean;
      }>(options, "POST", `/api/v1/calls/${encodeURIComponent(input.path.callId)}/transcripts/${encodeURIComponent(input.path.transcriptId)}/corrections`, input),

    /**
     * Quality metrics over this organisation's recent calls
     * Computed over the last 200 calls, from the same event log and the same arithmetic the internal viewer uses. Rates are strings so their precision is not rounded away, and null where the denominator was zero — no calls yet and no transfers are different readings.
     */
    metrics: () =>
      send<{
        readonly calls: number;
        readonly callerTurns: number;
        readonly agentTurns: number;
        readonly reviewed: number;
        readonly sttExactMatch: string | null;
        readonly sttWordAccuracy: string | null;
        readonly correctionRate: string | null;
        readonly confirmationRate: string | null;
        readonly readbackRejectionRate: string | null;
        readonly captureCompletionRate: string | null;
        readonly bargeInRate: string | null;
        readonly responseLatencyMs: {
        readonly p50: number | null;
        readonly p95: number | null;
        readonly samples: number;
      };
        readonly transferRate: string | null;
        readonly abandonmentRate: string | null;
        readonly hallucinationsDiscarded: number;
        readonly recoveryLines: number;
        readonly recoveryRate: string | null;
        readonly toolCalls: number;
        readonly toolFailureRate: string | null;
      }>(options, "GET", `/api/v1/calls/metrics`, {}),

    /**
     * Calls worth reviewing first, worst rated highest
     * Scanned over the last 200 calls against the failure heuristics in R9.2.1: invented speech, escalations, repeated readbacks, low-confidence turns, interruption storms, recovery lines, dropped sentences, capture falling through to spelling or the keypad, dead air over two seconds, tool failures and calls where the caller never spoke. `severity` orders the list and means nothing else.
     */
    reviewQueue: (input: {
        readonly query?: {
          readonly minSeverity?: number;
          readonly reviewed?: boolean;
          readonly limit?: number;
        };
      }) =>
      send<{
        readonly scanned: number;
        readonly flagged: number;
        readonly calls: readonly ({
        readonly id: string;
        readonly carrierCallId: string;
        readonly createdAt: string;
        readonly endReason: string | null;
        readonly durationSeconds: number | null;
        readonly configVersion: number | null;
        readonly severity: number;
        readonly reviewed: number;
        readonly unreviewed: number;
        readonly signals: readonly ({
        readonly kind: string;
        readonly count: number;
        readonly weight: number;
        readonly why: string;
      })[];
      })[];
      }>(options, "GET", `/api/v1/calls/review-queue`, input),

    /**
     * Quality over recent calls, by configuration version
     * One row per `config_version` in the last 200 calls, newest version first, with the calls that recorded no version last. A version with few calls is included with its count rather than hidden, because a rollout that looks like it had no effect for an hour is worse than a small denominator.
     */
    trends: () =>
      send<{
        readonly versions: readonly ({
        readonly configVersion: number | null;
        readonly calls: number;
        readonly firstCallAt: string;
        readonly lastCallAt: string;
        readonly flaggedRate: string | null;
        readonly severityPerCall: string | null;
        readonly reviewed: number;
        readonly correctionRate: string | null;
        readonly sttWordAccuracy: string | null;
        readonly responseLatencyP50Ms: number | null;
        readonly transferRate: string | null;
      })[];
      }>(options, "GET", `/api/v1/calls/trends`, {}),
  },

  config: {
    /**
     * The configuration the agent is answering on right now
     * The live values, which are what calls run on, with the history row for them alongside and the vocabulary they resolve to. `operatorManaged` is read-only and has no counterpart in the publish body.
     */
    current: () =>
      send<{
        readonly version: number;
        readonly config: {
        readonly name: string;
        readonly voiceId: string | null;
        readonly greeting: string | null;
        readonly persona: string | null;
        readonly instructions: string | null;
        readonly keyterms: readonly (string)[];
        readonly businessHours: {
        readonly opensAtHour: number;
        readonly closesAtHour: number;
        readonly openDays: readonly (number)[];
      } | null;
        readonly escalation: {
        readonly toNumber: string;
        readonly fromNumber: string;
        readonly ringSeconds: number | null;
      } | null;
      };
        readonly published: {
        readonly version: number;
        readonly note: string | null;
        readonly publishedBy: string;
        readonly publishedAt: string;
      } | null;
        readonly vocabulary: {
        readonly base: readonly (string)[];
        readonly effective: readonly (string)[];
        readonly cap: number;
      };
        readonly operatorManaged: {
        readonly dialledNumber: string | null;
        readonly audioRetentionDays: number;
        readonly consent: {
        readonly policy: string;
        readonly basis: string | null;
        readonly callingEarliestHour: number | null;
        readonly callingLatestHour: number | null;
      };
      };
      }>(options, "GET", `/api/v1/config`, {}),

    /**
     * The configuration that served one call
     * R7.5 asked from the useful end: not 'what is version 4' but 'what was the agent working from when it said that'. Answers with the snapshot rather than the number.
     */
    forCall: (input: {
        readonly path: {
          readonly callId: string;
        };
      }) =>
      send<{
        readonly callId: string;
        readonly configVersion: number | null;
        readonly version: {
        readonly version: number;
        readonly note: string | null;
        readonly publishedBy: string;
        readonly publishedAt: string;
        readonly config: {
        readonly name: string;
        readonly voiceId: string | null;
        readonly greeting: string | null;
        readonly persona: string | null;
        readonly instructions: string | null;
        readonly keyterms: readonly (string)[];
        readonly businessHours: {
        readonly opensAtHour: number;
        readonly closesAtHour: number;
        readonly openDays: readonly (number)[];
      } | null;
        readonly escalation: {
        readonly toNumber: string;
        readonly fromNumber: string;
        readonly ringSeconds: number | null;
      } | null;
      };
      } | null;
      }>(options, "GET", `/api/v1/config/calls/${encodeURIComponent(input.path.callId)}`, input),

    /**
     * What changed between two configuration versions
     * Only the fields that moved, with the nested shapes flattened to dotted paths — `businessHours.closesAtHour` rather than two objects to compare by eye. Keyterms are compared as a set, without regard to case, because they are a bias on the transcriber rather than a sequence and reordering them changes nothing on a call. 404 if either version has no snapshot behind it.
     */
    diff: (input: {
        readonly query: {
          readonly from: number;
          readonly to: number;
        };
      }) =>
      send<{
        readonly from: {
        readonly version: number;
        readonly note: string | null;
        readonly publishedBy: string;
        readonly publishedAt: string;
      };
        readonly to: {
        readonly version: number;
        readonly note: string | null;
        readonly publishedBy: string;
        readonly publishedAt: string;
      };
        readonly identical: boolean;
        readonly fields: readonly ({
        readonly field: string;
        readonly before: string | null;
        readonly after: string | null;
      })[];
        readonly keyterms: {
        readonly added: readonly (string)[];
        readonly removed: readonly (string)[];
      };
      }>(options, "GET", `/api/v1/config/diff`, input),

    /**
     * What this organisation cannot configure, and where each rule is enforced
     * Generated from the list the platform actually enforces, so it cannot describe a rule that stopped being enforced. A publication tripping one of these is refused with 422 naming the id — and the rule would have held anyway, because none of them is held up by the prompt.
     */
    listGuarantees: () =>
      send<{
        readonly guarantees: readonly ({
        readonly id: string;
        readonly enforcedIn: string;
        readonly restatedToTheModel: boolean;
      })[];
      }>(options, "GET", `/api/v1/config/guarantees`, {}),

    /**
     * Every configuration version this organisation has published, newest first
     */
    listVersions: (input: {
        readonly query?: {
          readonly page?: number;
          readonly perPage?: number;
        };
      }) =>
      send<{
        readonly items: readonly ({
        readonly version: number;
        readonly note: string | null;
        readonly publishedBy: string;
        readonly publishedAt: string;
      })[];
        readonly page: number;
        readonly perPage: number;
        readonly total: number;
        readonly totalPages: number;
      }>(options, "GET", `/api/v1/config/versions`, input),

    /**
     * Publish a new configuration version
     * The whole configuration, not a patch: a field left out is a field cleared, so every one of them is required. Tool and event configuration is not settable here and is carried forward unchanged inside the same transaction. Bumps the version and snapshots it atomically, so the number recorded on every subsequent call has a row behind it.
     */
    publish: (input: {
        readonly body: {
          readonly name: string;
          readonly voiceId: string | null;
          readonly greeting: string | null;
          readonly persona: string | null;
          readonly instructions: string | null;
          readonly keyterms: readonly (string)[];
          readonly businessHours: {
          readonly opensAtHour: number;
          readonly closesAtHour: number;
          readonly openDays: readonly (number)[];
        } | null;
          readonly escalation: {
          readonly toNumber: string;
          readonly fromNumber: string;
          readonly ringSeconds: number | null;
        } | null;
          readonly note: string;
        };
      }) =>
      send<{
        readonly version: {
        readonly version: number;
        readonly note: string | null;
        readonly publishedBy: string;
        readonly publishedAt: string;
        readonly config: {
        readonly name: string;
        readonly voiceId: string | null;
        readonly greeting: string | null;
        readonly persona: string | null;
        readonly instructions: string | null;
        readonly keyterms: readonly (string)[];
        readonly businessHours: {
        readonly opensAtHour: number;
        readonly closesAtHour: number;
        readonly openDays: readonly (number)[];
      } | null;
        readonly escalation: {
        readonly toNumber: string;
        readonly fromNumber: string;
        readonly ringSeconds: number | null;
      } | null;
      };
      };
        readonly vocabulary: {
        readonly base: readonly (string)[];
        readonly effective: readonly (string)[];
        readonly cap: number;
      };
      }>(options, "POST", `/api/v1/config/versions`, input),

    /**
     * One configuration version, as it was published
     * Addressable, so the version a call recorded can be linked to rather than described.
     */
    version: (input: {
        readonly path: {
          readonly version: number;
        };
      }) =>
      send<{
        readonly version: number;
        readonly note: string | null;
        readonly publishedBy: string;
        readonly publishedAt: string;
        readonly config: {
        readonly name: string;
        readonly voiceId: string | null;
        readonly greeting: string | null;
        readonly persona: string | null;
        readonly instructions: string | null;
        readonly keyterms: readonly (string)[];
        readonly businessHours: {
        readonly opensAtHour: number;
        readonly closesAtHour: number;
        readonly openDays: readonly (number)[];
      } | null;
        readonly escalation: {
        readonly toNumber: string;
        readonly fromNumber: string;
        readonly ringSeconds: number | null;
      } | null;
      };
      }>(options, "GET", `/api/v1/config/versions/${encodeURIComponent(input.path.version)}`, input),

    /**
     * Publish an earlier version's configuration as a new version
     * Never rewrites history: the version being rolled back to stays exactly as it was and a new version number is issued, so a call that recorded an older one can still be explained. Runs the same guarantee and keyterm checks a publish does and answers 422 with the field named if the stored version would not be accepted today. Tool and event configuration is carried forward from the live document, not from the snapshot — the version table does not hold it.
     */
    rollback: (input: {
        readonly path: {
          readonly version: number;
        };
        readonly body: {
          readonly note?: string;
        };
      }) =>
      send<{
        readonly version: {
        readonly version: number;
        readonly note: string | null;
        readonly publishedBy: string;
        readonly publishedAt: string;
        readonly config: {
        readonly name: string;
        readonly voiceId: string | null;
        readonly greeting: string | null;
        readonly persona: string | null;
        readonly instructions: string | null;
        readonly keyterms: readonly (string)[];
        readonly businessHours: {
        readonly opensAtHour: number;
        readonly closesAtHour: number;
        readonly openDays: readonly (number)[];
      } | null;
        readonly escalation: {
        readonly toNumber: string;
        readonly fromNumber: string;
        readonly ringSeconds: number | null;
      } | null;
      };
      };
        readonly vocabulary: {
        readonly base: readonly (string)[];
        readonly effective: readonly (string)[];
        readonly cap: number;
      };
      }>(options, "POST", `/api/v1/config/versions/${encodeURIComponent(input.path.version)}/rollback`, input),
  },

  credentials: {
    /**
     * The credentials this organisation has stored, by name
     * Names, kinds and dates. No credential value is returned by this API in any form, including masked.
     */
    list: () =>
      send<{
        readonly items: readonly ({
        readonly ref: string;
        readonly kind: "auth" | "signing" | "unreadable";
        readonly inUse: boolean;
        readonly createdAt: string;
        readonly updatedAt: string;
      })[];
      }>(options, "GET", `/api/v1/credentials`, {}),

    /**
     * Store a credential under this name, or replace the one already there
     * Write-only. The value is sealed before it reaches the database and is not recoverable through this API — rotate rather than recover. Rotating takes effect on the next call; a call in progress keeps the credential it already resolved.
     */
    put: (input: {
        readonly path: {
          readonly ref: string;
        };
        readonly body: {
          readonly kind: "bearer" | "header" | "basic" | "signing";
          readonly token?: string;
          readonly header?: string;
          readonly value?: string;
          readonly username?: string;
          readonly password?: string;
          readonly secret?: string;
        };
      }) =>
      send<{
        readonly ref: string;
        readonly createdAt: string;
        readonly updatedAt: string;
      }>(options, "PUT", `/api/v1/credentials/${encodeURIComponent(input.path.ref)}`, input),

    /**
     * Remove a credential
     * Refused with 409 while the tool or event configuration still names it, because removing it would leave a tool that registers and then refuses every caller.
     */
    remove: (input: {
        readonly path: {
          readonly ref: string;
        };
      }) =>
      send<void>(options, "DELETE", `/api/v1/credentials/${encodeURIComponent(input.path.ref)}`, input),
  },

  eventSubscriptions: {
    /**
     * Where this organisation's calls are pushed
     * Each receiver carries the redaction rules that will actually apply to it, resolved from the organisation's default. A receiver that masks nothing reports no redaction, because nothing is masked unless it is asked for.
     */
    read: () =>
      send<{
        readonly configVersion: number;
        readonly egress: {
        readonly allowedHosts: readonly (string)[];
        readonly allowPlaintextHttp?: boolean;
      };
        readonly subscriptions: readonly ({
        readonly name: string;
        readonly url: string;
        readonly events: readonly ("call.ended" | "call.transferred")[];
        readonly signingSecretRef: string;
        readonly credentialRef?: string;
        readonly timeoutMs?: number;
        readonly maxAttempts?: number;
      })[];
      }>(options, "GET", `/api/v1/event-subscriptions`, {}),

    /**
     * Replace where this organisation's calls are pushed
     * Whole document, never a patch, and it publishes a new configuration version — which is what records the redaction rules a payload left under. Refused with 422 if a receiver names an unknown event, has no signing secret, sits outside egress.allowedHosts, or points at a credential this organisation has not stored or has stored as the other kind.
     */
    replace: (input: {
        readonly body: {
          readonly expectedVersion: number;
          readonly note?: string;
          readonly egress: {
          readonly allowedHosts: readonly (string)[];
          readonly allowPlaintextHttp?: boolean;
        };
          readonly subscriptions: readonly ({
          readonly name: string;
          readonly url: string;
          readonly events: readonly ("call.ended" | "call.transferred")[];
          readonly signingSecretRef: string;
          readonly credentialRef?: string;
          readonly timeoutMs?: number;
          readonly maxAttempts?: number;
        })[];
        };
      }) =>
      send<{
        readonly configVersion: number;
      }>(options, "PUT", `/api/v1/event-subscriptions`, input),
  },

  invitations: {
    /**
     * Invite someone to this organisation
     */
    invite: (input: {
        readonly body: {
          readonly email: string;
          readonly role: "owner" | "admin" | "member";
        };
      }) =>
      send<{
        readonly invitation: {
        readonly id: string;
        readonly email: string;
        readonly role: "owner" | "admin" | "member";
        readonly expiresAt: string;
        readonly acceptedAt: string | null;
        readonly revokedAt: string | null;
        readonly createdAt: string;
      };
        readonly token: string;
      }>(options, "POST", `/api/v1/invitations`, input),

    /**
     * List invitations, newest first, including spent and revoked ones
     */
    list: (input: {
        readonly query?: {
          readonly page?: number;
          readonly perPage?: number;
        };
      }) =>
      send<{
        readonly items: readonly ({
        readonly id: string;
        readonly email: string;
        readonly role: "owner" | "admin" | "member";
        readonly expiresAt: string;
        readonly acceptedAt: string | null;
        readonly revokedAt: string | null;
        readonly createdAt: string;
      })[];
        readonly page: number;
        readonly perPage: number;
        readonly total: number;
        readonly totalPages: number;
      }>(options, "GET", `/api/v1/invitations`, input),

    /**
     * Revoke an invitation that has not been redeemed
     */
    revoke: (input: {
        readonly path: {
          readonly id: string;
        };
      }) =>
      send<void>(options, "DELETE", `/api/v1/invitations/${encodeURIComponent(input.path.id)}`, input),

    /**
     * Redeem an invitation and join the organisation it names
     * Public: the token is the credential. The organisation comes from the invitation, never from the request.
     */
    accept: (input: {
        readonly body: {
          readonly token: string;
          readonly password: string;
          readonly displayName: string;
        };
      }) =>
      send<{
        readonly organisationId: string;
        readonly role: "owner" | "admin" | "member";
        readonly createdUser: boolean;
      }>(options, "POST", `/api/v1/invitations/accept`, input),
  },

  knowledge: {
    /**
     * What this organisation's agents can answer from
     * Every source the organisation holds, with how many pieces each carries and how often anything in it was retrieved on a call in the last seven days. Retired sources are absent: unlike an agent, a source that is gone has nothing pointing back at it that still needs its name.
     */
    list: () =>
      send<{
        readonly items: readonly ({
        readonly sourceId: string;
        readonly name: string;
        readonly kind: "faq" | "table" | "document";
        readonly unitCount: number;
        readonly retrievalsLast7Days: number;
        readonly createdAt: string;
        readonly updatedAt: string;
      })[];
      }>(options, "GET", `/api/v1/knowledge`, {}),

    /**
     * Store something the agent may answer from
     * Units are sent whole and are exactly what retrieval will return, so they are also what a caller will hear. Creating a source does not give it to any agent — that is `PUT /agents/{agentId}/knowledge`, so writing a FAQ cannot accidentally change what a live line says.
     */
    create: (input: {
        readonly body: {
          readonly name: string;
          readonly kind: "faq" | "table" | "document";
          readonly units: readonly ({
          readonly question?: string | null;
          readonly body: string;
        })[];
        };
      }) =>
      send<{
        readonly sourceId: string;
        readonly name: string;
        readonly kind: "faq" | "table" | "document";
        readonly unitCount: number;
        readonly retrievalsLast7Days: number;
        readonly createdAt: string;
        readonly updatedAt: string;
      }>(options, "POST", `/api/v1/knowledge`, input),

    /**
     * One source, with the pieces retrieval can return
     */
    read: (input: {
        readonly path: {
          readonly sourceId: string;
        };
      }) =>
      send<{
        readonly source: {
        readonly sourceId: string;
        readonly name: string;
        readonly kind: "faq" | "table" | "document";
        readonly unitCount: number;
        readonly retrievalsLast7Days: number;
        readonly createdAt: string;
        readonly updatedAt: string;
      };
        readonly units: readonly ({
        readonly unitId: string;
        readonly question: string | null;
        readonly body: string;
      })[];
      }>(options, "GET", `/api/v1/knowledge/${encodeURIComponent(input.path.sourceId)}`, input),

    /**
     * Retire a source
     * A soft delete. Retrieval stops immediately for every agent using it, and the retrieval history it accumulated stays readable — a call that quoted this source last week still has something to point at.
     */
    remove: (input: {
        readonly path: {
          readonly sourceId: string;
        };
      }) =>
      send<{
        readonly deleted: boolean;
      }>(options, "DELETE", `/api/v1/knowledge/${encodeURIComponent(input.path.sourceId)}`, input),

    /**
     * Replace what a source holds
     * Whole, not patched: the order of the units is their position, and a patch protocol over an ordered list is a reorder API nobody asked for. Every agent using this source sees the change on its next call — that is the point of a shared source, and the reason to know which agents use one before rewriting it.
     */
    replaceUnits: (input: {
        readonly path: {
          readonly sourceId: string;
        };
        readonly body: {
          readonly units: readonly ({
          readonly question?: string | null;
          readonly body: string;
        })[];
        };
      }) =>
      send<{
        readonly sourceId: string;
        readonly name: string;
        readonly kind: "faq" | "table" | "document";
        readonly unitCount: number;
        readonly retrievalsLast7Days: number;
        readonly createdAt: string;
        readonly updatedAt: string;
      }>(options, "PUT", `/api/v1/knowledge/${encodeURIComponent(input.path.sourceId)}/units`, input),
  },

  members: {
    /**
     * List the people in this organisation, newest first
     */
    list: (input: {
        readonly query?: {
          readonly page?: number;
          readonly perPage?: number;
        };
      }) =>
      send<{
        readonly items: readonly ({
        readonly userId: string;
        readonly email: string;
        readonly displayName: string;
        readonly role: "owner" | "admin" | "member";
        readonly createdAt: string;
      })[];
        readonly page: number;
        readonly perPage: number;
        readonly total: number;
        readonly totalPages: number;
      }>(options, "GET", `/api/v1/members`, input),

    /**
     * Change someone's role
     * Refuses with 409 if it would leave the organisation without an owner.
     */
    setRole: (input: {
        readonly path: {
          readonly userId: string;
        };
        readonly body: {
          readonly role: "owner" | "admin" | "member";
        };
      }) =>
      send<{
        readonly userId: string;
        readonly role: "owner" | "admin" | "member";
      }>(options, "PATCH", `/api/v1/members/${encodeURIComponent(input.path.userId)}`, input),

    /**
     * Remove someone from this organisation
     * Their account survives; only the membership goes. Refuses to remove the last owner.
     */
    remove: (input: {
        readonly path: {
          readonly userId: string;
        };
      }) =>
      send<void>(options, "DELETE", `/api/v1/members/${encodeURIComponent(input.path.userId)}`, input),
  },

  numbers: {
    /**
     * List the numbers attached to this organisation
     * At most one today: an inbound call is resolved by the number that was dialled, and one organisation holds one. Each entry carries the carrier's own record of where that number sends calls, which is unreadable — and reported as unchecked — for a number held at a carrier this deployment has no account with.
     */
    list: () =>
      send<{
        readonly items: readonly ({
        readonly number: string;
        readonly use: "inbound";
        readonly managedBy: "operator";
        readonly carrierWebhook: {
        readonly state: "matches" | "points-elsewhere" | "not-set" | "not-in-carrier-account" | "unchecked";
        readonly expected: string | null;
        readonly observed: string | null;
        readonly reason: string | null;
      };
      })[];
      }>(options, "GET", `/api/v1/numbers`, {}),

    /**
     * What this organisation can and cannot do to get a number
     * Two things are unavailable and both are stated here rather than discovered as a failing request: a number cannot be bought through this API, because the carrier sells no Nigerian inventory; and a number cannot be attached self-service, because the attached number routes every inbound call on the deployment and nothing yet proves an organisation controls the number it names. The webhook URL is this deployment's real ingress address, which is the value an operator needs at the carrier.
     */
    provisioning: () =>
      send<{
        readonly carrier: string | null;
        readonly claim: {
        readonly available: boolean;
        readonly reason: "no-nigerian-inventory";
        readonly detail: string;
      };
        readonly attach: {
        readonly selfService: boolean;
        readonly reason: "operator-owned-ingress";
        readonly detail: string;
      };
        readonly voiceWebhook: {
        readonly url: string | null;
        readonly method: "POST";
        readonly detail: string;
      };
      }>(options, "GET", `/api/v1/numbers/provisioning`, {}),
  },

  organization: {
    /**
     * This organisation
     * The company, not its agents. `/config` is the agent's script and is versioned; this is not. `audioRetentionDays` and `consent` are set by the platform operator and are shown here so a screen can explain them, not so it can change them.
     */
    read: () =>
      send<{
        readonly organizationId: string;
        readonly name: string;
        readonly createdAt: string;
        readonly audioRetentionDays: number;
        readonly consent: {
        readonly policy: string;
        readonly basis: string | null;
        readonly callingEarliestHour: number | null;
        readonly callingLatestHour: number | null;
      };
      }>(options, "GET", `/api/v1/organization`, {}),

    /**
     * Rename this organisation
     * Cosmetic, and only here: an agent's name is what it says on a call, and this is not that. Renaming the organisation leaves every agent saying exactly what it said before.
     */
    rename: (input: {
        readonly body: {
          readonly name: string;
        };
      }) =>
      send<{
        readonly organizationId: string;
        readonly name: string;
        readonly createdAt: string;
        readonly audioRetentionDays: number;
        readonly consent: {
        readonly policy: string;
        readonly basis: string | null;
        readonly callingEarliestHour: number | null;
        readonly callingLatestHour: number | null;
      };
      }>(options, "PATCH", `/api/v1/organization`, input),
  },

  readiness: {
    /**
     * Whether this organisation is live, and what is missing if it is not
     * Read-only. Every check is a failure that has actually happened while onboarding an organisation by hand: a carrier webhook nobody set, a voice id that publishes happily and ends the first call, a vault key whose absence drops every tool silently at config load, a tool or event document that no longer parses. A check that cannot be decided from this process answers `unknown` with the reason rather than passing. No call is placed.
     */
    report: () =>
      send<{
        readonly live: boolean;
        readonly checkedAt: string;
        readonly configVersion: number;
        readonly checks: readonly ({
        readonly id: "number.attached" | "number.carrier_webhook" | "number.traffic" | "greeting" | "voice" | "consent_policy" | "business_hours" | "tools" | "credentials" | "events" | "escalation";
        readonly title: string;
        readonly state: "ok" | "attention" | "blocked" | "unknown";
        readonly detail: string;
        readonly remedy: string | null;
      })[];
      }>(options, "GET", `/api/v1/readiness`, {}),
  },

  testCalls: {
    /**
     * Ring a number and let this organisation's agent answer it
     * Placed from the organisation's own number, through the same consent gate every outbound call goes through: refused with 422 and the reason if the destination has no consent on record, is on the do-not-call list, or it is outside calling hours. There is no flag that skips that. Answers 202 with the carrier's own status — the call is queued, not answered — and everything after that shows up on the call itself.
     */
    place: (input: {
        readonly body: {
          readonly to: string;
        };
      }) =>
      send<{
        readonly carrierCallId: string;
        readonly status: string;
        readonly to: string;
        readonly from: string;
        readonly configVersion: number;
      }>(options, "POST", `/api/v1/test-calls`, input),
  },

  tools: {
    /**
     * The tools this organisation has given its agent
     * Credential names are shown; credential values are not stored in this document and are never returned. Answers 409 if the stored configuration is one the agent is refusing to load, with the reason.
     */
    read: () =>
      send<{
        readonly configVersion: number;
        readonly egress: {
        readonly allowedHosts: readonly (string)[];
        readonly allowPlaintextHttp?: boolean;
      };
        readonly http: readonly ({
        readonly name: string;
        readonly description: string;
        readonly parametersJson: string;
        readonly riskTier: "read" | "write" | "irreversible";
        readonly url: string;
        readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
        readonly send: "query" | "body";
        readonly createdAt?: string;
        readonly updatedAt?: string;
        readonly headers?: Readonly<Record<string, string>>;
        readonly timeoutMs?: number;
        readonly credentialRef?: string;
        readonly speech?: {
        readonly template: string;
        readonly fallback: string;
      };
        readonly readback?: string;
        readonly transferReason?: string;
        readonly identifiers?: readonly ({
        readonly argument: string;
        readonly fact: string;
      })[];
      })[];
        readonly mcp: readonly ({
        readonly url: string;
        readonly credentialRef?: string;
        readonly tools: readonly ({
        readonly name: string;
        readonly riskTier: "read" | "write" | "irreversible";
        readonly timeoutMs?: number;
        readonly speech?: {
        readonly template: string;
        readonly fallback: string;
      };
        readonly readback?: string;
        readonly transferReason?: string;
        readonly identifiers?: readonly ({
        readonly argument: string;
        readonly fact: string;
      })[];
      })[];
      })[];
      }>(options, "GET", `/api/v1/tools`, {}),

    /**
     * Replace the tools this organisation has given its agent
     * Whole document, never a patch, and it publishes a new configuration version. Refused with 422 if any tool would not register — no risk tier, a write tool with no readback, a timeout over the ceiling, a name that shadows a platform tool, a URL outside egress.allowedHosts, or a credential reference this organisation has not stored.
     */
    replace: (input: {
        readonly body: {
          readonly expectedVersion: number;
          readonly note?: string;
          readonly egress: {
          readonly allowedHosts: readonly (string)[];
          readonly allowPlaintextHttp?: boolean;
        };
          readonly http: readonly ({
          readonly name: string;
          readonly description: string;
          readonly parametersJson: string;
          readonly riskTier: "read" | "write" | "irreversible";
          readonly url: string;
          readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
          readonly send: "query" | "body";
          readonly createdAt?: string;
          readonly updatedAt?: string;
          readonly headers?: Readonly<Record<string, string>>;
          readonly timeoutMs?: number;
          readonly credentialRef?: string;
          readonly speech?: {
          readonly template: string;
          readonly fallback: string;
        };
          readonly readback?: string;
          readonly transferReason?: string;
          readonly identifiers?: readonly ({
          readonly argument: string;
          readonly fact: string;
        })[];
        })[];
          readonly mcp: readonly ({
          readonly url: string;
          readonly credentialRef?: string;
          readonly tools: readonly ({
          readonly name: string;
          readonly riskTier: "read" | "write" | "irreversible";
          readonly timeoutMs?: number;
          readonly speech?: {
          readonly template: string;
          readonly fallback: string;
        };
          readonly readback?: string;
          readonly transferReason?: string;
          readonly identifiers?: readonly ({
          readonly argument: string;
          readonly fact: string;
        })[];
        })[];
        })[];
        };
      }) =>
      send<{
        readonly configVersion: number;
      }>(options, "PUT", `/api/v1/tools`, input),

    /**
     * Run one of this organisation's tools with test arguments
     * Through the same dispatch path a call uses, so the risk tiers apply: a `write` tool answers `confirm` with the readback the caller would hear and does not fire, and an `irreversible` tool answers `transfer` and never runs. Returns the raw response beside the summary and the normalized speech, which is where a template that silently renders its fallback becomes visible. 404 if this organisation has no tool by that name — including the platform's own call-control tools, which need a call.
     */
    test: (input: {
        readonly path: {
          readonly name: string;
        };
        readonly body: {
          readonly argumentsJson: string;
          readonly confirmed?: readonly ({
          readonly fact: string;
          readonly value: string;
        })[];
        };
      }) =>
      send<{
        readonly tool: string;
        readonly riskTier: "read" | "write" | "irreversible" | null;
        readonly outcome: "ok" | "confirm" | "transfer" | "failed";
        readonly raw: string | null;
        readonly summary: string;
        readonly speech: string;
        readonly reason: string | null;
        readonly route: string | null;
        readonly latencyMs: number;
      }>(options, "POST", `/api/v1/tools/${encodeURIComponent(input.path.name)}/test`, input),

    /**
     * Fetch one response from an endpoint, to see what shape it has
     * A GET, run through the same egress guard a call uses: https only unless plaintext is enabled, no credentials in the URL, and no host that resolves to a private or link-local address, checked on every redirect hop and every resolved address. The host does not need to be in the allowlist yet — this is for a URL you are about to save into it. GET only, because a sample of a POST would perform whatever that POST does. Returns the body and nothing else: never a request header, and never the credential it was sent with.
     */
    sample: (input: {
        readonly body: {
          readonly url: string;
          readonly headers?: Readonly<Record<string, string>>;
          readonly credentialRef?: string;
        };
      }) =>
      send<{
        readonly ok: boolean;
        readonly status: number | null;
        readonly json: string | null;
        readonly detail: string | null;
      }>(options, "POST", `/api/v1/tools/sample`, input),

    /**
     * Run a tool that has not been saved yet
     * Takes the tool as it stands on screen and runs it through the same dispatch path a call uses, without storing anything. The risk tiers still apply, because they are the dispatcher's and not this endpoint's: a `write` answers `confirm` with the readback and does not fire, an `irreversible` answers `transfer` and never runs. Nothing is persisted and no configuration version is created. The egress allowlist for the run is the tool's own host — the guard's address checks are unchanged, so a private or link-local target is refused exactly as it would be on a call.
     */
    try: (input: {
        readonly body: {
          readonly tool: {
          readonly name: string;
          readonly description: string;
          readonly parametersJson: string;
          readonly riskTier: "read" | "write" | "irreversible";
          readonly url: string;
          readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
          readonly send: "query" | "body";
          readonly createdAt?: string;
          readonly updatedAt?: string;
          readonly headers?: Readonly<Record<string, string>>;
          readonly timeoutMs?: number;
          readonly credentialRef?: string;
          readonly speech?: {
          readonly template: string;
          readonly fallback: string;
        };
          readonly readback?: string;
          readonly transferReason?: string;
          readonly identifiers?: readonly ({
          readonly argument: string;
          readonly fact: string;
        })[];
        };
          readonly argumentsJson: string;
          readonly confirmed?: readonly ({
          readonly fact: string;
          readonly value: string;
        })[];
        };
      }) =>
      send<{
        readonly tool: string;
        readonly riskTier: "read" | "write" | "irreversible" | null;
        readonly outcome: "ok" | "confirm" | "transfer" | "failed";
        readonly raw: string | null;
        readonly summary: string;
        readonly speech: string;
        readonly reason: string | null;
        readonly route: string | null;
        readonly latencyMs: number;
      }>(options, "POST", `/api/v1/tools/try`, input),
  },

  voices: {
    /**
     * The voices this deployment's speech account can speak with
     * Two populations in one list. `usable` is on the account and safe to save right now; `addable` is in the vendor's public library and has to be added there first; `beyond-plan` is in the library and this plan may not add it. Nothing here is organisation-specific and nothing here is written. A 503 means the account could not be read at all, which is deliberately not the same answer as an empty list.
     */
    list: () =>
      send<{
        readonly voices: readonly ({
        readonly voiceId: string;
        readonly name: string;
        readonly description: string | null;
        readonly availability: "usable" | "addable" | "beyond-plan";
        readonly previewUrl: string | null;
        readonly labels: {
        readonly accent: string | null;
        readonly gender: string | null;
        readonly age: string | null;
        readonly useCase: string | null;
        readonly language: string | null;
      };
      })[];
        readonly libraryUnread: boolean;
      }>(options, "GET", `/api/v1/voices`, {}),
  },
});

export type AnsaClient = ReturnType<typeof createAnsaClient>;
