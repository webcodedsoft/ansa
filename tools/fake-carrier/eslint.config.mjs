import base from "@ansa/config/eslint";

// This tool impersonates one specific carrier, so it is carrier-specific by definition
// and the vendor-SDK ban does not apply — same reasoning as a provider adapter. It is a
// command-line tool, so printing to stdout is its job rather than a lapse.
export default [
  ...base,
  {
    name: "ansa/fake-carrier",
    rules: { "no-console": "off" },
  },
];
