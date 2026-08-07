/**
 * Splits a stream of LLM tokens into speakable units.
 *
 * Waiting for a whole reply before synthesising adds the model's full generation time
 * to every turn. Flushing on sentence boundaries lets the first sentence reach the
 * caller while the second is still being written — which matters more here than usual,
 * because measured STT latency already spends the entire budget on its own.
 */
export interface SentenceBuffer {
  /** Returns any complete sentences this token finished, in order. */
  push(token: string): string[];
  /** Whatever is left at end of stream. Empty if the reply ended on a boundary. */
  flush(): string;
}

// A decimal point or an abbreviation must not end a sentence: "1.5 million naira" and
// "Mr. Adeyemi" would otherwise be cut mid-phrase and spoken as two utterances.
const BOUNDARY = /([.!?])(\s+|$)/;
const ABBREVIATION = /(?:\b(?:mr|mrs|ms|dr|prof|no|vs|etc|e\.g|i\.e)|\d)\.$/i;

export const createSentenceBuffer = (): SentenceBuffer => {
  let buffer = "";

  return {
    push(token: string): string[] {
      buffer += token;
      const out: string[] = [];

      for (;;) {
        const match = BOUNDARY.exec(buffer);
        const punctuation = match?.[1];
        if (match === undefined || match === null || punctuation === undefined) break;

        const end = match.index + punctuation.length;
        const candidate = buffer.slice(0, end);
        if (ABBREVIATION.test(candidate.trimEnd())) break;

        const sentence = candidate.trim();
        if (sentence.length > 0) out.push(sentence);
        buffer = buffer.slice(end + (match[2]?.length ?? 0));
      }

      return out;
    },

    flush(): string {
      const rest = buffer.trim();
      buffer = "";
      return rest;
    },
  };
};
