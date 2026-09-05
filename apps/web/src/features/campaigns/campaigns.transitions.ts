import type { CampaignStatus } from "./campaigns.service";

/**
 * The moves a campaign is allowed to make, mirrored from the API for the console.
 *
 * The API is the enforcer — it refuses an illegal move with a 409 that names it, and this
 * screen shows that message rather than inventing one. This map exists only so the console
 * offers the legal buttons rather than a grid the operator has to try one at a time. A move
 * the API added and this map has not is still reachable through the 409, never silently lost.
 *
 * draft → scheduled → running → paused → done, plus scheduled → draft and paused → running.
 * A finished campaign is terminal.
 */
const TRANSITIONS: Record<CampaignStatus, readonly CampaignStatus[]> = {
  draft: ["scheduled"],
  scheduled: ["running", "draft"],
  running: ["paused"],
  paused: ["running", "done"],
  done: [],
};

/** Where this campaign may go next, in the order the controls should offer them. */
export const nextStatuses = (status: CampaignStatus): readonly CampaignStatus[] =>
  TRANSITIONS[status];

/**
 * How each move reads on its button.
 *
 * The verb names the act rather than the destination — "Pause" not "Move to paused" — because
 * that is what the operator is deciding to do. `draft → scheduled` schedules; `scheduled →
 * draft` pulls it back to a draft so nobody rings while it is edited.
 */
export const moveLabel = (from: CampaignStatus, to: CampaignStatus): string => {
  if (to === "scheduled") return "Schedule";
  if (to === "running") return from === "paused" ? "Resume" : "Start calling";
  if (to === "paused") return "Pause";
  if (to === "done") return "Finish";
  if (to === "draft") return "Back to draft";
  return to;
};
