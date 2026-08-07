import base, { noVendorSdks } from "@ansa/config/eslint";

// Orchestration code. A Twilio or TTS vendor type appearing here is a defect, not a
// shortcut — it is what would make swapping a provider after Gate A a rewrite.
export default [...base, noVendorSdks];
