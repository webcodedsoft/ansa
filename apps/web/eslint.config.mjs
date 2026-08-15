import base, { noVendorSdks } from "@ansa/config/eslint";

/**
 * The repo's rules, applied to the frontend too.
 *
 * `noVendorSdks` is here for the same reason it is everywhere outside `packages/providers`:
 * this app talks to Ansa's own API and has no business importing a telephony or model SDK.
 * It is a lint error rather than a review note because review is not reliable.
 *
 * `func-style: expression` comes from the base and applies to components as well —
 * `const Page = () => …`, never `function Page()`. React does not care either way and the
 * codebase reads the same top to bottom.
 *
 * `generated.ts` is ignored because it is written by `apps/api`'s emitter. Lint findings in
 * it are findings about the generator, and fixing them here would be overwritten.
 */
export default [
  ...base,
  noVendorSdks,
  {
    ignores: [".next/**", "next-env.d.ts", "src/lib/api/generated.ts"],
  },
];
