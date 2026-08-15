import { Notice } from "@/components/ui";

/**
 * The one honest thing every screen in this section has to say.
 *
 * `client.config.*` operates on a single configuration per organization — there is no `agents`
 * table, no per-agent id, and nothing here pretends otherwise. Making this a shared
 * component means the wording cannot drift between the list, the workspace and the wizard.
 */
export const MultiAgentNotice = ({ compact = false }: { readonly compact?: boolean }) => (
  <Notice tone="warn">
    {compact ? (
      "One agent per organisation today — the API has no agents table yet."
    ) : (
      <>
        This organisation can run <b>one</b> agent today. The API has a single configuration
        per organization (<code>config.current</code> / <code>config.publish</code>), not a table
        of agents with their own ids — so there is nothing here to list, switch between or
        create a second one of. Supporting more would need an <code>agents</code> table keyed
        by organization, a version history per agent, and routing that decides which agent a number
        or a call reaches. Until that exists, every screen in this section reads and writes
        the one live configuration.
      </>
    )}
  </Notice>
);
