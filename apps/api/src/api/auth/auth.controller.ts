import {
  closeAccount,
  endOtherSessions,
  passwordHashOf,
  renameUser,
  revokeSession,
  setPasswordHash,
} from "@ansa/db";
import {
  ConflictException,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Patch,
  Post,
  Put,
  UnauthorizedException,
} from "@nestjs/common";

import { Endpoint } from "../http/endpoint";
import { ValidationFailed } from "../http/problem";
import { apiRoute, FromBody } from "../http/request";
import { choice, flag, list, object, text, type Infer } from "../http/schema";
import { email, organisation, role, timestamp, uuid } from "../schemas";
import { OrganizationContext } from "../tenancy/organization-context";
import { AuthService } from "./auth.service";
import { ALL_CAPABILITIES, capabilitiesOf } from "./capability";
import { Caller, type Principal } from "./principal";
import { hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, verifyPassword } from "./password";

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

/**
 * A password being *chosen*. The minimum belongs here and only here.
 */
const newPassword = () =>
  text({ minLength: MIN_PASSWORD_LENGTH, maxLength: MAX_PASSWORD_LENGTH, format: "password" });

/**
 * A password being *offered*, which is a different question and must not carry the minimum.
 *
 * Enforcing a length on the way in looks like defence and is the opposite of it, three times
 * over:
 *
 * - It locks people out. Anyone whose password is shorter than today's minimum — set before
 *   the rule, or by any path that ever differed — cannot sign in at all, and the message they
 *   get reads like a typo hint rather than "your password can never be accepted again".
 * - It is an oracle. `POST /auth/organisations` promises in its own description to answer an
 *   empty list for a wrong password and for an address with no account, "and takes the same
 *   time to do it". A 422 for a short password answers differently and instantly, which tells
 *   a guesser whether their attempt was even worth making.
 * - It short-circuits the constant cost. Sign-in hashes before it decides, deliberately; a
 *   length check in front of that returns without hashing and puts the timing back.
 *
 * The maximum stays, and is the half that is genuinely defensive: scrypt will happily chew
 * through a megabyte of "password" if somebody posts one.
 */
const offeredPassword = () => text({ minLength: 1, maxLength: MAX_PASSWORD_LENGTH, format: "password" });

const credentials = object({ email: email(), password: offeredPassword() });

