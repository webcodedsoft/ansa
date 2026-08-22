import type { Metadata } from "next";

import { Card, Notice, PageHeader, SectionHead, SettingRow, Stack, Tag } from "@/components/ui";
import { claimWebhook, listNumbers, numberProvisioning } from "@/features/connect/connect.service";
import { ImportNumber } from "@/features/connect/components/import-number";
import { NumbersTable } from "@/features/connect/components/numbers-table";

export const metadata: Metadata = { title: "Numbers · Ansa" };

/**
 * Always live: whether a carrier webhook matches is exactly the kind of thing that changes
 * out from under this screen without this app knowing, and a cached "matches" is worse than
 * no answer at all.
 */
export const dynamic = "force-dynamic";

const NumbersPage = async () => {
  const [{ items }, provisioning] = await Promise.all([listNumbers(), numberProvisioning()]);

  /* Settled, and not part of the pair above. `GET /numbers/webhook` needs `config:write`
     while this page needs only `config:read`, so a member opening it gets a 403 for the
     webhook and nothing else — awaiting it outright meant one refused request took the whole
     numbers list down for exactly the people who cannot act on it anyway. Null hides the
     import card, which is the right thing to show somebody who could not use it. */
  const webhook = await claimWebhook().catch(() => null);

  return (
    <>
      <PageHeader
        eyebrow="Connect"
        title="Numbers"
        meta="The numbers attached to this organisation, and the carrier's own record of where each one sends calls."
      />

      <Card>
        <NumbersTable numbers={items} />
      </Card>

      <SectionHead>Getting a number</SectionHead>
      {webhook !== null && <ImportNumber webhook={webhook} />}

      <Card description="What this deployment can and cannot do about numbers, straight from the API.">
        <Stack>
          <SettingRow
            title="Buying a number"
            description={provisioning.claim.detail}
            control={
              <Tag tone={provisioning.claim.available ? "ok" : "neutral"}>
                {provisioning.claim.available ? "available" : "not available"}
              </Tag>
            }
          />
          <SettingRow
            title="Attaching a number"
            description={provisioning.attach.detail}
            control={
              <Tag tone={provisioning.attach.selfService ? "ok" : "neutral"}>
                {provisioning.attach.selfService ? "self-service" : "operator only"}
              </Tag>
            }
          />
          {provisioning.carrier !== null && (
            <SettingRow
              title="Carrier"
              description="Where this deployment's numbers are held."
              control={<span className="font-mono text-[13px]">{provisioning.carrier}</span>}
            />
          )}
          <SettingRow
            title="Voice webhook"
            description={provisioning.voiceWebhook.detail}
            control={
              provisioning.voiceWebhook.url === null ? (
                <span className="text-[13px] text-[var(--ink-3)]">not available</span>
              ) : (
                <span className="font-mono text-[12px]">
                  {provisioning.voiceWebhook.method} {provisioning.voiceWebhook.url}
                </span>
              )
            }
          />
        </Stack>
      </Card>

      {items.length === 0 && (
        <Notice tone="warn" className="mt-3.5">
          No number is attached yet, so nobody can call the agent. Placing a test call from
          the Calls screen still works.
        </Notice>
      )}
    </>
  );
};

export default NumbersPage;
