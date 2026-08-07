import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Vendor SDKs that may only be imported inside `packages/providers/*`.
 * CLAUDE.md rule 2: swapping a provider must be a one-file change, which only holds
 * if no vendor type ever escapes its adapter. Enforced here rather than in review.
 */
export const VENDOR_SDK_PATTERNS = [
  "twilio",
  "twilio/**",
  "@twilio/**",
  "@deepgram/**",
  "elevenlabs",
  "@elevenlabs/**",
  "@anthropic-ai/**",
  "spitch",
  "@spitch/**",
  "intron",
  "@intron/**",
];

/**
 * Apply to every package that is NOT a provider adapter.
 */
export const noVendorSdks = {
  name: "ansa/no-vendor-sdks",
  rules: {
    "@typescript-eslint/no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: VENDOR_SDK_PATTERNS,
            message:
              "Vendor SDKs belong inside packages/providers/* adapters only. Import our own interface instead (CLAUDE.md rule 2).",
          },
        ],
      },
    ],
  },
};

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "**/*.d.ts", ".turbo/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    name: "ansa/base",
    rules: {
      // CLAUDE.md: no `any` without a comment explaining why. The comment is the
      // eslint-disable line, which makes the exception visible in review.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      eqeqeq: ["error", "smart"],
      "no-console": "error",
    },
  },
);
