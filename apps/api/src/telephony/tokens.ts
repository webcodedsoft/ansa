export const APP_CONFIG = Symbol("APP_CONFIG");
export const TELEPHONY_PROVIDER = Symbol("TELEPHONY_PROVIDER");
export const TTS_PROVIDER = Symbol("TTS_PROVIDER");
export const LLM_PROVIDER = Symbol("LLM_PROVIDER");
export const LOGGER = Symbol("LOGGER");

/** Path the carrier POSTs to when a call arrives. */
export const VOICE_WEBHOOK_PATH = "/telephony/voice";
/** Path the carrier opens the media WebSocket against. */
export const MEDIA_STREAM_PATH = "/telephony/media";
