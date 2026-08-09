import { createInvitation, listInvitations, revokeInvitation } from "@ansa/db";
import {
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Post,
  UnauthorizedException,
} from "@nestjs/common";

import { AuthService, INVITATION_TTL_MS } from "../auth/auth.service";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "../auth/password";
import { Caller, type Principal } from "../auth/principal";
import { mintInvitationToken } from "../auth/tokens";
import { Endpoint } from "../http/endpoint";
import { pageQuery, pageResponse, toPageBody, toPageRequest } from "../http/pagination";
import { apiRoute, FromBody, FromPath, FromQuery } from "../http/request";
import { flag, nullable, object, text, type Infer } from "../http/schema";
import { email, role, timestamp, uuid } from "../schemas";
import { TenantContext } from "../tenancy/tenant-context";

/**
 * Getting a colleague into the organisation.
 *
 * Ansa does not send mail yet, so `POST /invitations` returns the token once and whoever
 * is onboarding passes it on. That is a deliberate stopping point rather than an oversight
 * — see the README — and the shape does not change when a mailer arrives: the token stops
 * being in the response and starts being in the email.
 */

const invitation = object({
  id: uuid(),
  email: email(),
  role: role(),
  expiresAt: timestamp(),
  acceptedAt: nullable(timestamp()),
  revokedAt: nullable(timestamp()),
  createdAt: timestamp(),
});

const invitationPage = pageResponse(invitation);

const newInvitation = object({ email: email(), role: role() });

const issued = object({
  invitation,
  /**
   * Shown once and never again — only its SHA-256 is stored. Re-inviting the same address
   * issues a new token and revokes this one.
   */
  token: text(),
});

const invitationPath = object({ id: uuid() });

const acceptance = object({
  token: text({ maxLength: 200 }),
  password: text({ minLength: MIN_PASSWORD_LENGTH, maxLength: MAX_PASSWORD_LENGTH, format: "password" }),
  displayName: text({ minLength: 1, maxLength: 200 }),
});

const accepted = object({
  organisationId: uuid(),
  role: role(),
  /**
   * False when the address already had an account, in which case the password sent here
   * was ignored and the existing one still applies. The dashboard needs to know which
   * screen to show next.
   */
  createdUser: flag(),
});

/**
 * Twenty guesses an hour from one address. The token is 256 bits, so this is not what
 * makes it unguessable — it is what stops a redemption endpoint from being a free scrypt
 * generator, since every attempt hashes a password before it checks anything.
 */
const ACCEPT_LIMIT = { limit: 20, windowMs: 60 * 60_000, by: "ip" } as const;

@Controller(apiRoute("invitations"))
export class InvitationsController {
  constructor(
    @Inject(TenantContext) private readonly db: TenantContext,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  /**
   * Declared before `:id` routes for the reason the call viewer's `metrics` is: Nest
   * matches in declaration order, and a literal segment placed after a parameter is read
   * as a value for it.
   */
  @Post("accept")
  @Endpoint({
    summary: "Redeem an invitation and join the organisation it names",
    description:
      "Public: the token is the credential. The organisation comes from the invitation, never from the request.",
    capability: "public",
    body: acceptance,
    response: accepted,
    status: 201,
    rateLimit: ACCEPT_LIMIT,
  })
  async accept(@FromBody() body: Infer<typeof acceptance>): Promise<Infer<typeof accepted>> {
    const result = await this.auth.acceptInvitation(
      body.token,
      body.password,
      body.displayName,
      new Date(),
    );
    // Unknown, expired, already used, revoked — one answer, so a guesser learns nothing
    // about which of those their token was.
    if (result === null) throw new UnauthorizedException("that invitation cannot be redeemed");
    return result;
  }

  @Post()
  @Endpoint({
    summary: "Invite someone to this organisation",
    capability: "invitations:write",
    body: newInvitation,
    response: issued,
    status: 201,
  })
  async invite(
    @Caller() caller: Principal,
    @FromBody() body: Infer<typeof newInvitation>,
  ): Promise<Infer<typeof issued>> {
    const minted = mintInvitationToken();
    const now = new Date();
    const created = await this.db.tx((scope) =>
      createInvitation(
        scope,
        {
          // Lowercased here as well as constrained in the schema, so the partial unique
          // index on (tenant_id, email) sees one spelling of an address and not two.
          email: body.email.toLowerCase(),
          role: body.role,
          tokenHash: minted.hash,
          invitedBy: caller.userId,
          expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
        },
        now,
      ),
    );
    return { invitation: created, token: minted.token };
  }

  @Get()
  @Endpoint({
    summary: "List invitations, newest first, including spent and revoked ones",
    capability: "invitations:read",
    query: pageQuery,
    response: invitationPage,
  })
  async list(@FromQuery() query: Infer<typeof pageQuery>): Promise<Infer<typeof invitationPage>> {
    const page = toPageRequest(query);
    return toPageBody(await this.db.tx((scope) => listInvitations(scope, page)));
  }

  @Delete(":id")
  @Endpoint({
    summary: "Revoke an invitation that has not been redeemed",
    capability: "invitations:write",
    params: invitationPath,
  })
  async revoke(@FromPath() path: Infer<typeof invitationPath>): Promise<void> {
    const revoked = await this.db.tx((scope) => revokeInvitation(scope, path.id, new Date()));
    if (!revoked) throw new NotFoundException();
  }
}
