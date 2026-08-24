---
name: livekit-grade-landing
description: Use when building or revising Ansa's marketing/landing pages — the dark technical-editorial design language studied from livekit.com on 2026-08-24 (tokens, type system, motion patterns, section grammar), how Ansa's own palette maps onto it, and the rules for staying honest about product claims.
---

# A LiveKit-grade landing page, in Ansa's own skin

This skill records what actually makes livekit.com work — measured from the live site with
computed styles and its own stylesheet keyframes, not recalled from impressions — and how
Ansa's landing page (`apps/web/src/app/page.tsx` + `page.module.css`) applies it. Consult it
before touching the landing page, and update it if the page's system changes.

## What LiveKit is actually doing (measured 2026-08-24)

**Ground.** One near-black neutral for the whole page: body `oklch(0.129 0 0)` (≈ #0e0e0e),
zero hue. Panels are barely-lighter fills with 1px hairline borders; nothing is "card on
white" anywhere. The page commits to dark for every visitor — no theme switch.

**Type is a three-voice system, and the voices never blur:**

| Voice | Face | Where |
|---|---|---|
| Display | custom geometric sans, **weight 300**, tight `-2.5%` tracking (48px/1.0 at laptop width) | H1/H2 only |
| Mono | custom mono, ~10–12px, uppercase + wide tracking for eyebrows | eyebrows, tabs, stats, captions, kbd hints, footer column headings, status |
| Body | Public Sans, 14–16px | paragraphs, buttons |

The *light* display weight on a dark ground is most of the "premium infrastructure" feel.
Buttons are small (12px text, 4px radius) — confidence, not shouting.

**Accent discipline.** One cyan, two uses only: `#1fd5f9` as text on the two or three
load-bearing words of a headline ("Build <cyan>voice, video,</cyan> and <cyan>physical
AI</cyan> agents", "Quickly <cyan>build</cyan>", "Ready to <cyan>build?</cyan>"), and a
softer cyan fill (`oklch(0.806 0.139 216)`) on the single primary button with near-black
text. Everything else is grey/white. The tinted-headline-word is the signature move.

**Section grammar** (top to bottom): thin announcement banner → nav (logo, dropdowns,
GitHub-repo-with-stars chip, ghost + solid CTAs) → hero (animated dot-matrix block above,
H1, grey sub, primary + ghost-with-kbd-hint) → mono-tab product showcase (VOICE AI / VIDEO
AI / ROBOTICS) → eyebrow+H2 code section with file-tab editor and a 4-card quickstart row →
feature checklist → **sticky "How it works" stepper** (numbered steps on a hairline spine;
scrolling advances the bold step and swaps an isometric wireframe) → stats section (huge
mono numbers, mono captions, ticking country feed, globe) → two-row testimonial marquee →
left-aligned "Ready to build?" CTA with reassurance microcopy ("No credit card required · …")
→ footer with mono uppercase column headings, compliance badges, and a green mono
`ALL SYSTEMS OPERATIONAL` status.

**Motion, from their own keyframes:**
- `dot-matrix-sweep`: `background-position 140% → -40%` across a dot grid — a scanline
  crossing dots, in the hero.
- `scroll-fade-reveal-{t,b,s,e}`: scroll-driven CSS-custom-property mask reveals
  (`animation-timeline`), so sections fade in at their edges as they enter.
- `marquee` / `marquee2`: `translateX(0 → -100%)` with duplicated content for the
  testimonial rows (two rows, staggered speeds).
- The stepper is scroll-pinned: position sticky, active step driven by scroll progress.
- Everything is subtle; nothing bounces. No parallax, no scale-in heroes.

## How Ansa wears it

**Not a clone — a register.** Ansa keeps the grammar (dark ground, three-voice type, tinted
headline words, mono eyebrows, hairline panels, one accent) and swaps in its own identity:

- Ground `#03070a` / surfaces `#070f13` — the console's own dark tokens, a *blue*-black
  where LiveKit's is neutral.
- Accent `#4fe8cb` (console `--accent`), `--accent-on: #032420` for text on accent fills.
  Teal, not LiveKit's cyan-blue.
- Display: system sans (`-apple-system, "SF Pro Display", "Segoe UI", …`) at weight 200/300
  with `-0.02em` tracking; mono: `ui-monospace` stack. Zero font dependencies — the repo
  imports nothing it can avoid.
- The landing commits to dark for everyone (scoped literals in `page.module.css`, not the
  themable tokens), so the console's light/dark theming is untouched.

**Ansa's own set pieces** — where the subject beats imitation:
- The hero animation is a **dot waveform** (radial-gradient dot grid masked into a speech
  envelope, swept LiveKit-style) — a voice product, so the dots draw a voice.
- The product showcase is a **rendered call transcript** with per-turn latency chips and a
  visible barge-in — the thing Ansa actually is, where LiveKit shows device mockups.
- The marquee is the **normalizer ticker**: `₦2,500,000 → "two point five million naira"`
  pairs scrolling in mono. No invented testimonials.
- Stats are **measured numbers with their provenance** ("227 ms — median reply on a live
  call"), never marketing rounding.

**Honesty rules.** Every claim on the page must be true of the codebase today: no logos, no
testimonials, no customer counts, no uptime promises. The reassurance microcopy under the
CTA says what is actually free/true. If a section needs social proof the product does not
have, the section is cut, not faked.

## Mechanics worth keeping

- Scroll reveals: `@supports (animation-timeline: view())` progressive enhancement —
  visible-by-default, animated where supported. Never hide content behind JS.
- Marquee: two copies of the row, `translateX(-50%)` loop, `animation-play-state: paused`
  on hover, and a `prefers-reduced-motion` kill switch on **all** motion.
- The whole page is a server component; zero client JS beyond the app's existing chrome.
- Buttons: 4px radius, mono or small text, accent fill with `--accent-on` ink for primary,
  hairline ghost for secondary — same feel as the console's own controls.