const signIn = object({
  email: email(),
  password: offeredPassword(),
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

const signUp = object({
  organisationName: text({ minLength: 1, maxLength: 120 }),
  displayName: text({ minLength: 1, maxLength: 200 }),
  email: email(),
  password: newPassword(),
});

const signedUp = object({
  token: text(),
  expiresAt: timestamp(),
  organisation,
  role: role(),
  /** False when the address already had an account and simply gained an organisation. */
  createdUser: flag(),
});

/**
 * Three organisations per address per hour.
 *
 * Creating one is cheap here and expensive downstream — every organisation is a organization a
 * human operator eventually points a phone number at. This is not the limit that matters in
 * the long run, and the one that does is a decision about who may create organizations at all,
 * which is a product question rather than a rate.
 */
const SIGN_UP_LIMIT = { limit: 3, windowMs: 60 * 60_000, by: "ip+email" } as const;

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

/** What a person may change about themselves. The email is the sign-in identity and stays. */
const profile = object({ displayName: text({ minLength: 1, maxLength: 200 }) });

const passwordChange = object({
  currentPassword: offeredPassword(),
  newPassword: newPassword(),
});

/** Closing an account asks for the password again: a stolen session must not be able to end the account. */
const accountClosure = object({ password: offeredPassword() });

/**
 * Ten guesses at the current password in five minutes, per session. The sign-in limit is
 * keyed by address because there is no session yet; here there is, and the person guessing
 * is whoever holds it.
 */
const PASSWORD_CHANGE_LIMIT = { limit: 10, windowMs: 5 * 60_000, by: "ip" } as const;

@Controller(apiRoute("auth"))
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(OrganizationContext) private readonly db: OrganizationContext,
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
      organisations: found.map((each) => ({ id: each.organizationId, name: each.name, role: each.role })),
    };
  }

  @Post("sign-ups")
  @Endpoint({
    summary: "Create an organisation and an account to own it",
    description:
      "The self-serve half of onboarding, for somebody arriving without an invitation. An address that already has an account may create a further organisation using the password it already has, and a wrong one is refused with the same 401 as a failed sign-in. Answers with a session, so there is no second step.",
    capability: "public",
    body: signUp,
    response: signedUp,
    status: 201,
    rateLimit: SIGN_UP_LIMIT,
  })
  async signUp(
    @FromBody() body: Infer<typeof signUp>,
    @Headers("user-agent") userAgent?: string,
  ): Promise<Infer<typeof signedUp>> {
    const created = await this.auth.signUp(
      body.organisationName,
      body.email,
      body.password,
      body.displayName,
      userAgent?.slice(0, 200) ?? null,
      new Date(),
    );
    // Identical to the sign-in failure, deliberately. Saying "that address exists but the
    // password is wrong" would confirm the address is registered, which is the thing
    // `POST /auth/organisations` spends a full scrypt on a missing account to avoid.
    if (created === null) throw new UnauthorizedException("those credentials did not sign in");

    return {
      token: created.token,
      expiresAt: created.expiresAt.toISOString(),
      organisation: { id: created.organisation.organizationId, name: created.organisation.name },
      role: created.organisation.role,
      createdUser: created.createdUser,
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
      organisation: { id: signedIn.organisation.organizationId, name: signedIn.organisation.name },
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
    return this.describe(caller, caller.displayName);
  }

  /** The `me` document, with the display name as it is now — which after a rename is not the one on the session. */
  private async describe(caller: Principal, displayName: string): Promise<Infer<typeof me>> {
    // RLS restricts `organizations` to the row whose id is the current organization, so this reads the
    // caller's own organisation and could not read another even without the where clause.
    const rows = await this.db.tx((scope) =>
      scope.query<{ name: string }>("select name from organizations limit 1"),
    );

    return {
      user: { id: caller.userId, email: caller.email, displayName },
      organisation: { id: caller.organizationId, name: rows[0]?.name ?? "" },
      role: caller.role,
      capabilities: capabilitiesOf(caller.role),
    };
  }

  @Patch("me")
  @Endpoint({
    summary: "Change your own display name",
    description:
      "The name you are shown as, everywhere your name appears. Your email is your sign-in identity and is not changed here — a new address is a new invitation, so the organisation's owners see it happen.",
    capability: "authenticated",
    body: profile,
    response: me,
  })
  async updateProfile(
    @Caller() caller: Principal,
    @FromBody() body: Infer<typeof profile>,
  ): Promise<Infer<typeof me>> {
    const renamed = await this.db.tx((scope) => renameUser(scope, caller.userId, body.displayName));
    // Only reachable if the account was deleted under a live session.
    if (!renamed) throw new NotFoundException();
    return this.describe(caller, body.displayName);
  }

  @Put("me/password")
  @Endpoint({
    summary: "Change your own password",
    description:
      "Takes the current password and the new one. Every other session you hold — in every organisation, on every device — is signed out; the session making this request stays. A wrong current password is a 422 on `currentPassword`, and is rate-limited like sign-in.",
    capability: "authenticated",
    body: passwordChange,
    rateLimit: PASSWORD_CHANGE_LIMIT,
    status: 204,
  })
  async changePassword(
    @Caller() caller: Principal,
    @FromBody() body: Infer<typeof passwordChange>,
  ): Promise<void> {
    await this.requirePassword(caller, body.currentPassword, "body.currentPassword");
    const replacement = await hashPassword(body.newPassword);
    await this.db.tx(async (scope) => {
      const changed = await setPasswordHash(scope, caller.userId, replacement);
      if (!changed) throw new NotFoundException();
      await endOtherSessions(scope, caller.userId, caller.sessionId);
    });
  }

  /**
   * The caller's password, or a 422 on the named field. The same constant-cost check
   * sign-in uses, so a wrong guess costs a full scrypt whether or not the account exists.
   */
  private async requirePassword(caller: Principal, password: string, path: string): Promise<void> {
    const stored = await this.db.tx((scope) => passwordHashOf(scope, caller.userId));
    const verified = await verifyPassword(stored, password);
    if (!verified || stored === null) {
      throw new ValidationFailed([{ path, message: "is not your current password" }]);
    }
  }

  @Delete("me")
  @Endpoint({
    summary: "Close your own account",
    description:
      "Asks for your password again, so a stolen session cannot end the account. Ends every membership you hold (softly — your name stays on what you did), revokes every session including this one, and frees your email address for a future sign-up. Refused with 409 while you are the only owner of any organisation: hand ownership on, or close the organisation, first.",
    capability: "authenticated",
    body: accountClosure,
    rateLimit: PASSWORD_CHANGE_LIMIT,
    status: 204,
  })
  async closeAccount(
    @Caller() caller: Principal,
    @FromBody() body: Infer<typeof accountClosure>,
  ): Promise<void> {
    await this.requirePassword(caller, body.password, "body.password");
    const soleOwnerOf = await this.db.tx((scope) => closeAccount(scope, caller.userId, caller.sessionId));
    if (soleOwnerOf.length > 0) {
      throw new ConflictException(
        `You are the only owner of ${soleOwnerOf.join(", ")}. Make somebody else an owner, or close the organisation, first.`,
      );
    }
  }
}
