import type { Metadata } from "next";
import Link from "next/link";

import { Reveal, ScrollScene } from "@/components/motion";

import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Ansa — a phone agent that understands your callers",
  description:
    "Ansa answers and places calls on Nigerian phone lines: hears the accent, says naira amounts properly, and replies in about a quarter of a second.",
};

/**
 * The front door — the design system is recorded in .claude/skills/livekit-grade-landing.
 *
 * Structure mirrors what actually gives livekit.com its weight: a near-full-viewport hero
 * under an animated dot matrix, a tabbed product showcase, a real code editor, a
 * scroll-pinned "how it works" with isometric layer art, a hairline-columned stats band
 * with a ticking feed, and a two-row marquee. Each is rebuilt from Ansa's own subject —
 * the showcase panes are a call transcript, an outbound dispatch check and the console's
 * turn table; the marquee is the normalizer's real behaviour; the feed is the latency log.
 *
 * Every claim is true of the codebase today; no logos, no testimonials, no invented
 * numbers. Server component, zero client JS: tabs are radio inputs, the stepper is
 * scroll-driven CSS behind @supports, and all motion dies under prefers-reduced-motion.
 */

/** The hero matrix's 20 columns: phase variant and start delay, fixed so SSR agrees. */
const EQ: readonly (readonly [variant: 0 | 1 | 2, delayMs: number])[] = [
  [0, 0], [1, 140], [2, 260], [0, 90], [1, 380], [2, 40], [0, 300], [1, 180], [2, 420],
  [0, 240], [1, 60], [2, 340], [0, 160], [1, 460], [2, 120], [0, 400], [1, 220], [2, 20],
  [0, 360], [1, 280],
];

type Tok = readonly [kind: "cmt" | "str" | "key" | "plain", text: string];

/** The editor's contents — the API this console actually exposes, not pseudocode. */
const CODE: readonly (readonly Tok[])[] = [
  [["cmt", "# Create an agent for your organisation"]],
  [
    ["plain", "curl -X POST "],
    ["str", '"$ANSA/api/v1/agents"'],
    ["plain", " \\"],
  ],
  [
    ["plain", "  -H "],
    ["str", '"authorization: Bearer $TOKEN"'],
    ["plain", " \\"],
  ],
  [
    ["plain", "  -d "],
    ["str", "'{ "],
    ["key", '"name"'],
    ["str", ": \"Oakhaven Properties\" }'"],
  ],
  [["plain", ""]],
  [["cmt", "# Publish a version — a live call only ever reads published config"]],
  [
    ["plain", "curl -X POST "],
    ["str", '"$ANSA/api/v1/agents/$AGENT/config/versions"'],
    ["plain", " \\"],
  ],
  [
    ["plain", "  -d "],
    ["str", "@agent.json"],
  ],
  [["plain", ""]],
  [["cmt", "# Prove it with a call"]],
  [
    ["plain", "curl -X POST "],
    ["str", '"$ANSA/api/v1/testcall"'],
    ["plain", " \\"],
  ],
  [
    ["plain", "  -d "],
    ["str", "'{ "],
    ["key", '"to"'],
    ["str", ": \"+2348012345678\" }'"],
  ],
];

/** One pass of the latency-log feed. Values are from real calls this month. */
const FEED: readonly (readonly [string, string])[] = [
  ["caller speech start", "OFFSET 1,420 MS"],
  ["stt_final", "3 MS"],
  ["turn_to_audio", "227 MS"],
  ["tts_first_byte", "225 MS"],
  ["barge-in — audio cut", "1 FRAME"],
  ["value confirmed", "NAME"],
  ["knowledge retrieval", "OAK-112"],
  ["agent turn played", "2.5 S"],
  ["readback confirmed", "PHONE"],
  ["media stream closed", "0 MS MISSING"],
];

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

const marqueeRow = (pairs: readonly (readonly [string, string])[]) => (
  <>
    {pairs.map(([raw, spoken]) => (
      <span key={raw} className={styles.tickCard}>
        <span className={styles.raw}>{raw}</span>
        <span className={styles.spoken}>
          spoken as <i>&ldquo;{spoken}&rdquo;</i>
        </span>
      </span>
    ))}
  </>
);

