// Root config. Every workspace package carries its own eslint.config.mjs; this one
// exists so `eslint .` at the root does not fail, and covers nothing else.
export default [
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/.turbo/**", "apps/**", "packages/**"],
  },
];
