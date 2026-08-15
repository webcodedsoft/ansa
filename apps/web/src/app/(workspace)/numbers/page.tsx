import type { Metadata } from "next";

import { Button, Card, Notice, PageHeader, SectionHead, SettingRow, Stack, Tag } from "@/components/ui";
import { listNumbers, numberProvisioning } from "@/features/connect/connect.service";
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
      <Card description="Numbers are provisioned by an operator, not through this dashboard.">
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

          <div className="pt-1">
            {/* Disabled rather than a live link: there is no request-a-number endpoint or
                support address this app can honestly wire up, and a button that looked
                clickable but did nothing would be worse than one that says so. */}
            <Button variant="primary" disabled>
              Request a number
            </Button>
            <p className="mt-1.5 max-w-[58ch] text-xs leading-relaxed text-[var(--ink-3)]">
              There is no self-service flow for this. Ask whoever operates this deployment to
              attach a number on your behalf — they will need the voice webhook address above.
            </p>
          </div>
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
