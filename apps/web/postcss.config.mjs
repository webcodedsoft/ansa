/**
 * Tailwind v4 is a PostCSS plugin and nothing else — no `tailwind.config.js`, no `content`
 * globs to keep in sync with the folder layout. The theme is declared in `globals.css`.
 */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
