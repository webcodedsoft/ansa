import { Card, Notice, Stack, TextField } from "@/components/ui";

import type { LiveConfiguration } from "../agents.service";

interface VoiceTabProps {
  readonly config: LiveConfiguration["config"];
  readonly errors: Readonly<Record<string, string>>;
}

/**
 * The one field the API actually exposes for voice: `voiceId`.
 *
 * The prototype this is built from shows a speaking-rate control and separate transcriber
 * and turn-detection pickers. Nothing in `client.config.*` carries those — they are decided
 * once per deployment (see `docs/STACK_DECISION.md`), not per agent — so this does not add
 * inputs that would submit and silently do nothing.
 */
export const VoiceTab = ({ config, errors }: VoiceTabProps) => (
  <Stack>
    <Card title="Voice" description="The synthesis voice this agent speaks with.">
      <TextField
        label="Voice"
        name="voiceId"
        defaultValue={config.voiceId ?? ""}
        maxLength={200}
        placeholder="Provider voice id"
        error={errors["voiceId"]}
        hint="Leave empty to use the platform default."
      />
    </Card>

    <Notice tone="warn">
      Transcriber, turn detection and speaking rate are not per-agent settings the API
      exposes — they are chosen once for the deployment. Exposing them here would submit a
      value the API has nowhere to put.
    </Notice>
  </Stack>
);
