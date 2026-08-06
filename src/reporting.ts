/** Convert browser Reporting API deliveries into the normal Beacon envelope. */
import type { BeaconEnvelope, BeaconEvent } from "./ingest";

export type BrowserReportingOptions = {
  project: string;
  release?: string;
  environment?: string;
};

type BrowserReport = {
  age?: unknown;
  body?: unknown;
  type?: unknown;
  url?: unknown;
  user_agent?: unknown;
};

const text = (value: unknown, maximum = 200): string | undefined =>
  typeof value === "string" && value.trim() !== ""
    ? value.trim().slice(0, maximum)
    : undefined;

const reportIdentity = (type: string, body: Record<string, unknown>): string =>
  text(body.id) ??
  text(body.effectiveDirective) ??
  text(body["effective-directive"]) ??
  text(body.violatedDirective) ??
  text(body["violated-directive"]) ??
  text(body.reason) ??
  type;

const reportPath = (value: unknown): string => {
  if (typeof value !== "string") return "unknown";
  try {
    const url = new URL(value, "https://errors.invalid");
    return url.pathname || "/";
  } catch {
    return value.replace(/[?#].*$/u, "").slice(0, 200) || "unknown";
  }
};

const reportEvent = (
  report: BrowserReport,
  receivedAt: number,
): BeaconEvent | null => {
  const type = text(report.type, 80);
  if (type === undefined) return null;
  const body =
    report.body !== null && typeof report.body === "object"
      ? (report.body as Record<string, unknown>)
      : {};
  const identity = reportIdentity(type, body);
  const path = reportPath(report.url);
  const age =
    typeof report.age === "number" &&
    Number.isFinite(report.age) &&
    report.age >= 0
      ? report.age
      : 0;
  const crash = type === "crash";

  return {
    at: Math.max(0, receivedAt - age),
    extra: {
      reportBody: body,
      reportDeliveryAgeMs: age,
    },
    groupingKey: `browser-report:${type}:${identity}`,
    level: crash ? "error" : "warning",
    message: crash
      ? `Browser process crashed — ${path}`
      : `Browser report — ${type} ${identity} — ${path}`,
    name: crash ? "BrowserCrash" : "BrowserReport",
    tags: {
      reportIdentity: identity,
      reportType: type,
      signal: crash ? "browser_crash" : "browser_report",
      sourcePath: path,
    },
  };
};

/** Returns null for malformed deliveries and an envelope for valid batches. */
export const browserReportsEnvelope = (
  value: unknown,
  options: BrowserReportingOptions,
  receivedAt = Date.now(),
): BeaconEnvelope | null => {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed)) return null;
  const events = parsed
    .slice(0, 100)
    .map((report) =>
      report !== null && typeof report === "object"
        ? reportEvent(report as BrowserReport, receivedAt)
        : null,
    )
    .filter((event): event is BeaconEvent => event !== null);

  return {
    events,
    project: options.project,
    v: 1,
    ...(options.release === undefined ? {} : { release: options.release }),
    ...(options.environment === undefined
      ? {}
      : { environment: options.environment }),
  };
};
