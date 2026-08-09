import { revokeSession } from "@ansa/db";
import { Controller, Delete, Get, Headers, Inject, Post, UnauthorizedException } from "@nestjs/common";

import { Endpoint } from "../http/endpoint";
import { apiRoute, FromBody } from "../http/request";
import { choice, list, object, text, type Infer } from "../http/schema";
import { email, organisation, role, timestamp, uuid } from "../schemas";
import { TenantContext } from "../tenancy/tenant-context";
import { AuthService } from "./auth.service";
import { ALL_CAPABILITIES, capabilitiesOf } from "./capability";
import { Caller, type Principal } from "./principal";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./password";

/**
 * Sign in, sign out, and find out who you are.
 *
 * **This is one of the two files to copy from.** It shows the request pipeline on a public
 * route (schema, rate limit, no session) and on an authenticated one (`@Caller`, a scoped
 * transaction, a projected response). `../calls/calls.controller.ts` shows the other half:
 * a capability-gated, paginated read.
 *
 * Sign-in is two steps rather than one because a person can belong to more than one
 * organisation and a session belongs to exactly one. `POST /auth/organisations` says which
 * are available; `POST /auth/sessions` picks one. A client with a single-organisation user
 * can chain them without asking, and the alternative — a response that is sometimes a
 * session and sometimes a list — is a union type in every generated client for the sake of
 * saving a round trip on a screen a person visits once a week.
 */

const password = () => text({ minLength: MIN_PASSWORD_LENGTH, maxLength: MAX_PASSWORD_LENGTH, format: "password" });

const credentials = object({ email: email(), password: password() });

const signIn = object({
  email: email(),
  password: password(),
  organisationId: uuid(),
});

/**
 * Ten attempts per address per five minutes. Enough that nobody who knows their password
 * ever meets it, few enough that guessing is not a strategy.
 */
const SIGN_IN_LIMIT = { limit: 10, windowMs: 5 * 60_000, by: "ip+email" } as const;

const organisationList = object({
  organisations: list(object({ id: uuid(), name: text({ maxLength: 200 }), role: role() })),
});

const session = object({
  /** Shown once. It is not recoverable and is not stored anywhere in readable form. */
  token: text(),
  expiresAt: timestamp(),
  organisation,
  role: role(),
});

const me = object({
  user: object({ id: uuid(), email: email(), displayName: text({ maxLength: 200 }) }),
  organisation,
  role: role(),
  /**
   * So the dashboard can hide what the caller cannot do, from the same table the guard
   * enforces rather than from a second copy that will drift.
   */
  capabilities: list(choice(ALL_CAPABILITIES)),
});

@Controller(apiRoute("auth"))
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(TenantContext) private readonly db: TenantContext,
  ) {}

  @Post("organisations")
  @Endpoint({
    summary: "List the organisations an email and password can sign in to",
    description:
      "Returns an empty list for a wrong password and for an address with no account, and takes the same time to do it.",
    capability: "public",
    body: credentials,
    response: organisationList,
    rateLimit: SIGN_IN_LIMIT,
  })
  async organisations(
    @FromBody() body: Infer<typeof credentials>,
  ): Promise<Infer<typeof organisationList>> {
    const found = await this.auth.organisationsFor(body.email, body.password);
    return {
      organisations: found.map((each) => ({ id: each.tenantId, name: each.name, role: each.role })),
    };
  }

  @Post("sessions")
  @Endpoint({
    summary: "Sign in to one organisation",
    capability: "public",
    body: signIn,
    response: session,
    status: 201,
    rateLimit: SIGN_IN_LIMIT,
  })
  async signIn(
    @FromBody() body: Infer<typeof signIn>,
    // Recorded so a person can recognise their own sessions and revoke the one they do
    // not. Truncated because it is caller-controlled text heading for a column.
    @Headers("user-agent") userAgent?: string,
  ): Promise<Infer<typeof session>> {
    const signedIn = await this.auth.signIn(
      body.email,
      body.password,
      body.organisationId,
      userAgent?.slice(0, 200) ?? null,
      new Date(),
    );
    if (signedIn === null) throw new UnauthorizedException("those credentials did not sign in");

    return {
      token: signedIn.token,
      expiresAt: signedIn.expiresAt.toISOString(),
      organisation: { id: signedIn.organisation.tenantId, name: signedIn.organisation.name },
      role: signedIn.organisation.role,
    };
  }

  @Delete("sessions/current")
  @Endpoint({
    summary: "Sign out, revoking the token that made this request",
    description: "Idempotent. The session row is kept and marked revoked, so it stays in the audit trail.",
    capability: "authenticated",
  })
  async signOut(@Caller() caller: Principal): Promise<void> {
    await this.db.tx((scope) => revokeSession(scope, caller.sessionId, new Date()));
  }

  @Get("me")
  @Endpoint({
    summary: "The signed-in user, their organisation, and what they may do in it",
    capability: "authenticated",
    response: me,
  })
  async me(@Caller() caller: Principal): Promise<Infer<typeof me>> {
    // RLS restricts `tenants` to the row whose id is the current tenant, so this reads the
    // caller's own organisation and could not read another even without the where clause.
    const rows = await this.db.tx((scope) =>
      scope.query<{ name: string }>("select name from tenants limit 1"),
    );

    return {
      user: { id: caller.userId, email: caller.email, displayName: caller.displayName },
      organisation: { id: caller.tenantId, name: rows[0]?.name ?? "" },
      role: caller.role,
      capabilities: capabilitiesOf(caller.role),
    };
  }
}
