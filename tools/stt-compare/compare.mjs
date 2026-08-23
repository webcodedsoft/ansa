// Sends ONE recorded call through several transcriber configurations and prints the
// transcripts side by side.
//
// Every provider claim made on this project so far has been a guess, because the audio
// was gone the moment it was transcribed and each comparison used a different call. The
// whole point here is that the waveform is identical across runs, so a difference in the
// output is a difference in the configuration and nothing else.
//
// It deliberately does not pick a winner. It separates these, which is what nobody has
// been able to do:
//
//   same audio, both providers disagree     -> provider or its configuration
//   same audio, both providers agree wrongly -> the audio, i.e. Twilio, encoding or line
//   mu-law vs PCM differ on one provider     -> the transcoding hop, not the model
//
//   node tools/stt-compare/compare.mjs recordings/CAxxxx.ulaw
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const ROOT = new URL("../../", import.meta.url).pathname;
const require = createRequire(`${ROOT}apps/api/package.json`);
const { WebSocket } = require("ws");
const { muLawToPcm } = require(`${ROOT}packages/shared/dist/index.js`);
const { buildUrl } = require(`${ROOT}packages/providers/listen/deepgram/dist/index.js`);

const env = Object.fromEntries(
  readFileSync(`${ROOT}.env`, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

const file = process.argv[2];
if (!file) throw new Error("Pass a .ulaw recording, e.g. recordings/CAxxxx.ulaw");
const audio = readFileSync(file);
console.log(`${file}: ${audio.length} bytes = ${(audio.length / 8000).toFixed(1)}s of mu-law 8kHz\n`);

const FRAME = 160; // 20ms, exactly as the carrier delivers it

// The trailing pad has to sound like a line, not like a file.
//
// 0xff decodes to exactly zero amplitude. No phone call ever contains that: a quiet
// moment on a real line still carries a noise floor. Padding with 0xff measured as a
// difference between providers that does not exist on a call — OpenAI's semantic_vad
// under audio/pcmu emitted speech_started and then never speech_stopped, so the run
// reported "0 turns" for audio it transcribes correctly the moment the pad has a hiss
// in it. A harness that manufactures a provider difference is worse than no harness.
const comfortNoiseFrame = () => {
  const frame = Buffer.alloc(FRAME);
  // mu-law codes just below 0xff are the quietest non-zero levels available.
  for (let i = 0; i < FRAME; i += 1) frame[i] = 0xf0 + Math.floor(Math.random() * 15);
  return frame;
};

// Real time, because a turn detector decides on silence and a burst has none.
const pace = async (send) => {
  for (let i = 0; i < audio.length; i += FRAME) {
    send(audio.subarray(i, i + FRAME));
    await new Promise((r) => setTimeout(r, 20));
  }
  // Trailing quiet, or the last turn never commits.
  for (let i = 0; i < 100; i += 1) {
    send(comfortNoiseFrame());
    await new Promise((r) => setTimeout(r, 20));
  }
};

const openai = ({ asPcm }) =>
  new Promise((resolve) => {
    const finals = [];
    // Why a run produced nothing matters as much as that it did. An empty result can mean
    // the provider heard silence, refused the session, or heard speech and never decided
    // the turn had ended — three different causes with three different fixes, and the
    // first version of this harness reported all of them as "0 turn(s)".
    const notes = [];
    let sawSpeechStart = false;
    // Resolved when the server confirms the format change. See the note at its use.
    let onSessionUpdated;
    const sessionUpdated = new Promise((r) => { onSessionUpdated = r; });
    const ws = new WebSocket("wss://api.openai.com/v1/realtime?intent=transcription", {
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    });
    let settled = false;
    const done = () => {
      // Called by the watchdog, by the post-pace timer and by the error handler, so it
      // has to be idempotent or the diagnostics arrive in duplicate.
      if (settled) return;
      settled = true;
      if (finals.length === 0 && sawSpeechStart) {
        notes.push("speech detected but no turn ever committed — endpointing, not hearing");
      }
      try { ws.close(); } catch { /* gone */ }
      resolve({ finals, notes });
    };
    setTimeout(done, (audio.length / 8000) * 1000 + 25_000);

    ws.on("open", async () => {
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "transcription",
          audio: { input: {
            format: asPcm ? { type: "audio/pcm", rate: 24000 } : { type: "audio/pcmu" },
            transcription: { model: env.TRANSCRIPTION_MODEL ?? "gpt-4o-transcribe", language: "en" },
            turn_detection: { type: "semantic_vad", eagerness: "auto" },
          } },
        },
      }));
      // Wait for the server to confirm the format, do not sleep and hope.
      //
      // A fresh session defaults to audio/pcm at 24kHz. Sleeping 500ms and starting to
      // send made the mu-law run a race: whenever session.updated landed late, 8kHz
      // mu-law bytes were fed to a session still decoding them as 24kHz PCM, the buffer
      // filled with noise, and the run reported zero turns. The PCM run never showed it
      // because there the default already matches what we want — so the harness invented
      // a mu-law-versus-PCM difference that a direct probe could not reproduce. That is
      // precisely the wrong conclusion this tool exists to prevent.
      await Promise.race([sessionUpdated, new Promise((r) => setTimeout(r, 5000))]);
      await pace((frame) => {
        const out = asPcm ? muLawToPcm(frame, 8000, 24000) : frame;
        ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: out.toString("base64") }));
      });
      setTimeout(done, 4000);
    });
    ws.on("message", (raw) => {
      const e = JSON.parse(raw.toString("utf8"));
      if (e.type?.endsWith("input_audio_transcription.completed") && e.transcript) finals.push(e.transcript);
      else if (e.type === "session.updated") {
        const applied = e.session?.audio?.input?.format;
        const want = asPcm ? "audio/pcm" : "audio/pcmu";
        if (applied?.type !== want) notes.push(`server applied ${JSON.stringify(applied)}, asked for ${want}`);
        onSessionUpdated();
      }
      else if (e.type === "input_audio_buffer.speech_started") sawSpeechStart = true;
      // A server-side error arrives as a message, not as a socket error, so without this
      // a rejected session is indistinguishable from a caller who said nothing.
      else if (e.type === "error") notes.push(`server error: ${JSON.stringify(e.error).slice(0, 200)}`);
      else if (e.type?.endsWith("transcription.failed")) notes.push(`transcription failed: ${JSON.stringify(e).slice(0, 200)}`);
    });
    ws.on("error", (e) => { notes.push(`socket error: ${e.message}`); done(); });
  });

