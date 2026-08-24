import type { Metadata } from "next";
import Link from "next/link";

import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Ansa — a phone agent that understands your callers",
  description:
    "Ansa answers and places calls on Nigerian phone lines: hears the accent, says naira amounts properly, and replies in about a quarter of a second.",
};

/**
 * The front door.
 *
 * This page replaced a bare redirect to /calls: the console is where existing operators
 * live, but a first visitor got a sign-in form with no explanation of what they were
 * signing into. The design system is recorded in .claude/skills/livekit-grade-landing —
 * dark for everyone, three type voices, one teal, mono for every claim that is a number.
 *
 * Every claim below is true of the codebase today. The 227ms is a measured median from a
 * live call, the transcript mirrors what real calls produce, the ticker strings are what
 * the normalizer actually does, and there are no logos or testimonials because there are
 * no customers to quote yet. When the facts improve, update the page; never the reverse.
 *
 * Server component, no client JS of its own: every animation is CSS, scroll reveals are
 * `animation-timeline: view()` behind @supports, and all of it dies under
 * prefers-reduced-motion.
 */

/** A speech envelope for the hero's dot waveform. Fixed, so server and client agree. */
const WAVE: readonly number[] = [
  12, 18, 30, 44, 62, 78, 88, 74, 58, 66, 82, 92, 70, 48, 36, 52, 68, 84, 96, 80, 60, 42,
  28, 38, 56, 72, 86, 94, 76, 54, 40, 26, 34, 50, 64, 58, 44, 32, 22, 16, 24, 20, 14, 10,
];

/** What the normalizer does to text before anything is spoken. Real behaviour, not ad copy. */
const TICKER: readonly (readonly [string, string])[] = [
  ["₦2,500,000", "two point five million naira"],
  ["+234 813 817 8550", "zero eight one three, eight one seven, eight five five zero"],
  ["OAK-112", "OAK dash one one two"],
  ["₦75,000", "seventy-five thousand naira"],
  ["08:30", "half past eight in the morning"],
  ["14/09/2026", "the fourteenth of September"],
  ["₦1,250,000", "one point two five million naira"],
  ["2:45pm", "two forty-five in the afternoon"],
];

const CARDS: readonly { readonly mark: string; readonly title: string; readonly body: string }[] = [
  {
    mark: "[?]",
    title: "Knowledge that answers",
    body: "Attach FAQs, price lists and property listings. The agent searches them before it ever says it does not know.",
  },
  {
    mark: "[=]",
    title: "Every answer, kept",
    body: "Names, numbers and requests the caller confirms land in a dataset — filter it, then export Excel, CSV, PDF or JSON.",
  },
  {
    mark: "[!]",
    title: "Tools with a safety catch",
    body: "Read tools run freely. Write tools need a spoken readback first. Irreversible ones go to a human — enforced in code, not in a prompt.",
  },
  {
    mark: "[×]",
    title: "Interruptible mid-word",
    body: "Speak over the agent and it stops inside a 20ms frame. Words the caller never heard are dropped from the conversation history.",
  },
  {
    mark: "[→]",
    title: "A person when it matters",
    body: "A caller in distress is transferred to your crisis line, day or night. An angry caller gets a handover, not an argument.",
  },
  {
    mark: "[v]",
    title: "Publish, then dial",
    body: "Configuration is versioned. A live call reads what you published — never a draft, never an experiment.",
  },
];

