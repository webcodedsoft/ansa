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

// Real time, because a turn detector decides on silence and a burst has none.
const pace = async (send) => {
  for (let i = 0; i < audio.length; i += FRAME) {
    send(audio.subarray(i, i + FRAME));
    await new Promise((r) => setTimeout(r, 20));
  }
  // Trailing silence, or the last turn never commits.
  for (let i = 0; i < 100; i += 1) {
    send(Buffer.alloc(FRAME, 0xff));
    await new Promise((r) => setTimeout(r, 20));
  }
};

const openai = ({ asPcm }) =>
  new Promise((resolve) => {
    const finals = [];
    const ws = new WebSocket("wss://api.openai.com/v1/realtime?intent=transcription", {
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    });
    const done = () => { try { ws.close(); } catch { /* gone */ } resolve(finals); };
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
      await new Promise((r) => setTimeout(r, 500));
      await pace((frame) => {
        const out = asPcm ? muLawToPcm(frame, 8000, 24000) : frame;
        ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: out.toString("base64") }));
      });
      setTimeout(done, 4000);
    });
    ws.on("message", (raw) => {
      const e = JSON.parse(raw.toString("utf8"));
      if (e.type?.endsWith("input_audio_transcription.completed") && e.transcript) finals.push(e.transcript);
    });
    ws.on("error", (e) => { finals.push(`<error: ${e.message}>`); done(); });
  });

const deepgram = ({ keyterms }) =>
  new Promise((resolve) => {
    const finals = [];
    const url = buildUrl({
      format: { encoding: "mulaw", sampleRate: 8000 },
      model: env.DEEPGRAM_MODEL ?? "flux-general-en",
      keyterms,
      eotThreshold: Number(env.DEEPGRAM_EOT_THRESHOLD ?? 0.8),
      eotTimeoutMs: Number(env.DEEPGRAM_EOT_TIMEOUT_MS ?? 3000),
      host: env.DEEPGRAM_HOST ?? "api.deepgram.com",
    });
    const ws = new WebSocket(url, { headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}` } });
    const done = () => { try { ws.close(); } catch { /* gone */ } resolve(finals); };
    setTimeout(done, (audio.length / 8000) * 1000 + 25_000);

    ws.on("open", async () => {
      await pace((frame) => ws.send(frame));
      setTimeout(done, 4000);
    });
    ws.on("message", (raw) => {
      const e = JSON.parse(raw.toString("utf8"));
      if (e.type === "TurnInfo" && e.event === "EndOfTurn" && e.transcript) finals.push(e.transcript);
    });
    ws.on("error", (e) => { finals.push(`<error: ${e.message}>`); done(); });
  });

const KEYTERMS = ["Ansa", "policy", "policy number", "premium", "naira", "claim", "renewal"];

const runs = [
  ["openai mu-law 8k    ", () => openai({ asPcm: false })],
  ["openai pcm 24k      ", () => openai({ asPcm: true })],
  ["deepgram mu-law 8k  ", () => deepgram({ keyterms: [] })],
  ["deepgram + keyterms ", () => deepgram({ keyterms: KEYTERMS })],
];

const results = [];
for (const [label, run] of runs) {
  process.stdout.write(`${label} … `);
  const finals = await run();
  console.log(`${finals.length} turn(s)`);
  results.push([label, finals]);
}

console.log("\n=== transcripts, same audio ===");
for (const [label, finals] of results) {
  console.log(`\n${label.trim()}`);
  if (finals.length === 0) console.log("  (nothing)");
  for (const t of finals) console.log(`  ${JSON.stringify(t)}`);
}

console.log("\n=== how to read this ===");
console.log("  providers disagree        -> provider or its configuration");
console.log("  both wrong the same way   -> the audio: Twilio, encoding, or the line");
console.log("  mu-law vs pcm differ      -> the transcoding hop, not the model");
console.log("  keyterms change a name    -> boosting is biasing, as it did with Ikeja");
