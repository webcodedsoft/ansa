import base, { noVendorSdks } from "@ansa/config/eslint";

export default [
  ...base,
  noVendorSdks,
  {
    // Hand-run developer scripts, not product code: they are Node programs whose whole
    // job is to read the environment and print what they did, so the globals the rest of
    // the package is right to forbid are exactly what belongs here.
    files: ["seeds/**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", URL: "readonly" },
    },
    rules: { "no-console": "off" },
  },
];
