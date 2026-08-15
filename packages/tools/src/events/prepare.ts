import type { Logger, OrganizationId } from "@ansa/shared";

import { createEgressGuard } from "../connector/egress";
import { createTransport, type Transport } from "../connector/transport";
import { createInMemoryVault, type Credential, type Signer } from "../connector/vault";

import { parseEventConfig, subscribersTo, type EventSubscription, type EventType } from "./config";

/**
 * A organization's event subscriptions, resolved once per configuration load.
 *
 * The same split as `connector/prepare.ts` and for a related reason: parsing, the egress
 * guard, the vault and the signer are work that does not need doing per delivery, and this
 * runs where a slow thing is allowed to be slow.
 *
 * It never throws. A organization with a malformed event config gets no deliveries and a loud
 * log line; they do not get a failed call, and neither does anybody else.
 */

export interface PreparedSubscription {
  readonly subscription: EventSubscription;
  readonly signer: Signer;
  /** Null when the receiver asked for no extra auth beyond the signature. */
  readonly credential: Credential | null;
}

export interface PreparedEvents {
  /** The transport every subscription shares: one guard, one allowlist, one pinned socket. */
  readonly transport: Transport;
  /** Receivers that asked for this event, ready to be posted to. */
  subscribersTo(type: EventType): readonly PreparedSubscription[];
  /** True when this organization has asked for nothing, which is every organization until they do. */
  readonly empty: boolean;
}

const NOTHING: PreparedEvents = {
  // Unreachable: `empty` is checked before anything asks this for a transport, and no
  // subscription exists to hand it a URL. An allowlist of nothing refuses everything, which
  // is the correct behaviour for the object that represents "not configured".
  transport: createTransport({ guard: createEgressGuard({ policy: { allowedHosts: [] } }) }),
  subscribersTo: () => [],
  empty: true,
};

export const NO_EVENTS: PreparedEvents = NOTHING;

export interface PrepareEventsOptions {
  readonly organizationId: OrganizationId;
  /** The `event_config` column, exactly as stored. Validated here, not by the database. */
  readonly config: unknown;
  /** 32 bytes. Null disables every subscription, because none can be signed. */
  readonly credentialKey: Buffer | null;
  readonly sealedCredentials: ReadonlyMap<string, string>;
  readonly log: Logger;
}

export const prepareEvents = async (options: PrepareEventsOptions): Promise<PreparedEvents> => {
  const { organizationId, log } = options;
  if (options.config == null) return NOTHING;

  let parsed;
  try {
    parsed = parseEventConfig(options.config);
  } catch (error) {
    log.error("organization event configuration is not usable; nothing will be delivered", {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NOTHING;
  }

  if (parsed.subscriptions.length === 0) return NOTHING;

  const key = options.credentialKey;
  if (key === null) {
    // Not "deliver unsigned". A receiver that has been told to verify and then gets an
    // unsigned body either rejects it, which is confusing, or accepts it, which is worse.
    log.error("event subscriptions are configured and no vault key is; nothing will be delivered", {
      organizationId,
      subscriptions: parsed.subscriptions.length,
    });
    return NOTHING;
  }

  const vault = createInMemoryVault(key, new Map([[organizationId, options.sealedCredentials]]));
  const transport = createTransport({ guard: createEgressGuard({ policy: parsed.egress }) });
  const ready: PreparedSubscription[] = [];

  for (const subscription of parsed.subscriptions) {
    try {
      const signer = await vault.resolveSigner(organizationId, subscription.signingSecretRef);
      if (signer === null) {
        log.error("event subscription names a signing secret the vault does not hold", {
          organizationId,
          subscription: subscription.name,
          ref: subscription.signingSecretRef,
        });
        continue;
      }
      const credential =
        subscription.credentialRef === undefined
          ? null
          : await vault.resolve(organizationId, subscription.credentialRef);
      ready.push({ subscription, signer, credential });
    } catch (error) {
      // One receiver with a bad secret must not cost the organization their other receivers.
      log.error("event subscription could not be prepared", {
        organizationId,
        subscription: subscription.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (ready.length === 0) return NOTHING;

  const byName = ready;
  return {
    transport,
    subscribersTo: (type) => {
      const wanted = new Set(subscribersTo(parsed, type).map((s) => s.name));
      return byName.filter((entry) => wanted.has(entry.subscription.name));
    },
    empty: false,
  };
};
