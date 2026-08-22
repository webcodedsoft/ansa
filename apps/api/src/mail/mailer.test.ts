import type { LogFields, Logger } from "@ansa/shared";
import { describe, expect, it } from "vitest";

import { createMailer, loadMailSettings, usable } from "./mailer";

/**
 * What the mailer decides before it touches the network.
 *
 * Nothing here sends. Both accounts this was built against were unusable when it was written —
 * Mailjet answered "your account has been temporarily blocked" and Mailgun "please activate
 * your Mailgun account" — so a test that proved delivery would prove nothing today, and would
 * be a test that emails somebody every time it runs. What is worth pinning is the part that
 * decides: which provider, whether it is usable at all, and that an unconfigured deployment
 * degrades quietly rather than throwing.
 */

const recording = (): { readonly lines: string[]; readonly log: Logger } => {
  const lines: string[] = [];
  const make = (): Logger => ({
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string, fields?: LogFields) =>
      lines.push(`warn ${message} ${JSON.stringify(fields ?? {})}`),
    error: (message: string, fields?: LogFields) =>
      lines.push(`error ${message} ${JSON.stringify(fields ?? {})}`),
    child: () => make(),
  });
  return { lines, log: make() };
};

const MAILJET: NodeJS.ProcessEnv = {
  MAIL_PROVIDER: "mailjet",
  MAILJET_API_KEY: "key-not-real",
  MAILJET_SECRET_KEY: "secret-not-real",
  MAIL_FROM: '"Klose <someone@example.test>"',
};

const MAILGUN: NodeJS.ProcessEnv = {
  MAIL_PROVIDER: "mailgun",
  MAILGUN_API_KEY: "key-not-real",
  MAILGUN_DOMAIN: "sandbox.example.test",
  MAIL_FROM: "someone@example.test",
};

describe("what the environment says about mail", () => {
  it("reads a Mailjet pair", () => {
    const settings = loadMailSettings(MAILJET);
    expect(settings.provider).toBe("mailjet");
    expect(usable(settings)).toBe(true);
  });

  it("strips the quotes a dotenv file leaves around the from address", () => {
    /* `MAIL_FROM="Klose <a@b>"` keeps its quote marks through parsing, and a display name
       wrapped in literal quotes is what the recipient would see. */
    expect(loadMailSettings(MAILJET).from).toBe("Klose <someone@example.test>");
  });

  it("reads Mailgun's single key and its domain", () => {
    const settings = loadMailSettings(MAILGUN);
    expect(settings.provider).toBe("mailgun");
    expect(settings.domain).toBe("sandbox.example.test");
    expect(usable(settings)).toBe(true);
  });

  it("wants different things from each provider", () => {
    /* Mailjet needs a key pair; Mailgun needs a key and the domain that goes in its URL. One
       shared check would either accept a Mailgun config with no domain — a request to
       `/v3//messages` — or refuse a valid one for a secret it does not have. */
    expect(usable(loadMailSettings({ ...MAILJET, MAILJET_SECRET_KEY: "" }))).toBe(false);
    expect(usable(loadMailSettings({ ...MAILGUN, MAILGUN_DOMAIN: "" }))).toBe(false);
    // And Mailgun does not care that there is no Mailjet secret.
    expect(usable(loadMailSettings(MAILGUN))).toBe(true);
  });

  it("is off unless it was asked for", () => {
    /* Keys alone must not switch mail on. Both pairs sit in the environment of a deployment
       that has not decided, and acquiring a half-configured provider by accident is worse than
       having none. */
    expect(loadMailSettings({ MAILJET_API_KEY: "key-not-real" }).provider).toBe("none");
    expect(loadMailSettings({ MAIL_PROVIDER: "postmark" }).provider).toBe("none");
  });
});

describe("a deployment that has not configured mail", () => {
  it("declines rather than throwing", async () => {
    const { lines, log } = recording();
    const sent = await createMailer(log, loadMailSettings({})).send({
      to: "someone@example.test",
      subject: "Anything",
      text: "A body carrying a token.",
    });

    /* False, not an exception. Every caller carries on: an invitation whose email failed is
       still a valid invitation, and the console shows the link either way. */
    expect(sent).toBe(false);
    expect(lines.join(" ")).toContain("mail is not configured");
  });

  it("never writes the body to a log line", async () => {
    /* The body is where the redemption token is. Hashing tokens in the database would be
       undone by printing one here, and an unconfigured deployment is exactly the one whose
       logs somebody is reading. */
    const { lines, log } = recording();
    await createMailer(log, loadMailSettings({})).send({
      to: "someone@example.test",
      subject: "You have been invited",
      text: "https://ansa.test/accept-invitation?token=ansa_inv.secret-not-real",
    });

    expect(lines.join(" ")).not.toContain("secret-not-real");
    expect(lines.join(" ")).not.toContain("accept-invitation");
    // The recipient and subject are fine, and are what makes the line worth having.
    expect(lines.join(" ")).toContain("someone@example.test");
  });

  it("says which half is missing", async () => {
    const { lines, log } = recording();
    await createMailer(log, loadMailSettings({ MAIL_PROVIDER: "mailjet" })).send({
      to: "someone@example.test",
      subject: "Anything",
      text: "body",
    });
    expect(lines.join(" ")).toContain("missing a key");
  });
});
