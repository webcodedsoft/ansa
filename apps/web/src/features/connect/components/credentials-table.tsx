"use client";

import { Fragment, useState } from "react";

import { Button, EmptyState, Table, Tag, Td, Th, Tr, type Tone } from "@/components/ui";
import { when } from "@/lib/format";

import type { CredentialSummary } from "../connect.service";
import { CredentialForm } from "./credential-form";
import { DeleteCredentialButton } from "./delete-credential-button";

const KIND_TONE: Record<CredentialSummary["kind"], Tone> = {
  auth: "accent",
  signing: "neutral",
  unreadable: "warn",
};

/**
 * Names, kinds and dates. Nothing else.
 *
 * There is no value column, masked or otherwise — see `connect.schema.ts` and
 * `credential-form.tsx` for why a mask that preserves length would leak the kind of secret
 * this is. Rotating a row expands an inline copy of the same form used to add one, because
 * the API has no separate "rotate" verb — it is the same PUT, keyed by name.
 */
export const CredentialsTable = ({
  credentials,
}: {
  readonly credentials: readonly CredentialSummary[];
}) => {
  const [rotating, setRotating] = useState<string | null>(null);

  if (credentials.length === 0) {
    return (
      <EmptyState title="No credentials stored">
        Store one below to give a tool or a webhook something to authenticate with.
      </EmptyState>
    );
  }

  return (
    <Table>
      <thead>
        <tr>
          <Th>Name</Th>
          <Th>Kind</Th>
          <Th>In use</Th>
          <Th>Created</Th>
          <Th>Updated</Th>
          <Th>
            <span className="sr-only">Actions</span>
          </Th>
        </tr>
      </thead>
      <tbody>
        {credentials.map((credential) => (
          <Fragment key={credential.ref}>
            <Tr>
              <Td className="font-mono text-[13px]">{credential.ref}</Td>
              <Td>
                <Tag tone={KIND_TONE[credential.kind]}>{credential.kind}</Tag>
              </Td>
              <Td>
                <Tag tone={credential.inUse ? "ok" : "neutral"}>
                  {credential.inUse ? "in use" : "unused"}
                </Tag>
              </Td>
              <Td className="tabular-nums">{when(credential.createdAt)}</Td>
              <Td className="tabular-nums">{when(credential.updatedAt)}</Td>
              <Td>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRotating(rotating === credential.ref ? null : credential.ref)}
                  >
                    {rotating === credential.ref ? "Cancel" : "Rotate"}
                  </Button>
                  <DeleteCredentialButton credentialRef={credential.ref} inUse={credential.inUse} />
                </div>
              </Td>
            </Tr>
            {rotating === credential.ref && (
              <tr>
                <Td colSpan={6} className="bg-[var(--surface-2)]">
                  <div className="max-w-md py-1">
                    <CredentialForm mode="rotate" fixedRef={credential.ref} onSaved={() => setRotating(null)} />
                  </div>
                </Td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </Table>
  );
};
