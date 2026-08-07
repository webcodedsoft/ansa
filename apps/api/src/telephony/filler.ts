/**
 * Short acknowledgements played into the gap while the agent is thinking.
 *
 * A caller who hears nothing for two seconds concludes the line has dropped, and the
 * thing they do next — repeat themselves — is what destroys the turn. R6.2 requires any
 * gap over 2s to produce sound; measured turns run 2.0-2.5s, so the requirement is
 * currently violated on every single one.
 *
 * These are deliberately content-free. Anything that commits to an answer would be
 * wrong half the time, and anything longer would collide with the real reply.
 */
export const FILLER_PHRASES: readonly string[] = ["Mm-hm.", "Okay.", "Right.", "Let me see."];
