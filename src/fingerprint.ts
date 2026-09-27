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

// mktemp deployment roots are not part of a call site's identity. Keep the
// file path beneath the root and leave the original stack/culprit untouched.
const normalizeStackFrame = (frame: string): string =>
  stripDigits(
    frame.replace(
      /(^|[\s(@]|file:\/\/)\/tmp\/tmp\.[A-Za-z0-9_-]+(?=\/)/gu,
      "$1/tmp/tmp.<build>",
    ),
  );

const normalizeMessage = (name: string, message: string): string => {
  // Native member-call TypeErrors can rename the receiver with every minified
  // build. Preserve the property chain and source frame, which identify the
  // actual failed operation. Safari adds an equivalent explanatory suffix.
  const memberCall =
    name === "TypeError"
      ? /^([A-Za-z_$][\w$]*)(\??\.[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*) is not a function(?:\. \(In .* is undefined\))?$/u.exec(
          message,
        )
      : null;
  const stable =
    memberCall === null
      ? message
      : `<receiver>${memberCall[2]} is not a function`;
  return stripQuoted(stripDigits(stable)).slice(0, 200);
};
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

/** The seed string a fingerprint hashes. A caller-supplied semantic grouping
 * key deliberately replaces the volatile error signature; project scoping is
 * still enforced by the issue store. */
export const fingerprintSeed = (input: {
  groupingKey?: string;
  name: string;
  message: string;
  stack?: string;
}): string => {
  if (input.groupingKey !== undefined) {
    return `grouping-key|${input.groupingKey.slice(0, 200)}`;
  }

  return [
    input.name,
    normalizeMessage(input.name, input.message ?? ""),
    normalizeStackFrame(firstStackFrame(input.stack)),
  ].join("|");
};

/**
 * The default fingerprint — 16-hex-char (64-bit) prefix of SHA-1 over the seed.
 * Used by both the tracker and the ingest endpoint so the two paths group
 * identically.
 */
export const computeFingerprint = async (input: {
  groupingKey?: string;
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