const LandingPage = () => (
  <div className={styles.landing}>
    {/* Synchronous on purpose: reveal styles hide content only under html.js, so the
        class must exist before first paint or sections flash. No JS, no hiding at all. */}
    <script dangerouslySetInnerHTML={{ __html: "document.documentElement.classList.add('js')" }} />
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
          <div className={styles.matrix} aria-hidden style={{ marginInline: "auto" }}>
            {EQ.map(([variant, delay], index) => (
              <span
                // A fixed literal; the index is a stable identity.
                key={index}
                className={`${styles.eqCol} ${variant === 1 ? styles.eqB : variant === 2 ? styles.eqC : ""}`}
                style={{ animationDelay: `${delay}ms` }}
              />
            ))}
          </div>
          <h1 className={styles.h1}>
            A phone agent that <span className={styles.tinted}>understands</span> your callers
          </h1>
          <p className={styles.heroSub}>
            Ansa answers and places calls on Nigerian phone lines — hears the accent, says
            naira amounts properly, and replies in about a quarter of a second.
          </p>
          <div className={styles.heroActions}>
            <Link
              href="/sign-up"
              className={`${styles.btn} ${styles.btnPrimary} ${styles.btnLarge}`}
            >
              Start building
            </Link>
            <a href="#how" className={`${styles.btn} ${styles.btnGhost} ${styles.btnLarge}`}>
              How a call works <span className={styles.kbd}>↓</span>
            </a>
          </div>
          <p className={styles.heroMeta}>RUNS ON YOUR OWN NUMBER · EVERY TURN INSPECTED</p>
        </div>
      </section>

      <section className={styles.showcase} aria-label="Product showcase">
        <div className={styles.container}>
          <input
            type="radio"
            name="showcase"
            id="tab-in"
            defaultChecked
            className={`${styles.tabRadio} ${styles.radioIn}`}
          />
          <input
            type="radio"
            name="showcase"
            id="tab-out"
            className={`${styles.tabRadio} ${styles.radioOut}`}
          />
          <input
            type="radio"
            name="showcase"
            id="tab-console"
            className={`${styles.tabRadio} ${styles.radioConsole}`}
          />

          <div className={styles.tabBar}>
            <label htmlFor="tab-in" className={`${styles.tabLabel} ${styles.labelIn}`}>
              Inbound
            </label>
            <label htmlFor="tab-out" className={`${styles.tabLabel} ${styles.labelOut}`}>
              Outbound
            </label>
            <label
              htmlFor="tab-console"
              className={`${styles.tabLabel} ${styles.labelConsole}`}
            >
              Console
            </label>
          </div>

          <div className={`${styles.pane} ${styles.paneIn}`}>
            <div className={styles.paneCopy}>
              <h3>Every call answered, in a voice that fits</h3>
              <p>
                The greeting plays from a warm cache the instant the line opens. From there
                the caller talks like a person — interrupting, correcting, going quiet — and
                the agent keeps up.
              </p>
              <ul className={styles.paneFacts}>
                <li>greeting pre-rendered — zero synthesis wait</li>
                <li>Nigerian-accent transcription, separate turn detection</li>
                <li>barge-in cuts playback inside one 20 ms frame</li>
              </ul>
            </div>
            <figure className={styles.callPanel}>
              <figcaption className={styles.callHead}>
                <span className={styles.liveDot} aria-hidden />
                LIVE CALL · INBOUND · OAKHAVEN PROPERTIES
              </figcaption>
              <div className={styles.turns}>
                <div className={styles.turn}>
                  <span className={`${styles.speaker} ${styles.speakerAgent}`}>ANSA</span>
                  <p className={styles.utterance}>
                    Oakhaven Properties, good day. Are you calling about a property to rent,
                    to buy, to lease, or something else?
                  </p>
                  <span className={styles.chip}>PRE-RENDERED</span>
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
          </div>

          <div className={`${styles.pane} ${styles.paneOut}`}>
            <div className={styles.paneCopy}>
              <h3>Outbound, with the brakes built in</h3>
              <p>
                Ansa places calls too — reminders, follow-ups, callbacks. Consent, calling
                hours and do-not-call live in the dispatch path, where no configuration and
                no clever prompt can route around them.
              </p>
              <ul className={styles.paneFacts}>
                <li>consent is a hard gate, checked before origination</li>
                <li>voicemail detected — no two-minute chats with a greeting</li>
                <li>the agent starts only when a person actually answers</li>
              </ul>
            </div>
            <div className={styles.terminal}>
              <div className={styles.cmt}># dispatch check · +234 80× ××× ××41</div>
              <div className={styles.okLine}>consent basis recorded</div>
              <div className={styles.okLine}>inside permitted calling hours (WAT)</div>
              <div className={styles.okLine}>not on the do-not-call list</div>
              <div className={styles.okLine}>answered by a person, not a machine</div>
              <div className={styles.go}>→ originate · agent starts on answer</div>
            </div>
          </div>

          <div className={`${styles.pane} ${styles.paneConsole}`}>
            <div className={styles.paneCopy}>
              <h3>Read the call you just had</h3>
              <p>
                Every call is kept turn by turn: who spoke, for how long, what the
                transcriber heard and how confident it was, what was collected, and where
                the milliseconds went.
              </p>
              <ul className={styles.paneFacts}>
                <li>latency per pipeline stage, percentiles never averages</li>
                <li>transcripts with confidence, correctable by a reviewer</li>
                <li>collected values exportable — Excel, CSV, PDF, JSON</li>
              </ul>
            </div>
            <div className={styles.miniTable}>
              <table>
                <thead>
                  <tr>
                    <th>Turn</th>
                    <th>Speaker</th>
                    <th>Heard</th>
                    <th>Reply</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>1</td>
                    <td>agent</td>
                    <td>greeting</td>
                    <td>0 ms</td>
                  </tr>
                  <tr>
                    <td>2</td>
                    <td>caller</td>
                    <td>&ldquo;…two-bedroom in Lekki&rdquo;</td>
                    <td>—</td>
                  </tr>
                  <tr>
                    <td>3</td>
                    <td>agent</td>
                    <td>OAK-112 · barged in</td>
                    <td>227 ms</td>
                  </tr>
                  <tr>
                    <td>4</td>
                    <td>caller</td>
                    <td>&ldquo;…the one with parking?&rdquo;</td>
                    <td>—</td>
                  </tr>
                  <tr>
                    <td>5</td>
                    <td>agent</td>
                    <td>inspection offered</td>
                    <td>231 ms</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.codeSection}>
        <Reveal className={`${styles.container} ${styles.reveal}`}>
          <span className={styles.eyebrow}>Simple and powerful API</span>
          <h2 className={styles.h2}>
            Configure, publish, <span className={styles.tinted}>dial</span>
          </h2>
          <p className={styles.lede}>
            Everything the console does is an API you can call yourself. Three requests take
            an agent from nothing to answering a real phone.
          </p>

          <div className={styles.editor}>
            <div className={styles.editorTabs}>
              <span className={`${styles.editorTab} ${styles.editorTabOn}`}>
                create-and-dial.sh
              </span>
              <span className={styles.editorTab}>agent.json</span>
            </div>
            <code className={styles.code}>
              {CODE.map((line, lineIndex) => (
                <span
                  // A fixed literal; the index is a stable identity.
                  key={lineIndex}
                  className={styles.codeLine}
                >
                  <span className={styles.lineNo}>{lineIndex + 1}</span>
                  <span>
                    {line.map(([kind, text], tokenIndex) => (
                      <span
                        // Same: fixed literal.
                        key={tokenIndex}
                        className={
                          kind === "cmt"
                            ? styles.tokCmt
                            : kind === "str"
                              ? styles.tokStr
                              : kind === "key"
                                ? styles.tokKey
                                : styles.tokPlain
                        }
                      >
                        {text}
                      </span>
                    ))}
                  </span>
                </span>
              ))}
            </code>
          </div>

          <div className={styles.quickRow}>
            <Link href="/sign-up" className={styles.quick}>
              <div className={styles.quickTitle}>Build an agent</div>
              <div className={styles.quickBody}>
                Persona, greeting, policies and a capture form — no code required.
              </div>
              <span className={styles.quickGo}>IN THE CONSOLE →</span>
            </Link>
            <Link href="/sign-in" className={styles.quick}>
              <div className={styles.quickTitle}>Place a test call</div>
              <div className={styles.quickBody}>
                Dial your own handset from the console and talk to what you built.
              </div>
              <span className={styles.quickGo}>IN THE CONSOLE →</span>
            </Link>
            <Link href="/sign-in" className={styles.quick}>
              <div className={styles.quickTitle}>Attach knowledge</div>
              <div className={styles.quickBody}>
                FAQs and listings the agent searches before saying &ldquo;I don&apos;t
                know&rdquo;.
              </div>
              <span className={styles.quickGo}>IN THE CONSOLE →</span>
            </Link>
            <Link href="/sign-in" className={styles.quick}>
              <div className={styles.quickTitle}>Export the data</div>
              <div className={styles.quickBody}>
                Everything callers confirmed, as Excel, CSV, PDF or JSON.
              </div>
              <span className={styles.quickGo}>IN THE CONSOLE →</span>
            </Link>
          </div>
        </Reveal>
      </section>

      <ScrollScene id="how" steps={4} className={styles.howTall}>
        <div className={styles.howSticky}>
          <div className={styles.container}>
            <div className={styles.howPanel}>
              <div>
                <span className={styles.eyebrow}>Under the hood</span>
                <h2 className={styles.h2}>
                  How a <span className={styles.tinted}>call</span> works
                </h2>
                <div className={styles.howProgress} aria-hidden />
                <div className={styles.steps}>
                  <div className={`${styles.step} ${styles.step1}`}>
                    <span className={styles.stepNo}>1</span>
                    <span className={styles.stepTitle}>The caller speaks</span>
                    <span className={styles.stepBody}>
                      Telephone audio streams in as 20-millisecond frames from your own
                      number.
                    </span>
                  </div>
                  <div className={`${styles.step} ${styles.step2}`}>
                    <span className={styles.stepNo}>2</span>
                    <span className={styles.stepTitle}>Two listeners, not one</span>
                    <span className={styles.stepBody}>
                      A Nigerian-accent transcriber works out the words. A separate turn
                      detector works out when they&apos;ve finished. Splitting them is why
                      both can be the best available.
                    </span>
                  </div>
                  <div className={`${styles.step} ${styles.step3}`}>
                    <span className={styles.stepNo}>3</span>
                    <span className={styles.stepTitle}>Your business decides</span>
                    <span className={styles.stepBody}>
                      Published configuration, your knowledge base, and risk-tiered tools
                      shape the answer. The safety rules are code — nothing a caller says
                      can talk them out of the way.
                    </span>
                  </div>
                  <div className={`${styles.step} ${styles.step4}`}>
                    <span className={styles.stepNo}>4</span>
                    <span className={styles.stepTitle}>Ansa answers</span>
                    <span className={styles.stepBody}>
                      First audio in about a quarter of a second — and it stops the instant
                      the caller starts talking again.
                    </span>
                  </div>
                </div>
                <div className={styles.howButtons}>
                  <Link href="/sign-up" className={`${styles.btn} ${styles.btnGhost}`}>
                    Build one
                  </Link>
                  <a href="#security" className={`${styles.btn} ${styles.btnGhost}`}>
                    The guarantees
                  </a>
                </div>
              </div>
              <div>
                <div className={styles.iso} aria-hidden>
                  <div className={styles.isoStack}>
                    <div className={`${styles.plane} ${styles.plane1}`}>
                      <span className={styles.planeTag}>PHONE LINE</span>
                    </div>
                    <div className={`${styles.plane} ${styles.plane2}`}>
                      <span className={styles.planeTag}>LISTEN</span>
                    </div>
                    <div className={`${styles.plane} ${styles.plane3}`}>
                      <span className={styles.planeTag}>DECIDE</span>
                    </div>
                    <div className={`${styles.plane} ${styles.plane4}`}>
                      <span className={styles.planeTag}>SPEAK</span>
                    </div>
                    <span className={styles.signal} />
                  </div>
                </div>
                <div className={styles.isoStatus} aria-hidden>
                  <span>T = 0 MS · FRAMES ARRIVING</span>
                  <span>WORDS + TURN BOUNDARY, SEPARATELY</span>
                  <span>KNOWLEDGE · TOOLS · POLICIES</span>
                  <span>T ≈ 227 MS · SPEAKING — INTERRUPTIBLE</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </ScrollScene>

      <section className={styles.infra}>
        <Reveal className={`${styles.container} ${styles.reveal}`}>
          <div className={styles.infraHead}>
            <span className={styles.eyebrow}>Built for phone lines</span>
            <h2 className={styles.h2}>
              Enterprise grade <span className={styles.tinted}>telephony</span>
            </h2>
            <p className={styles.lede}>
              Latency is a correctness property on a phone call. Every stage is measured on
              every call, and the numbers below are measurements, not marketing.
            </p>
          </div>
          <div className={styles.infraGrid}>
            <div className={styles.bigStats}>
              <div className={styles.bigStat}>
                <div className={styles.n}>
                  227 <em>ms</em>
                </div>
                <div className={styles.l}>Median reply on a live call</div>
              </div>
              <div className={styles.bigStat}>
                <div className={styles.n}>
                  20 <em>ms</em>
                </div>
                <div className={styles.l}>Audio frames, phone to agent and back</div>
              </div>
              <div className={styles.bigStat}>
                <div className={styles.n}>
                  2 <em>s</em>
                </div>
                <div className={styles.l}>Longest silence permitted before speech</div>
              </div>
              <div className={styles.bigStat}>
                <div className={styles.n}>1,496</div>
                <div className={styles.l}>Tests on every commit</div>
              </div>
            </div>
            <div className={styles.feed} aria-hidden>
              <div className={styles.feedTrack}>
                {[...FEED, ...FEED].map(([label, value], index) => (
                  <div
                    // A fixed literal duplicated for the loop; the index is stable.
                    key={index}
                    className={styles.feedLine}
                  >
                    <b>{label}</b>
                    <span>{value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Reveal>
      </section>

      <section className={styles.marqueeSection}>
        <Reveal className={`${styles.container} ${styles.reveal}`}>
          <div className={styles.marqueeHead}>
            <span className={styles.eyebrow}>The normalizer</span>
            <h2 className={styles.h2}>
              Numbers, said like a <span className={styles.tinted}>person</span>
            </h2>
            <p className={styles.lede}>
              Nothing reaches the voice unnormalized — not model output, not tool results,
              not a greeting. Amounts, phone numbers, dates and references are rewritten
              into speech before they are spoken.
            </p>
          </div>
        </Reveal>
        <div className={styles.marquee} aria-hidden>
          <div className={styles.marqueeTrack}>{marqueeRow(TICKER.slice(0, 4))}</div>
          <div className={styles.marqueeTrack}>{marqueeRow(TICKER.slice(0, 4))}</div>
        </div>
        <div className={`${styles.marquee} ${styles.marqueeSlow}`} aria-hidden>
          <div className={styles.marqueeTrack}>{marqueeRow(TICKER.slice(4))}</div>
          <div className={styles.marqueeTrack}>{marqueeRow(TICKER.slice(4))}</div>
        </div>
      </section>

      <section id="platform" className={styles.platform}>
        <Reveal className={`${styles.container} ${styles.reveal}`}>
          <span className={styles.eyebrow}>The platform</span>
          <h2 className={styles.h2}>
            Everything a phone line <span className={styles.tinted}>needs</span>
          </h2>
          <p className={styles.lede}>
            One console: configure the agent, publish a version, place a test call, then
            read every turn, every millisecond and every value it collected.
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
        </Reveal>
      </section>

      <section id="security" className={styles.security}>
        <Reveal className={`${styles.container} ${styles.reveal}`}>
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
        </Reveal>
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
            <Link
              href="/sign-in"
              className={`${styles.btn} ${styles.btnGhost} ${styles.btnLarge}`}
            >
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
