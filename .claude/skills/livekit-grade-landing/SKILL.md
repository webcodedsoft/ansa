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

- The showcase tabs are radio inputs + labels, zero JS. The radios must be
  `position: fixed` — focusing an absolutely-positioned hidden radio makes the browser
  scroll its static position into view, and every tab click yanked the page until it was.
- The scroll-pinned stepper is driven by `components/motion.tsx` (`ScrollScene`), not by
  CSS `animation-timeline` — scroll-driven CSS is Chrome/Safari only and the signature
  effect must fire everywhere. The component writes `--p` (continuous 0..1) and
  `data-step` onto a 320vh wrapper with a sticky panel; CSS couples the isometric stack's
  rotation and plane spread to `--p` via calc() (continuous — the geometry moves with the
  scroll, which is what beats the reference's discrete swaps) and swaps exclusive step
  states, the progress rail and the status line off `data-step`. Do NOT throttle the
  scroll handler through requestAnimationFrame: rAF starves entirely in occluded tabs and
  the queue flag wedges — one getBoundingClientRect per scroll event needs no throttle.
- Reveals are IntersectionObserver-driven (`Reveal` in the same file) for the same
  every-browser reason. Hidden initial states exist only under `html.js`, set by a
  synchronous inline script — no JavaScript means nothing is ever hidden. Reveal on
  `isIntersecting` **or** `boundingClientRect.bottom < 0`: one large jump (a fling, an
  in-page anchor, a restored scroll position) can carry a section from below the fold to
  above it without ever intersecting, and it then stays at opacity 0 for good.

## Verifying this page in a driven browser

A backgrounded tab freezes the animation clock: `requestAnimationFrame` never fires, CSS
transitions report `playState: "running"` and never advance, and every reveal-gated section
screenshots as a black hole. This looks exactly like a layout bug and is not one — it cost
a full debugging detour once already.

Confirm it in one call: if `await new Promise(r => requestAnimationFrame(r))` times out, the
clock is frozen and nothing animation-driven can be trusted. To judge **layout** regardless,
run `document.documentElement.classList.remove('js')` first — every hidden state is gated on
that class, so removing it shows the true page with nothing suppressed. Note the scroll
runway collapses to auto-height in that mode, so the page measures shorter than it really is.

## Drawing an isometric world (what the reference actually does)

Studied from the "How it works" and "The complete stack" sections. The planes and tiles are
the least of it — four things do the work, and skipping any of them leaves a diagram rather
than a world:

1. **A lattice far wider than the artwork**, radially masked so it dissolves at the rim
   instead of ending on an edge. Plus one or two long dashed construction lines crossing
   everything. This is what makes the scene read as continuing past the panel.
2. **Content lying ON the surfaces** — the reference puts device mockups and icon grids on
   its layers. Ansa draws what each stage actually handles: 20ms frames, the listen dot
   matrix, knowledge/tool chips, the reply envelope. Keep it *fine* texture at low alpha:
   fat marks drown the surface and the layer stops reading as a layer.
3. **Labels riding the perspective**, not counter-rotated flat. Anything parented inside the
   transformed container inherits the isometric transform for free — put a tag on a plane
   edge or a name on a connector and it lies in the world like the reference's
   "GLOBAL EDGE NETWORK" and "WebRTC".
4. **Bleeding off the viewport.** The diagram is scaled up and given a negative margin so it
   runs past its column to the screen edge, clipped by the section. A drawing that stops
   politely inside its grid cell looks like a picture; one that runs off the edge looks like
   a world you are seeing part of.

For a node graph, keep the geometry in the markup and let CSS only place and rotate: each
node carries its world position, each link a length and an angle from `atan2`. Attach links
to node *edges* by treating the tile as an ellipse (`1 / hypot(cos/halfW, sin/halfH)`) —
a fixed inset gaps the horizontal runs and buries the vertical ones.

**How the connectors carry current.** Read off the reference's own DOM: the whole network is
one `<path>` with `stroke-dasharray="1 1"` — a *dotted* run — painted with
`stroke="url(#grad)"`, and a single SMIL `<animateTransform>` slides that gradient
(`attributeName="gradientTransform"`, `type="translate"`, `-3 0` → `3 0`, 3s, indefinite).
So what travels is a **band of brightness moving along a dotted line**, not an object moving
past it. One path, one animation, one coherent circuit.

Ansa does the same thing without SVG: the run is a `repeating-linear-gradient` of dots, and a
teal copy of those dots sits on top revealed through a narrow moving `mask-image` band. Give
each link an `animation-delay` proportional to its distance from the source so the
brightness crosses the network in the direction a call actually travels. A dot riding each
line — the obvious first instinct — reads as beads on strings and is visibly worse.

- Scroll reveals: `@supports (animation-timeline: view())` progressive enhancement —
  visible-by-default, animated where supported. Never hide content behind JS.
- Marquee: two copies of the row, `translateX(-50%)` loop, `animation-play-state: paused`
  on hover, and a `prefers-reduced-motion` kill switch on **all** motion.
- The whole page is a server component; zero client JS beyond the app's existing chrome.
- Buttons: 4px radius, mono or small text, accent fill with `--accent-on` ink for primary,
  hairline ghost for secondary — same feel as the console's own controls.
