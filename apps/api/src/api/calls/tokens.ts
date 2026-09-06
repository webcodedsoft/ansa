/**
 * The registry of live recording tickets, as an injection token.
 *
 * A symbol rather than a string, like `WHISPER_REGISTRY` beside it: the two controllers that
 * share this must share the *same* instance — one mints a ticket and the other spends it —
 * and a string token a second module could name by accident would give them two maps and a
 * link that never works.
 */
export const RECORDING_LINKS = Symbol("RECORDING_LINKS");

/**
 * The config the recording pair reads — where audio lives, and the base URL a link is built
 * from.
 *
 * Its own token rather than the call path's `APP_CONFIG`, because reaching for that would
 * make the API module import the telephony module: the whole media stack pulled into the
 * dashboard's graph so that one endpoint can read one directory name.
 */
export const RECORDING_CONFIG = Symbol("RECORDING_CONFIG");

/** The recording pair's own logger, for the same reason its config is its own. */
export const RECORDING_LOGGER = Symbol("RECORDING_LOGGER");
