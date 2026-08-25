import { inflateRawSync } from "node:zlib";

/**
 * Enough of a ZIP reader to open one file out of a .docx.
 *
 * A Word document is a ZIP holding `word/document.xml`, so reading one needs a ZIP reader and
 * nothing else. The repo already writes ZIPs by hand for the .xlsx export; this is the other
 * direction, and the same reasoning applies — the format is small, stable and documented, and
 * a dependency here would be a supply chain for forty lines of arithmetic.
 *
 * Deliberately partial. It reads the central directory, finds one entry by name, and inflates
 * it. No encryption, no ZIP64, no multi-disk archives, no streaming, because a .docx uses none
 * of them. Anything it cannot handle returns null rather than a wrong answer.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

const STORED = 0;
const DEFLATED = 8;

/** The archive comment length is 16 bits, so the record starts at most 65,557 bytes from the end. */
const MAX_COMMENT = 0xffff;
const EOCD_MIN = 22;

const findEndOfCentralDirectory = (buf: Buffer): number => {
  const earliest = Math.max(0, buf.length - EOCD_MIN - MAX_COMMENT);
  for (let at = buf.length - EOCD_MIN; at >= earliest; at -= 1) {
    if (buf.readUInt32LE(at) === EOCD_SIGNATURE) return at;
  }
  return -1;
};

/**
 * The bytes of one entry, or null if the archive does not hold it.
 *
 * Where the data begins is read from the *local* header rather than the central one. The two
 * agree on the name in a well-formed archive, but each carries its own extra field, and it is
 * the local one that determines the offset of this entry's bytes.
 */
export const readZipEntry = (buf: Buffer, wanted: string): Buffer | null => {
  if (buf.length < EOCD_MIN) return null;

  const eocd = findEndOfCentralDirectory(buf);
  if (eocd === -1) return null;

  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);

  for (let seen = 0; seen < count; seen += 1) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL_SIGNATURE) return null;

    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLength);

    if (name === wanted) {
      if (localAt + 30 > buf.length || buf.readUInt32LE(localAt) !== LOCAL_SIGNATURE) return null;
      const localNameLength = buf.readUInt16LE(localAt + 26);
      const localExtraLength = buf.readUInt16LE(localAt + 28);
      const from = localAt + 30 + localNameLength + localExtraLength;
      const data = buf.subarray(from, from + compressed);

      if (method === STORED) return Buffer.from(data);
      if (method !== DEFLATED) return null;
      try {
        return inflateRawSync(data);
      } catch {
        // A corrupt or unexpectedly encoded entry is a file we cannot read, which is a message
        // for the operator rather than a crash on the server.
        return null;
      }
    }

    at += 46 + nameLength + extraLength + commentLength;
  }

  return null;
};
