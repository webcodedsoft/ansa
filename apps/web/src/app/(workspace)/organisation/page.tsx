import type { Metadata } from "next";
import Link from "next/link";

import { Card, PageHeader, Stack, Table, Td, Th, Tr } from "@/components/ui";
import { HoursForm } from "@/features/org/components/hours-form";
import { organisation } from "@/features/org/org.service";

export const metadata: Metadata = { title: "Organisation · Ansa" };
export const dynamic = "force-dynamic";

/**
 * The company, as against its agents.
 *
 * It exists because opening hours had nowhere to live. They are columns on `organizations`,
 * read on every call and shared by every agent — and the only way to change them was to
 * publish an agent, which meant one agent's workspace quietly rewriting hours for all of them.
 * Migration 0053 moved them out of the publish document; this is where they landed.
 *
 * The retention windows sit beside them because they answer the same kind of question — what
 * is true of the company rather than of one script — and because a page holding only hours
 * would invite the next organisation-wide setting to be bolted onto an agent again.
 */
const OrganisationPage = async () => {
  const org = await organisation();

  return (
    <>
      <PageHeader
        eyebrow="Organisation"
        title={org.name}
        meta="Settings that belong to the company rather than to any one agent. Everything here applies to every agent it runs."
      />

      <Stack>
        <HoursForm organisation={org} />

        <Card
          title="Retention"
          description="How long a call is kept, set by the platform operator. Read-only here — shortening it deletes evidence an organisation may be asked for, and lengthening it holds a caller's data past the basis it was collected on."
        >
          <Table>
            <thead>
              <Tr>
                <Th>What</Th>
                <Th>Kept for</Th>
              </Tr>
            </thead>
            <tbody>
              <Tr>
                <Td>The caller&apos;s voice</Td>
                <Td>{org.audioRetentionDays} days</Td>
              </Tr>
              {/* Two windows rather than one. The recording of somebody reading their policy
                  number aloud goes on the first clock, the transcript of them reading it on the
                  second — and the words outlive the audio on purpose, because the review loop
                  corrects transcripts and the eval corpus is built from those corrections. A
                  reader shown only the first number would believe everything was gone a month
                  after the call. */}
              <Tr>
                <Td>What was said — transcripts, events, tool arguments</Td>
                <Td>{org.transcriptRetentionDays} days</Td>
              </Tr>
            </tbody>
          </Table>
        </Card>

        <Card
          title="Consent & do-not-call"
          description="How this organisation is permitted to call somebody, and when."
        >
          <p className="text-sm text-[var(--ink-2)]">
            Set by the platform operator and enforced in the outbound dispatch path before a
            number is dialled — not in a prompt, so nothing on this dashboard can loosen it.{" "}
            <Link href="/consent" className="underline">
              See what is in force
            </Link>
            .
          </p>
        </Card>
      </Stack>
    </>
  );
};

export default OrganisationPage;
