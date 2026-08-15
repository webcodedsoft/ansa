import type { Metadata } from "next";

import { Card, GlassPanel, Notice, PageHeader, Stack } from "@/components/ui";
import { humanise } from "@/lib/format";
import { currentConfiguration } from "@/features/org/org.service";

export const metadata: Metadata = { title: "Consent · Ansa" };
export const dynamic = "force-dynamic";

const hourLabel = (hour: number | null): string => (hour === null ? "not narrowed" : `${String(hour).padStart(2, "0")}:00`);

const ConsentPage = async () => {
  const { operatorManaged } = await currentConfiguration();
  const { consent } = operatorManaged;

  return (
    <>
      <PageHeader
        eyebrow="Organisation"
        title="Consent & do-not-call"
        meta="How this organisation is permitted to call someone, and when. Set by the platform operator, and enforced in the outbound dispatch path on every call — nothing on this page can loosen it."
      />

      <Notice tone="warn">
        This page is read-only by design. There is no setting here, on this dashboard or
        anywhere else, that relaxes the consent gate. The check runs in code before a number is
        dialled, not in a prompt, so it cannot be talked around and it cannot be configured
        around either.
      </Notice>

      <Card title="Legal basis" className="mt-3.5" description="How this organisation establishes it may call a number.">
        <Stack>
          <GlassPanel className="px-[18px] py-4">
            <div className="text-[11.5px] text-[var(--ink-3)]">Policy</div>
            <div className="mt-1 text-[15px] font-medium">{humanise(consent.policy)}</div>
          </GlassPanel>
          <GlassPanel className="px-[18px] py-4">
            <div className="text-[11.5px] text-[var(--ink-3)]">Declared basis</div>
            <div className="mt-1 text-[15px] font-medium">
              {consent.basis === null ? "None recorded" : consent.basis}
            </div>
          </GlassPanel>
        </Stack>
      </Card>

      <Card
        title="Permitted calling hours"
        className="mt-3.5"
        description="Local time (WAT). The platform's own outer bound is 08:00–20:00 and no organisation can widen it — an organisation may only narrow it further."
      >
        <div className="grid gap-3.5 sm:grid-cols-2">
          <GlassPanel className="px-[18px] py-4">
            <div className="text-[11.5px] text-[var(--ink-3)]">Earliest</div>
            <div className="mt-1 text-[15px] font-medium">{hourLabel(consent.callingEarliestHour)}</div>
          </GlassPanel>
          <GlassPanel className="px-[18px] py-4">
            <div className="text-[11.5px] text-[var(--ink-3)]">Latest</div>
            <div className="mt-1 text-[15px] font-medium">{hourLabel(consent.callingLatestHour)}</div>
          </GlassPanel>
        </div>
      </Card>

      <Card
        title="Do-not-call list"
        className="mt-3.5"
        description="Suppression outranks every consent record and every policy — a number on this list cannot be called regardless of basis."
      >
        <p className="text-[13.5px] leading-relaxed text-[var(--ink-3)]">
          The dispatch gate checks a do-not-call suppression on every outbound call, and refuses
          with a stated reason when a number is on it. There is currently no API endpoint that
          reads back which numbers are suppressed, so this dashboard cannot show that list —
          only that the check exists and runs before every call.
        </p>
      </Card>
    </>
  );
};

export default ConsentPage;
