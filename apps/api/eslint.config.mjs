import base, { noVendorSdks } from "@ansa/config/eslint";

// Orchestration code. A Twilio or TTS vendor type appearing here is a defect, not a
// shortcut — it is what would make swapping a provider after Gate A a rewrite.

/**
 * The dashboard surface reaches the database through one gateway, and this is what makes
 * that true rather than aspirational.
 *
 * `organization-gateway.ts` has claimed this rule exists since it was written and it did
 * not — the docstring described a lint failure and got a review comment at best. Anything
 * under `src/api/` outside that folder importing the raw handle is how a second, unscoped
 * path to organisation data appears, and the symptom of one is a query that returns
 * somebody else's rows.
 *
 * Scoped to `src/api/**` only. The call path — telephony, orchestrator, tenancy — is not a
 * dashboard request and holds its own scope deliberately.
 */
const oneDatabaseDoor = {
  name: "ansa/one-database-door",
  files: ["src/api/**/*.ts"],
  /*
   * `api.module.ts` is the composition root: it builds the handle the gateway is given, so
   * it is the door being constructed rather than a second one. Tests are exempt because
   * several exist to prove what happens without a scope, which they cannot do without
   * reaching past it.
   *
   * The rule found exactly one violation when it was switched on, and it was that file —
   * which is the good outcome: the convention was being followed, it just was not enforced.
   */
  ignores: ["src/api/tenancy/**", "src/api/api.module.ts", "**/*.test.ts"],
  rules: {
    "@typescript-eslint/no-restricted-imports": [
      "error",
      {
        paths: [
          {
            name: "@ansa/db",
            importNames: ["withOrganization", "createDataSource"],
            message:
              "The dashboard reaches the database through src/api/tenancy only. Take an OrganizationContext or an OrganizationScope instead — see organization-gateway.ts.",
          },
        ],
      },
    ],
  },
};

export default [...base, noVendorSdks, oneDatabaseDoor];
