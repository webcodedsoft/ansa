import type { Logger } from "@ansa/shared";
import { createEgressGuard, createTransport, type Transport } from "@ansa/tools";

/**
 * Sending one email, or honestly declining to.
 *
 * There was no mail in this product at all: no transport, no template, no dependency, no
 * environment variable. `POST /invitations` returned the token once and a person passed it on,
 * which the API README called a deliberate stopping point.
 *
 * **It goes through the same HTTP client as everything else.** `transport.ts` says there is no
 * second one in this product, and the reason is not tidiness — `fetch` cannot pin the address a
 * connection actually goes to, which is the DNS-rebinding gap the egress guard exists to close.
 * A mail vendor's host is not organisation-supplied, so the SSRF argument is weaker here, but
 * "weaker" is a poor reason to introduce the second client this codebase went out of its way
 * not to have. The guard is given an allowlist of exactly the configured mail host.
 *
 * Two providers, chosen by `MAIL_PROVIDER`, because both sets of credentials exist in the
 * environment and neither account was usable when this was written — Mailjet answered "your
 * account has been temporarily blocked" and Mailgun "please activate your Mailgun account".
 * Supporting both means whichever is unblocked first works without a code change. The
 * difference between them is three things and no more: who the credential belongs to, whether
 * the body is JSON or a form, and whether the sending domain lives in the URL.
 *
 * **A missing key is not an error.** With nothing configured this logs the message and reports
 * that it was not sent, and every caller is written to carry on — an invitation whose email
 * failed is still a valid invitation, and the console still shows the link once. That is what
 * makes this safe to deploy before anybody has chosen a provider, and it is why the token has
 * not been taken out of the API response: removing it would make a working flow depend on a
 * credential nobody has set.
 */

/** The injection token. Here rather than in a tokens file because nothing else provides mail. */
export const MAILER = Symbol("MAILER");

export interface Email {
  readonly to: string;
  readonly subject: string;
  /** Plain text only. A voice product has no house style for HTML mail and no need of one. */
  readonly text: string;
}

export interface Mailer {
  /** True when the vendor accepted it. False is logged, never thrown — see the header. */
  send(email: Email): Promise<boolean>;
}

export type MailProvider = "mailjet" | "mailgun" | "none";

export interface MailSettings {
  readonly provider: MailProvider;
  /** Mailjet's public key, or Mailgun's single API key. */
  readonly apiKey: string | null;
  /** Mailjet only. Mailgun authenticates with `api:<key>` and has no second half. */
  readonly secretKey: string | null;
  /** Mailgun only: the sending domain, which is part of its URL rather than its body. */
  readonly domain: string | null;
  readonly from: string | null;
  readonly baseUrl: string;
}

const trimmed = (env: NodeJS.ProcessEnv, key: string): string | null => {
  const value = env[key]?.trim();
  return value === undefined || value === "" ? null : value;
};

/**
 * What the environment says about mail, without deciding whether it is usable.
 *
 * `provider` is `none` unless it is explicitly set, so a deployment that has never thought
 * about mail does not accidentally acquire a half-configured one.
 */
export const loadMailSettings = (env: NodeJS.ProcessEnv = process.env): MailSettings => {
  const named = trimmed(env, "MAIL_PROVIDER");
  const provider: MailProvider =
    named === "mailjet" ? "mailjet" : named === "mailgun" ? "mailgun" : "none";
  return {
    provider,
    apiKey: trimmed(env, provider === "mailgun" ? "MAILGUN_API_KEY" : "MAILJET_API_KEY"),
    secretKey: trimmed(env, "MAILJET_SECRET_KEY"),
    domain: trimmed(env, "MAILGUN_DOMAIN"),
  /* `MAIL_FROM` is quoted in a dotenv file — `"Klose <a@b.test>"` — and the quotes survive
     parsing. Stripped here rather than at every use, because a display name wrapped in literal
     quote marks is what the recipient would otherwise see. */
    from: trimmed(env, "MAIL_FROM")?.replace(/^"|"$/g, "") ?? null,
    baseUrl:
      provider === "mailgun"
        ? (trimmed(env, "MAILGUN_BASE_URL") ?? "https://api.mailgun.net")
        : (trimmed(env, "MAILJET_BASE_URL") ?? "https://api.mailjet.com"),
  };
};

