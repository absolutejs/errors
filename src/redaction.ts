const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_NAMES = new Set([
  "accesstoken",
  "apikey",
  "args",
  "authorization",
  "clientsecret",
  "cookie",
  "csrftoken",
  "idtoken",
  "parameters",
  "params",
  "password",
  "passwd",
  "proxyauthorization",
  "refreshtoken",
  "secret",
  "setcookie",
  "token",
]);
const URL_KEY_NAMES = new Set([
  "endpoint",
  "errorfilename",
  "resourceurl",
  "sourcefile",
  "url",
]);

const normalizeFieldName = (key: string): string =>
  key.replace(/[^a-z0-9]/gi, "").toLowerCase();
const isSensitiveField = (key: string): boolean =>
  SENSITIVE_KEY_NAMES.has(normalizeFieldName(key));
const isUrlField = (key: string): boolean =>
  URL_KEY_NAMES.has(normalizeFieldName(key));

const redactUrl = (value: string): string => {
  try {
    const absolute = /^[a-z][a-z\d+.-]*:/i.test(value);
    const url = new URL(value, "https://errors.invalid");
    url.search = "";
    url.hash = "";
    return absolute ? url.toString() : `${url.pathname}`;
  } catch {
    return value.replace(/[?#].*$/, "");
  }
};

export const redactTelemetryString = (value: string): string =>
  value
    .replace(
      /(^|\n)(\s*params:\s*)[^\n]*/gi,
      (_match, prefix: string, label: string) => `${prefix}${label}${REDACTED}`,
    )
    .replace(
      /\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi,
      (_match, scheme: string) => `${scheme} ${REDACTED}`,
    )
    .replace(
      /([?&](?:access_token|api_?key|authorization|code|id_token|password|refresh_token|secret|token)=)[^&#\s]*/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /\b((?:access_?token|api_?key|authorization|client_?secret|cookie|id_?token|password|passwd|refresh_?token|secret|token)\s*[:=]\s*)(?!Bearer\b|\[REDACTED\])[^,\s;]+/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      REDACTED,
    );

export const redactTelemetryValue = (
  value: unknown,
  key?: string,
  seen = new Set<object>(),
  depth = 0,
): unknown => {
  if (key !== undefined && isSensitiveField(key)) return REDACTED;
  if (typeof value === "string") {
    return redactTelemetryString(
      key !== undefined && isUrlField(key) ? redactUrl(value) : value,
    );
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return String(value);
  if (depth >= 12) return "[Truncated]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const redacted = Array.isArray(value)
    ? value.map((entry) =>
        redactTelemetryValue(entry, undefined, seen, depth + 1),
      )
    : Object.fromEntries(
        Object.entries(value).map(([field, entry]) => [
          field,
          redactTelemetryValue(entry, field, seen, depth + 1),
        ]),
      );
  seen.delete(value);
  return redacted;
};
