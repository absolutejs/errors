/**
 * Shared fingerprinting + issue-derivation helpers. Lives in its own module so
 * the tracker (`index.ts`) and the ingest path (`ingest.ts`) compute IDENTICAL
 * fingerprints — events grouped client-side-captured vs. ingested must collapse
 * into the same issue. Zero runtime deps (Web Crypto only).
 */

/** Degenerate fingerprint used when hashing is impossible — 16 hex zeros. */
export const FALLBACK_FINGERPRINT = "0".repeat(16);

const stripDigits = (s: string): string => s.replace(/\d+/g, "0");
const stripQuoted = (s: string): string =>
  s.replace(/'[^']*'/g, "'?'").replace(/"[^"]*"/g, '"?"');

const isStackFrame = (line: string): boolean =>
  line.startsWith("at ") ||
  /^(?:[^@]*@)?(?:https?|file|blob|webpack):\/\/.+(?::\d+){1,2}$/u.test(line);

/** First "user" stack frame — supports V8 and WebKit/Firefox formats. */
const firstStackFrame = (stack: string | undefined): string => {
  if (stack === undefined) return "";
  for (const line of stack.split("\n")) {
    const trimmed = line.trim();
    if (isStackFrame(trimmed)) return trimmed;
  }
  return "";
};

const normalizeMessage = (message: string): string =>
  stripQuoted(stripDigits(message)).slice(0, 200);
const displayMessage = (message: string): string =>
  stripQuoted(message).slice(0, 200);

/**
 * Derive a human-readable issue title from a `(name, message)`. Quoted values
 * are removed for privacy, but meaningful digits such as HTTP status classes
 * remain visible. Fingerprint normalization is deliberately separate below.
 * Exported so store adapters can compute the issue row without reaching into
 * errors' internals.
 */
export const issueTitle = (name: string, message: string): string =>
  (message === "" ? name : `${name}: ${displayMessage(message)}`).slice(0, 300);

/** Derive an issue culprit (top user stack frame) from a stack trace. */
export const issueCulprit = (stack: string | undefined): string =>
  firstStackFrame(stack);

/** The seed string a fingerprint hashes — name | normalized-message | top-frame. */
export const fingerprintSeed = (input: {
  name: string;
  message: string;
  stack?: string;
}): string =>
  [
    input.name,
    normalizeMessage(input.message ?? ""),
    stripDigits(firstStackFrame(input.stack)),
  ].join("|");

/**
 * The default fingerprint — 16-hex-char (64-bit) prefix of SHA-1 over the seed.
 * Used by both the tracker and the ingest endpoint so the two paths group
 * identically.
 */
export const computeFingerprint = async (input: {
  name: string;
  message: string;
  stack?: string;
}): Promise<string> => {
  const hash = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(fingerprintSeed(input)),
  );
  const bytes = new Uint8Array(hash);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex.slice(0, 16);
};
