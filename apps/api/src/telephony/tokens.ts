export const APP_CONFIG = Symbol("APP_CONFIG");
export const TELEPHONY_PROVIDER = Symbol("TELEPHONY_PROVIDER");
export const TTS_PROVIDER = Symbol("TTS_PROVIDER");
export const LLM_PROVIDER = Symbol("LLM_PROVIDER");
export const LOGGER = Symbol("LOGGER");
export const DATA_SOURCE = Symbol("DATA_SOURCE");
export const ORGANIZATION_REGISTRY = Symbol("ORGANIZATION_REGISTRY");

/** Path the carrier POSTs to when a call arrives. */
export const VOICE_WEBHOOK_PATH = "/telephony/voice";
/** Path the carrier opens the media WebSocket against. */
export const MEDIA_STREAM_PATH = "/telephony/media";

/** Name of the `<Parameter>` carrying the resolved organization to the media socket. */
export const ORGANIZATION_PARAM = "organizationId";

/** Path the carrier POSTs the answering-machine verdict to. */
export const AMD_WEBHOOK_PATH = "/telephony/amd";

/** Path the carrier POSTs call lifecycle events to. */
export const STATUS_WEBHOOK_PATH = "/telephony/status";

/**
 * Facts the call record needs that the media socket does not otherwise carry.
 *
 * The socket knows a stream SID and nothing about who dialled whom, so anything the
 * `calls` row needs has to travel with the answer — the same route the organization takes.
 */
export const DIRECTION_PARAM = "direction";
export const DIALLED_PARAM = "dialled";
export const CALLER_PARAM = "caller";
