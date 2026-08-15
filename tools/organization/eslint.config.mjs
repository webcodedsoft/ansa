import base from "@ansa/config/eslint";

export default [
  ...base,
  {
    // A hand-run operator script: reading the environment and printing what happened is
    // the whole job.
    files: ["**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", URL: "readonly" },
    },
    rules: { "no-console": "off" },
  },
];
