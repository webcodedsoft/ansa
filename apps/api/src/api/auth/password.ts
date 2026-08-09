import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/**
 * Password hashing on `node:crypto`'s scrypt.
 *
 * Argon2id would be the better choice and needs a native dependency; scrypt is memory-hard
 * in the same way, is in the standard library, and is what OWASP still lists as acceptable
 * at these parameters. If Argon2id is approved later, `PREFIX` and the encoding below are
 * what make the migration a rehash-on-next-sign-in rather than a password reset for every
 * user: the parameters travel with the hash, so old and new coexist.
 *
 * Nothing else in the API hashes anything with a KDF. Session and invitation tokens are
 * 256 bits of randomness and are hashed with SHA-256 — see `tokens.ts` for why that is
 * the right call there and would be the wrong one here.
 */

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const PREFIX = "scrypt";
/** 2^15. About 32MB and ~100ms per hash on the machines this runs on. */
const COST = 32_768;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_BYTES = 64;
const SALT_BYTES = 16;
// Node's default maxmem is 32MB, which is exactly what these parameters need and so it
// throws. Doubling it leaves headroom rather than sitting on the boundary.
const MAX_MEM = 64 * 1024 * 1024;

const derive = (password: string, salt: Buffer, cost: number, blockSize: number, parallelism: number): Promise<Buffer> =>
  scryptAsync(password.normalize("NFKC"), salt, KEY_BYTES, {
    N: cost,
    r: blockSize,
    p: parallelism,
    maxmem: MAX_MEM,
  });

/** `scrypt$N$r$p$salt$key`, all base64. Self-describing, so raising the cost later is safe. */
export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, COST, BLOCK_SIZE, PARALLELISM);
  return [PREFIX, COST, BLOCK_SIZE, PARALLELISM, salt.toString("base64"), key.toString("base64")].join("$");
};

/**
 * A hash to check against when the account does not exist.
 *
 * Without it, "no such email" returns in a millisecond and "wrong password" returns in a
 * hundred, and the difference is a working account-enumeration oracle on an endpoint that
 * anyone may call. Computed once, lazily, so the cost lands on the first sign-in rather
 * than on every process start.
 */
let absentAccount: Promise<string> | null = null;

export const verifyPassword = async (
  stored: string | null,
  password: string,
): Promise<boolean> => {
  if (stored === null) {
    absentAccount ??= hashPassword(randomBytes(32).toString("base64"));
    await verifyPassword(await absentAccount, password);
    return false;
  }

  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== PREFIX) return false;
  const [, cost, blockSize, parallelism, salt, key] = parts as [string, string, string, string, string, string];

  const expected = Buffer.from(key, "base64");
  const actual = await derive(password, Buffer.from(salt, "base64"), Number(cost), Number(blockSize), Number(parallelism));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

/**
 * The rules, such as they are.
 *
 * Length and nothing else, following NIST SP 800-63B: composition rules push people
 * towards `Password1!` and a 12-character minimum buys more than a symbol requirement
 * does. The upper bound exists because scrypt will happily chew through a megabyte of
 * "password" if someone posts one.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;