/** `Name <address@host>` or a bare address. Mailjet wants the two halves separately. */
const splitFrom = (from: string): { readonly email: string; readonly name: string | null } => {
  const angled = /^(.*)<([^>]+)>\s*$/.exec(from);
  if (angled === null) return { email: from.trim(), name: null };
  const name = (angled[1] ?? "").trim();
  return { email: (angled[2] ?? "").trim(), name: name === "" ? null : name };
};

/**
 * Everything the chosen provider needs. Anything missing means the log mailer and a warning.
 *
 * The two differ in what "everything" is, which is the only reason this is not one check:
 * Mailjet needs a key pair, Mailgun needs a key and the domain that appears in its URL.
 */
export const usable = (settings: MailSettings): boolean => {
  if (settings.from === null || settings.apiKey === null) return false;
  if (settings.provider === "mailjet") return settings.secretKey !== null;
  if (settings.provider === "mailgun") return settings.domain !== null;
  return false;
};

/**
 * The mailer for a deployment that has not configured one.
 *
 * It writes the subject and the recipient, and never the body. An invitation body carries a
 * redemption token, and a log line is the last place a bearer credential should end up —
 * hashing them in the database would be undone by printing one here.
 */
const logMailer = (log: Logger, reason: string): Mailer => ({
  send: async (email) => {
    log.warn("mail is not configured, so nothing was sent", {
      reason,
      to: email.to,
      subject: email.subject,
    });
    return false;
  },
});

export const createMailer = (log: Logger, settings: MailSettings = loadMailSettings()): Mailer => {
  if (!usable(settings)) {
    return logMailer(
      log,
      settings.provider === "none"
        ? "MAIL_PROVIDER is not set"
        : "the provider is missing a key or a from address",
    );
  }

  const from = splitFrom(settings.from ?? "");
  const host = new URL(settings.baseUrl).hostname;
  /* An allowlist of one. The address is ours rather than an organisation's, so this is not
     guarding against a hostile URL — it keeps mail on the one client that pins addresses,
     rather than adding a second that does not. */
  const transport: Transport = createTransport({
    guard: createEgressGuard({ policy: { allowedHosts: [host] } }),
  });

  /**
   * The two vendors differ in three ways and agree on everything else, so this is a shape
   * rather than two adapters: who the credential belongs to, whether the body is JSON or a
   * form, and whether the sending domain lives in the URL.
   */
  const request = (
    email: Email,
  ): { readonly url: string; readonly contentType: string; readonly body: string; readonly user: string } =>
    settings.provider === "mailgun"
      ? {
          url: `${settings.baseUrl}/v3/${settings.domain ?? ""}/messages`,
          contentType: "application/x-www-form-urlencoded",
          body: new URLSearchParams({
            from: settings.from ?? "",
            to: email.to,
            subject: email.subject,
            text: email.text,
          }).toString(),
          // Mailgun's user is the literal string `api`; the key is the password half.
          user: "api",
        }
      : {
          url: `${settings.baseUrl}/v3.1/send`,
          contentType: "application/json",
          body: JSON.stringify({
            Messages: [
              {
                From: { Email: from.email, ...(from.name === null ? {} : { Name: from.name }) },
                To: [{ Email: email.to }],
                Subject: email.subject,
                TextPart: email.text,
              },
            ],
          }),
          user: settings.apiKey ?? "",
        };

  return {
    send: async (email) => {
      const shaped = request(email);
      const password = settings.provider === "mailgun" ? settings.apiKey : settings.secretKey;
      const authorisation = Buffer.from(`${shaped.user}:${password ?? ""}`).toString("base64");
      /* Ten seconds. Generous for one API call and short enough that a vendor outage does not
         hold a caller open — the transport takes the caller's signal rather than baking a
         timeout in, so this is the only place it is decided. */
      const abort = AbortSignal.timeout(10_000);

      try {
        const response = await transport.send({
          url: shaped.url,
          method: "POST",
          headers: {
            authorization: `Basic ${authorisation}`,
            "content-type": shaped.contentType,
          },
          /* Named so the transport strips it on a cross-origin redirect rather than forwarding
             the credential to wherever the vendor happens to point. */
          sensitiveHeaders: ["authorization"],
          body: shaped.body,
          signal: abort,
        });

        if (response.status >= 200 && response.status < 300) return true;
        /* The vendor's own message is not logged. It echoes the request back, which for a send
           means the recipient and often the body — so a failed invitation would put a
           redemption token in the log. The status is enough to act on. */
        log.error("the mail provider refused the message", {
          status: response.status,
          to: email.to,
        });
        return false;
      } catch (error) {
        log.error("sending mail failed", {
          to: email.to,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },
  };
};
