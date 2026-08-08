export const APP_CONFIG = Symbol("APP_CONFIG");
export const TELEPHONY_PROVIDER = Symbol("TELEPHONY_PROVIDER");
export const TTS_PROVIDER = Symbol("TTS_PROVIDER");
export const LLM_PROVIDER = Symbol("LLM_PROVIDER");
export const LOGGER = Symbol("LOGGER");
export const DATA_SOURCE = Symbol("DATA_SOURCE");
export const TENANT_REGISTRY = Symbol("TENANT_REGISTRY");

/** Path the carrier POSTs to when a call arrives. */
export const VOICE_WEBHOOK_PATH = "/telephony/voice";
/** Path the carrier opens the media WebSocket against. */
export const MEDIA_STREAM_PATH = "/telephony/media";

/** Name of the `<Parameter>` carrying the resolved tenant to the media socket. */
export const TENANT_PARAM = "tenantId";
