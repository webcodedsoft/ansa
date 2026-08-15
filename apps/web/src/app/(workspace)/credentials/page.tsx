import type { Metadata } from "next";

import { Card, PageHeader } from "@/components/ui";
import { CredentialForm } from "@/features/connect/components/credential-form";
import { CredentialsTable } from "@/features/connect/components/credentials-table";
import { listCredentials } from "@/features/connect/connect.service";

export const metadata: Metadata = { title: "Credentials · Ansa" };
export const dynamic = "force-dynamic";

const CredentialsPage = async () => {
  const { items } = await listCredentials();

  return (
    <>
      <PageHeader
        eyebrow="Connect"
        title="Credentials"
        meta="What tools and webhooks authenticate with. Names, kinds and dates only — no credential value is ever returned by this API, not plaintext, not ciphertext, not masked."
      />

      <Card>
        <CredentialsTable credentials={items} />
      </Card>

      <Card
        title="Add a credential"
        description="Store one under a name, then reference that name from a tool or a webhook."
        className="mt-3.5"
      >
        <CredentialForm mode="add" />
      </Card>
    </>
  );
};

export default CredentialsPage;
