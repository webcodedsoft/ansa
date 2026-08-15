import { Catch, HttpException, HttpStatus, type ArgumentsHost } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import { createLogger, type Logger } from "@ansa/shared";

import { isApiPath, stateOf, type ApiRequest } from "./request";
import type { FieldError } from "./schema";

/**
 * One error shape for the whole API: RFC 9457 `application/problem+json`.
 *
 * The alternative is what most Nest services end up with — Nest's default
 * `{ statusCode, message, error }` for anything thrown by the framework, and something
 * hand-rolled for anything thrown by a handler. A client then has two shapes to parse and
 * discovers the second one in production.
 *
 * `type` is a stable identifier a client can branch on. It is a URN rather than a URL
 * because a URL implies a page that exists, and inventing a hostname here would be a
 * hard-coded value nobody owns.
 */
export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  /** Echoed from the request so a user's screenshot is enough to find the log line. */
  readonly requestId?: string;
  /** Present only on a validation failure. */
  readonly errors?: readonly FieldError[];
}

export const PROBLEM_TYPE_PREFIX = "urn:ansa:problem:";

/** Minimal structural view of the HTTP response. Keeps the express types out of here. */
interface HttpResponse {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

/**
 * Thrown when a request does not match its endpoint's schema.
 *
 * 422 rather than 400: the request was well-formed JSON the server understood, and it was
 * the content that was wrong. 400 is reserved here for a body that could not be parsed at
 * all, which express raises before anything of ours runs.
 */
export class ValidationFailed extends HttpException {
  constructor(readonly fields: readonly FieldError[]) {
    super("validation failed", HttpStatus.UNPROCESSABLE_ENTITY);
  }
}

const SLUGS: Readonly<Record<number, string>> = {
  400: "malformed-request",
  401: "unauthenticated",
  403: "forbidden",
  404: "not-found",
  409: "conflict",
  422: "validation-failed",
  429: "too-many-requests",
  500: "internal-error",
  503: "unavailable",
};

const TITLES: Readonly<Record<number, string>> = {
  400: "The request could not be read",
  401: "Sign in required",
  403: "Not allowed",
  404: "Not found",
  409: "Conflicts with the current state",
  422: "The request did not validate",
  429: "Too many requests",
  500: "Something went wrong",
  503: "Temporarily unavailable",
};

/** The `detail` Nest put on the exception, if it is a plain human-readable string. */
const detailOf = (exception: HttpException): string | undefined => {
  const response = exception.getResponse();
  if (typeof response === "string") return response;
  if (typeof response !== "object" || response === null) return undefined;
  const message = (response as Record<string, unknown>)["message"];
  if (typeof message === "string") return message;
  if (Array.isArray(message)) return message.filter((m) => typeof m === "string").join("; ");
  return undefined;
};

export const toProblem = (exception: unknown, requestId: string | undefined): Problem => {
  const status =
    exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
  const slug = SLUGS[status] ?? "error";
  const title = TITLES[status] ?? "Request failed";

  // Anything that is not an HttpException is a bug, and its message is as likely to be a
  // stack frame or a connection string as it is to be useful. It goes to the log, never
  // to the client.
  const detail = exception instanceof HttpException ? detailOf(exception) : undefined;

  // Nest's default message for a bare `NotFoundException` is "Not Found", which is our
  // title with different capitalisation. Repeating it adds a field and says nothing.
  const echoesTitle = detail?.toLowerCase() === title.toLowerCase();

  return {
    type: `${PROBLEM_TYPE_PREFIX}${slug}`,
    title,
    status,
    ...(detail === undefined || echoesTitle ? {} : { detail }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(exception instanceof ValidationFailed ? { errors: exception.fields } : {}),
  };
};

export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Turns everything thrown anywhere under `/api/v1` into a `Problem`.
 *
 * Registered as `APP_FILTER`, so it also catches what guards and interceptors throw —
 * which matters, because the two most common failures on this surface (not signed in, not
 * allowed) are both thrown by guards and would otherwise escape in Nest's default shape.
 *
 * `APP_FILTER` is application-wide, not module-wide, so everything else — the carrier
 * webhooks, the media socket, the call viewer — is handed straight back to Nest's own
 * filter. Twilio reads status codes and TwiML, not problem documents, and a webhook is
 * not the place to discover that its error body changed shape.
 */
@Catch()
export class ProblemFilter extends BaseExceptionFilter {
  private readonly log: Logger = createLogger({ component: "api" });

  override catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    if (host.getType() !== "http" || !isApiPath(http.getRequest<ApiRequest>().originalUrl ?? "")) {
      super.catch(exception, host);
      return;
    }

    const response = http.getResponse<HttpResponse>();
    const request = http.getRequest<ApiRequest>();
    const state = stateOf(request);
    const problem = toProblem(exception, state.requestId);

    // A 5xx is the only case where the client is told less than we know, so it is the one
    // case that has to reach the log — with the organization on the line (CLAUDE.md rule 3), so
    // "is this one organisation or all of them" is answerable without a repro.
    if (problem.status >= 500) {
      const principal = state.principal;
      this.log.error("api request failed", {
        requestId: state.requestId,
        method: request.method,
        path: request.originalUrl.split("?")[0],
        organizationId:
          typeof principal === "object" && principal !== null && "organizationId" in principal
            ? String((principal as { organizationId: unknown }).organizationId)
            : null,
        error: exception instanceof Error ? exception.message : String(exception),
        stack: exception instanceof Error ? exception.stack : undefined,
      });
    }

    response.setHeader(REQUEST_ID_HEADER, problem.requestId ?? "");
    response.setHeader("Content-Type", "application/problem+json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.status(problem.status).json(problem);
  }
}
