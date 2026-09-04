import type { Metadata } from "next";

import { PageHeader, Tag } from "@/components/ui";
import { WebhooksForm } from "@/features/connect/components/webhooks-form";
import { currentSubscriptions } from "@/features/connect/connect.service";

export const metadata: Metadata = { title: "Webhooks · Ansa" };

/**
 * Always live, never cached — see `agent/page.tsx` for the same reasoning. Saving here
 * writes a new configuration version, and a cached page would show the document from before
 * the save that just happened.
 */
export const dynamic = "force-dynamic";

const WebhooksPage = async () => {
  const document = await currentSubscriptions();

  return (
    <>
      <PageHeader
        eyebrow="Connect"
        title="Webhooks"
        actions={<Tag>version {document.configVersion}</Tag>}
        meta="Where this organisation's calls are pushed, and what gets masked on the way. Saving replaces the whole document — see the note on the Save card below."
      />

      <WebhooksForm document={document} />
    </>
  );
};

export default WebhooksPage;
