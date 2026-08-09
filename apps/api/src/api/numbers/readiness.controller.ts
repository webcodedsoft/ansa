import { loadOnboardingFacts } from "@ansa/db";
import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";

import { Endpoint } from "../http/endpoint";
import { apiRoute } from "../http/request";
import { choice, flag, integer, list, nullable, object, text, type Infer } from "../http/schema";
import { timestamp } from "../schemas";
import { TenantContext } from "../tenancy/tenant-context";

import { loadNumbersEnvironment } from "./environment";
import { carrierDirectoryFor, probeCarrierWebhook, probeVoice, voiceCatalogueFor } from "./probes";
import { CHECK_IDS, CHECK_STATES, evaluateReadiness } from "./readiness";

/**
 * One endpoint answering "is this organisation actually live, and if not what is missing?"
 *
 * The reasoning is in `readiness.ts`, which is pure and where the judgement is tested. This
 * file is the two vendor lookups and the projection, and it is deliberately thin.
 *
 * **Nothing here places a call.** A test call is the only thing that proves an organisation
 * is live, it is the last step of the onboarding runbook, and it is somebody else's task
 * because dialling a number on a caller's behalf has a consent question attached to it that
 * a health check must not answer on their behalf. Every check here is a read: the tenant's
 * own rows, the carrier's record of a number, and whether a voice id resolves. Nothing is
 * written and nothing is sent to a third party's endpoint.
 */

const readinessCheck = object({
  id: choice(CHECK_IDS),
  title: text({ maxLength: 120 }),
  state: choice(CHECK_STATES),
  detail: text({ maxLength: 1200 }),
  remedy: nullable(text({ maxLength: 600 })),
});

const readinessReport = object({
  /**
   * True when no check is `blocked`. An `unknown` never makes an organisation live: a check
   * that could not run has not passed, and the worst thing this endpoint could do is report
   * an unwired number as wired.
   */
  live: flag(),
  checkedAt: timestamp(),
  /** The configuration version these answers were read from, so a stale tab is obvious. */
  configVersion: integer({ minimum: 0 }),
  checks: list(readinessCheck),
});

@Controller(apiRoute("readiness"))
export class ReadinessController {
  constructor(@Inject(TenantContext) private readonly db: TenantContext) {}

  @Get()
  @Endpoint({
    summary: "Whether this organisation is live, and what is missing if it is not",
    description:
      "Read-only. Every check is a failure that has actually happened while onboarding an organisation by hand: a carrier webhook nobody set, a voice id that publishes happily and ends the first call, a vault key whose absence drops every tool silently at config load, a tool or event document that no longer parses. A check that cannot be decided from this process answers `unknown` with the reason rather than passing. No call is placed.",
    capability: "config:read",
    response: readinessReport,
  })
  async report(): Promise<Infer<typeof readinessReport>> {
    const facts = await this.db.tx((scope) => loadOnboardingFacts(scope));
    if (facts === null) {
      // Unreachable through a session, which cannot exist without the row that owns it. A
      // 503 rather than a null dereference if it ever is reached.
      throw new ServiceUnavailableException("this organisation's record could not be read");
    }

    const environment = loadNumbersEnvironment();
    // Both at once. They are independent lookups against different vendors, and running
    // them in series would put one timeout behind another on a page somebody is watching.
    const [webhook, voice] = await Promise.all([
      probeCarrierWebhook(environment, facts.dialledNumber, carrierDirectoryFor(environment)),
      probeVoice(environment, facts.voiceId, voiceCatalogueFor(environment)),
    ]);

    const report = evaluateReadiness({ facts, environment, webhook, voice });
    return {
      live: report.live,
      checkedAt: new Date().toISOString(),
      configVersion: report.configVersion,
      checks: report.checks.map((entry) => ({
        id: entry.id,
        title: entry.title,
        state: entry.state,
        detail: entry.detail,
        remedy: entry.remedy,
      })),
    };
  }
}