const LandingPage = () => (
  <div className={styles.landing}>
    <Link href="/sign-in" className={styles.banner}>
      NEW · EXPORT COLLECTED CALL DATA TO EXCEL, PDF AND JSON →
    </Link>

    <header className={styles.nav}>
      <div className={`${styles.container} ${styles.navInner}`}>
        <Link href="/" className={styles.wordmark}>
          ansa<span>.</span>
        </Link>
        <nav className={styles.navLinks} aria-label="Sections">
          <a href="#how">How a call works</a>
          <a href="#platform">Platform</a>
          <a href="#security">Security</a>
        </nav>
        <div className={styles.navSpacer} />
        <Link href="/sign-in" className={`${styles.btn} ${styles.btnGhost}`}>
          Sign in
        </Link>
        <Link href="/sign-up" className={`${styles.btn} ${styles.btnPrimary}`}>
          Start building
        </Link>
      </div>
    </header>

    <main>
      <section className={styles.hero}>
        <div className={styles.container}>
          <div className={styles.wave} aria-hidden>
            {WAVE.map((height, index) => (
              <div
                // The array is a fixed literal, so the index is a stable identity.
                key={index}
                className={styles.waveBar}
                style={{ height: `${height}%`, animationDelay: `${index * 85}ms` }}
              />
            ))}
          </div>

          <h1 className={styles.h1}>
            A phone agent that <span className={styles.tinted}>understands</span> your callers
          </h1>
          <p className={styles.heroSub}>
            Ansa answers and places calls on Nigerian phone lines — hears the accent, says
            naira amounts properly, and replies in about a quarter of a second. Configure it
            in the console. Prove it with a call.
          </p>
          <div className={styles.heroActions}>
            <Link
              href="/sign-up"
              className={`${styles.btn} ${styles.btnPrimary} ${styles.btnLarge}`}
            >
              Start building
            </Link>
            <a href="#how" className={`${styles.btn} ${styles.btnGhost} ${styles.btnLarge}`}>
              See how a call works
            </a>
          </div>
          <p className={styles.heroMeta}>RUNS ON YOUR OWN NUMBER · EVERY TURN INSPECTED</p>

          <figure className={`${styles.callPanel} ${styles.reveal}`}>
            <figcaption className={styles.callHead}>
              <span className={styles.liveDot} aria-hidden />
              LIVE CALL · INBOUND · OAKHAVEN PROPERTIES
            </figcaption>
            <div className={styles.turns}>
              <div className={styles.turn}>
                <span className={`${styles.speaker} ${styles.speakerAgent}`}>ANSA</span>
                <p className={styles.utterance}>
                  Oakhaven Properties, good day. Are you calling about a property to rent, to
                  buy, to lease, or something else?
                </p>
                <span className={styles.chip}>PRE-RENDERED · 0 MS</span>
              </div>
              <div className={styles.turn}>
                <span className={styles.speaker}>CALLER</span>
                <p className={styles.utterance}>
                  Good morning. My name is Sikiru — I&apos;m looking for a two-bedroom in
                  Lekki Phase One.
                </p>
              </div>
              <div className={styles.turn}>
                <span className={`${styles.speaker} ${styles.speakerAgent}`}>ANSA</span>
                <p className={styles.utterance}>
                  Morning, Sikiru. There&apos;s a serviced two-bedroom off Admiralty Way —
                  twenty-four hour power, fitted kitchen, third floor with a lift.{" "}
                  <span className={styles.unheard}>The advertised range is—</span>
                </p>
                <span className={`${styles.chip} ${styles.chipTeal}`}>REPLY IN 227 MS</span>
                <span className={styles.turnNote}>
                  caller interrupted — the unheard words never enter the conversation
                </span>
              </div>
              <div className={styles.turn}>
                <span className={styles.speaker}>CALLER</span>
                <p className={styles.utterance}>Sorry — is that the one with parking?</p>
              </div>
              <div className={styles.turn}>
                <span className={`${styles.speaker} ${styles.speakerAgent}`}>ANSA</span>
                <p className={styles.utterance}>
                  It is. Parking for one car. Should I book you an inspection — Tuesday to
                  Saturday, morning or afternoon?
                </p>
                <span className={styles.chip}>KNOWLEDGE · OAK-112</span>
              </div>
            </div>
          </figure>

          <div className={styles.stats}>
            <div className={styles.stat}>
              <div className={styles.statValue}>
                227 <em>ms</em>
              </div>
              <div className={styles.statLabel}>Median reply, measured live</div>
            </div>
            <div className={styles.stat}>
              <div className={styles.statValue}>
                20 <em>ms</em>
              </div>
              <div className={styles.statLabel}>Audio frames, end to end</div>
            </div>
            <div className={styles.stat}>
              <div className={styles.statValue}>
                2 <em>s</em>
              </div>
              <div className={styles.statLabel}>Longest silence permitted</div>
            </div>
            <div className={styles.stat}>
              <div className={styles.statValue}>1,496</div>
              <div className={styles.statLabel}>Tests on every commit</div>
            </div>
          </div>
        </div>

        <div className={styles.ticker} aria-hidden>
          <div className={styles.tickerTrack}>
            {TICKER.map(([raw, spoken]) => (
              <span key={raw} className={styles.pair}>
                <b>{raw}</b> → <span>&ldquo;{spoken}&rdquo;</span>
              </span>
            ))}
          </div>
          <div className={styles.tickerTrack}>
            {TICKER.map(([raw, spoken]) => (
              <span key={raw} className={styles.pair}>
                <b>{raw}</b> → <span>&ldquo;{spoken}&rdquo;</span>
              </span>
            ))}
          </div>
        </div>
      </section>

      <section id="how" className={`${styles.section} ${styles.reveal}`}>
        <div className={styles.container}>
          <div className={styles.howPanel}>
            <div>
              <span className={styles.eyebrow}>Under the hood</span>
              <h2 className={styles.h2}>
                How a <span className={styles.tinted}>call</span> works
              </h2>
              <div className={styles.steps}>
                <div className={styles.step}>
                  <span className={styles.stepNo}>1</span>
                  <span className={styles.stepTitle}>The caller speaks</span>
                  <span className={styles.stepBody}>
                    Telephone audio streams in as 20-millisecond frames from your own number.
                  </span>
                </div>
                <div className={styles.step}>
                  <span className={styles.stepNo}>2</span>
                  <span className={styles.stepTitle}>Two listeners, not one</span>
                  <span className={styles.stepBody}>
                    A Nigerian-accent transcriber works out the words. A separate turn
                    detector works out when they&apos;ve finished. Splitting them is why both
                    can be the best available.
                  </span>
                </div>
                <div className={styles.step}>
                  <span className={styles.stepNo}>3</span>
                  <span className={styles.stepTitle}>Your business decides</span>
                  <span className={styles.stepBody}>
                    Published configuration, your knowledge base, and risk-tiered tools shape
                    the answer. Nothing a caller says can talk the safety rules out of the
                    way — they are code, not prompt.
                  </span>
                </div>
                <div className={styles.step}>
                  <span className={styles.stepNo}>4</span>
                  <span className={styles.stepTitle}>Ansa answers</span>
                  <span className={styles.stepBody}>
                    First audio in about a quarter of a second — and it stops the instant the
                    caller starts talking again.
                  </span>
                </div>
              </div>
            </div>
            <div className={styles.layers} aria-hidden>
              <div className={styles.layer}>
                PHONE LINE
                <small>your number · 8 kHz telephone audio</small>
              </div>
              <div className={styles.layer}>
                LISTEN
                <small>words + turn boundaries, separately</small>
              </div>
              <div className={`${styles.layer} ${styles.layerAccent}`}>
                DECIDE
                <small>knowledge · tools · policies · guarantees</small>
              </div>
              <div className={styles.layer}>
                SPEAK
                <small>streaming voice, interruptible mid-word</small>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="platform" className={`${styles.section} ${styles.reveal}`}>
        <div className={styles.container}>
          <span className={styles.eyebrow}>The platform</span>
          <h2 className={styles.h2}>
            Everything a phone line <span className={styles.tinted}>needs</span>
          </h2>
          <p className={styles.lede}>
            One console: configure the agent, publish a version, place a test call, then read
            every turn, every millisecond and every value it collected.
          </p>
          <div className={styles.grid}>
            {CARDS.map((card) => (
              <div key={card.title} className={styles.card}>
                <span className={styles.cardIcon} aria-hidden>
                  {card.mark}
                </span>
                <h3 className={styles.cardTitle}>{card.title}</h3>
                <p className={styles.cardBody}>{card.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="security" className={`${styles.section} ${styles.reveal}`}>
        <div className={styles.container}>
          <span className={styles.eyebrow}>Guarantees</span>
          <h2 className={styles.h2}>
            Code, not <span className={styles.tinted}>promises</span>
          </h2>
          <p className={styles.lede}>
            The rules that matter are not instructions the model might follow. They are code
            it cannot argue with.
          </p>
          <dl className={styles.guarantees}>
            <div className={styles.guarantee}>
              <dt>Never reads back a full card number or PIN</dt>
              <dd>
                Tripwired in the prompt layers and enforced again in code, so one clever
                caller cannot talk it into being a payment terminal.
              </dd>
            </div>
            <div className={styles.guarantee}>
              <dt>One organisation cannot read another&apos;s calls</dt>
              <dd>
                Isolation is enforced by the database itself — row-level security, attacked
                by adversarial tests that run in CI on every commit.
              </dd>
            </div>
            <div className={styles.guarantee}>
              <dt>Silence is treated as a failure</dt>
              <dd>
                Every failure path degrades into speech. A tool that hangs, a model that
                stalls, a transcriber that drops — the caller hears words, not dead air.
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <section className={styles.cta}>
        <div className={styles.container}>
          <h2 className={styles.h2}>
            Ready to <span className={styles.tinted}>answer?</span>
          </h2>
          <p className={styles.lede}>
            Configure an agent, publish it, and dial the number. The console shows you
            exactly what happened — turn by turn, millisecond by millisecond.
          </p>
          <div className={styles.ctaActions}>
            <Link
              href="/sign-up"
              className={`${styles.btn} ${styles.btnPrimary} ${styles.btnLarge}`}
            >
              Start building
            </Link>
            <Link href="/sign-in" className={`${styles.btn} ${styles.btnGhost} ${styles.btnLarge}`}>
              Open the console
            </Link>
          </div>
          <p className={styles.ctaMeta}>A SLICE IS DONE WHEN A PHONE CALL PROVES IT</p>
        </div>
      </section>
    </main>

    <footer className={styles.footer}>
      <div className={styles.container}>
        <div className={styles.footerGrid}>
          <div className={styles.footerBrand}>
            <span className={styles.wordmark}>
              ansa<span className={styles.tinted}>.</span>
            </span>
            <p>Voice agents for Nigerian phone lines. Built to be heard, not read.</p>
          </div>
          <div className={styles.footerCol}>
            <h3>Product</h3>
            <a href="#how">How a call works</a>
            <a href="#platform">Platform</a>
            <a href="#security">Security</a>
          </div>
          <div className={styles.footerCol}>
            <h3>Console</h3>
            <Link href="/sign-in">Sign in</Link>
            <Link href="/sign-up">Create an organisation</Link>
            <Link href="/calls">Calls</Link>
            <Link href="/data">Collected data</Link>
          </div>
          <div className={styles.footerCol}>
            <h3>Company</h3>
            <a href="mailto:hello@ansa.ng">Contact</a>
          </div>
        </div>
        <div className={styles.footerBottom}>
          <span>© 2026 ANSA</span>
          <span className={styles.status}>
            <span className={styles.statusDot} aria-hidden />
            MADE FOR NIGERIAN PHONE LINES
          </span>
        </div>
      </div>
    </footer>
  </div>
);

export default LandingPage;
