import base from "@ansa/config/eslint";

export default [
  ...base,
  {
    files: ["**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly" } },
    rules: { "no-console": "off" },
  },
];