const deepgram = ({ keyterms }) =>
  new Promise((resolve) => {
    const finals = [];
    const notes = [];
    let sawSpeechStart = false;
    const url = buildUrl({
      format: { encoding: "mulaw", sampleRate: 8000 },
      model: env.DEEPGRAM_MODEL ?? "flux-general-en",
      keyterms,
      eotThreshold: Number(env.DEEPGRAM_EOT_THRESHOLD ?? 0.8),
      eotTimeoutMs: Number(env.DEEPGRAM_EOT_TIMEOUT_MS ?? 3000),
      host: env.DEEPGRAM_HOST ?? "api.deepgram.com",
    });
    const ws = new WebSocket(url, { headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}` } });
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      if (finals.length === 0 && sawSpeechStart) {
        notes.push("speech detected but no turn ever committed — endpointing, not hearing");
      }
      try { ws.close(); } catch { /* gone */ }
      resolve({ finals, notes });
    };
    setTimeout(done, (audio.length / 8000) * 1000 + 25_000);

    ws.on("open", async () => {
      await pace((frame) => ws.send(frame));
      setTimeout(done, 4000);
    });
    ws.on("message", (raw) => {
      const e = JSON.parse(raw.toString("utf8"));
      if (e.type === "TurnInfo" && e.event === "EndOfTurn" && e.transcript) finals.push(e.transcript);
      else if (e.type === "TurnInfo" && e.event === "StartOfTurn") sawSpeechStart = true;
      else if (e.type === "Error" || e.type === "Fatal") notes.push(`server error: ${JSON.stringify(e).slice(0, 200)}`);
    });
    // A 4401 close is the Bearer/Token mistake and says so in the reason, which is worth
    // printing rather than silently counting as zero turns.
    ws.on("close", (code, reason) => {
      if (code !== 1000 && code !== 1005) notes.push(`closed ${code}: ${reason?.toString() ?? ""}`.trim());
    });
    ws.on("error", (e) => { notes.push(`socket error: ${e.message}`); done(); });
  });

// Intron. Two differences from the others that shape the runner rather than decorate it:
// COMMIT is what produces a transcript and it closes the socket, so a whole recording is
// one connection and one final; and audio is base64 PCM16 in JSON with a 1 KB floor, so
// the carrier's 160-byte frames have to be gathered before they can go.
const intron = ({ language }) =>
  new Promise((resolve) => {
    const finals = [];
    const notes = [];
    const partials = [];
    const pcm = muLawToPcm(audio, 8000, 8000);
    const url =
      `wss://${env.INTRON_HOST ?? "infer.voice.intron.io"}/stt/v1/stream` +
      `?sample_rate=8000&bit_rate=16&num_channels=1&use_language_asr_input=${language}`;
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${env.INTRON_API_KEY}` } });
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      if (finals.length === 0 && partials.length > 0) {
        notes.push(`no committed transcript, but ${partials.length} partial(s) — the last was ${JSON.stringify(partials[partials.length - 1])}`);
      }
      try { ws.close(); } catch { /* gone */ }
      resolve({ finals, notes });
    };
    setTimeout(done, (pcm.length / 16000) * 1000 + 40_000);

    ws.on("message", async (raw) => {
      const e = JSON.parse(raw.toString("utf8"));
      if (e.message_type === "SESSION_CREATED") {
        if (e.configs?.sample_rate !== 8000) {
          notes.push(`asked for 8000 Hz, server applied ${e.configs?.sample_rate}`);
        }
        // 4 KB is eight carrier frames: over the floor, well under the 32 KB ceiling.
        let ack = 0;
        for (let off = 0; off < pcm.length; off += 4096) {
          ws.send(JSON.stringify({
            message_type: "INPUT_AUDIO_CHUNK",
            audio_base_64: pcm.subarray(off, Math.min(off + 4096, pcm.length)).toString("base64"),
            ack_id: (ack += 1),
          }));
          // Eight frames of audio, paced like eight frames of audio.
          await new Promise((r) => setTimeout(r, 160));
        }
        ws.send(JSON.stringify({ message_type: "COMMIT" }));
        return;
      }
      if (e.message_type === "PARTIAL_TRANSCRIPT" && e.transcript) partials.push(e.transcript);
      else if (e.message_type === "COMMITTED_TRANSCRIPT" && e.transcript_text) {
        finals.push(e.transcript_text);
        done();
      } else if (e.message_type === "SESSION_TIME_LIMIT_EXCEEDED") {
        notes.push("hit the 300s session ceiling");
        done();
      } else if (["CHUNK_SIZE_TOO_SMALL", "CHUNK_ID_MISMATCH_WITH_TOTAL", "INPUT_ERROR"].includes(e.message_type)) {
        notes.push(`refused a chunk: ${e.message_type}`);
      }
    });
    ws.on("close", (code, reason) => {
      if (code !== 1000 && code !== 1005) notes.push(`closed ${code}: ${reason?.toString() ?? ""}`.trim());
      done();
    });
    ws.on("error", (e) => { notes.push(`socket error: ${e.message}`); done(); });
  });

/**
 * Common Nigerian given names, as a standing keyterm list.
 *
 * The objection to boosting a caller's name is that it is unknown by definition. That is
 * true of the individual and false of the set: Yoruba, Igbo and Hausa given names are a
 * knowable vocabulary, and "Sikiru" is an ordinary member of it. The question this run
 * answers is whether a list still rescues the name the way one exact term does, or whether
 * it dilutes into the same bias that turned "Sikiru" into "Akiro".
 */
const NIGERIAN_NAMES = [
  "Sikiru", "Adebayo", "Adeyemi", "Chinedu", "Chidinma", "Ngozi", "Emeka", "Obinna",
  "Ifeoma", "Olumide", "Oluwaseun", "Babatunde", "Folake", "Yewande", "Temitope",
  "Abiodun", "Bolanle", "Kehinde", "Taiwo", "Segun", "Funmilayo", "Chukwuemeka",
  "Nnamdi", "Uchenna", "Amaka", "Ekene", "Ibrahim", "Aminu", "Usman", "Hauwa",
  "Fatima", "Zainab", "Musa", "Yusuf", "Aisha", "Halima", "Sadiq", "Bashir",
  "Tunde", "Femi", "Bisi", "Kunle", "Wale", "Seyi", "Damilola", "Oluwatobi",
  "Chiamaka", "Adaeze", "Ifeanyi", "Okonkwo",
];

const KEYTERMS = ["Ansa", "policy", "policy number", "premium", "naira", "claim", "renewal"];

const runs = [
  ["openai mu-law 8k    ", () => openai({ asPcm: false })],
  ["openai pcm 24k      ", () => openai({ asPcm: true })],
  ["deepgram mu-law 8k  ", () => deepgram({ keyterms: [] })],
  ["deepgram + keyterms ", () => deepgram({ keyterms: KEYTERMS })],
  // The caller's own name, boosted. Tested on Deepgram's console first: the same audio
  // that failed without it passed with it. This asks whether that holds here, and whether
  // it survives the domain vocabulary sitting alongside it.
  ["deepgram + the name ", () => deepgram({ keyterms: ["Sikiru"] })],
  ["deepgram name+domain", () => deepgram({ keyterms: ["Sikiru", ...KEYTERMS] })],
  ["deepgram + 50 names ", () => deepgram({ keyterms: NIGERIAN_NAMES })],
  ["deepgram names+domain", () => deepgram({ keyterms: [...NIGERIAN_NAMES, ...KEYTERMS] })],
  ["intron en 8k        ", () => intron({ language: "en" })],
  ["intron pcm 8k       ", () => intron({ language: "pcm" })],
];

const results = [];
for (const [label, run] of runs) {
  process.stdout.write(`${label} … `);
  const { finals, notes } = await run();
  console.log(`${finals.length} turn(s)${notes.length > 0 ? `  [${notes.length} note(s)]` : ""}`);
  results.push([label, finals, notes]);
}

console.log("\n=== transcripts, same audio ===");
for (const [label, finals, notes] of results) {
  console.log(`\n${label.trim()}`);
  if (finals.length === 0) console.log("  (nothing)");
  for (const t of finals) console.log(`  ${JSON.stringify(t)}`);
  for (const n of notes) console.log(`  ! ${n}`);
}

console.log("\n=== how to read this ===");
console.log("  providers disagree        -> provider or its configuration");
console.log("  both wrong the same way   -> the audio: Twilio, encoding, or the line");
console.log("  mu-law vs pcm differ      -> the transcoding hop, not the model");
console.log("  keyterms change a name    -> boosting is biasing, as it did with Ikeja");
console.log("  intron en vs pcm differ   -> the code-switched model, not the audio");
