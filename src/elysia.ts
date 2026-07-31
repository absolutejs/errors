/**
 * Server-only Elysia integration for `@absolutejs/errors`.
 *
 * This entry point deliberately does not flow through the package root or any
 * browser entry. It composes the small Effect-free HTTP error boundary with
 * the Effect-backed browser ingest pipeline only on the server.
 */
import {
  errorsElysia,
  handledError,
  type ErrorCaptureContext,
  type ErrorElysiaCapture,
  type ErrorElysiaContext,
  type ErrorsElysiaOptions,
} from "@absolutejs/errors-elysia";
import { Elysia } from "elysia";
import type { ErrorTracker, IssueStore } from "./index";
import { ingestPlugin, type IngestPluginOptions } from "./ingest";

export type ErrorBoundaryContext = ErrorElysiaContext;
export type ErrorBoundaryCapture = ErrorElysiaCapture;
export type ErrorBoundaryPluginOptions = ErrorsElysiaOptions;

/**
 * The low-level, Effect-free request boundary. Use this directly when capture
 * is forwarded elsewhere and no local `ErrorTracker` is available.
 */
export const errorBoundaryPlugin = errorsElysia;

export { errorsElysia, handledError };
export type { ErrorCaptureContext };

export type ErrorsPluginTracker = Pick<
  ErrorTracker,
  "captureException" | "store"
>;

export type ErrorsPluginBoundaryOptions = Omit<
  ErrorBoundaryPluginOptions,
  "capture"
> & {
  /** Override the tracker's capture edge for this HTTP boundary. */
  capture?: ErrorBoundaryCapture;
};

export type ErrorsPluginIngestOptions = Omit<
  IngestPluginOptions,
  "makeElysia" | "store"
> & {
  /** Defaults to the store configured on `tracker`. */
  store?: IssueStore;
};

export type ErrorsPluginOptions = {
  tracker: ErrorsPluginTracker;
  /**
   * Request-error capture settings. Enabled by default; set `false` when this
   * app already has an outer error boundary.
   */
  boundary?: false | ErrorsPluginBoundaryOptions;
  /**
   * Browser-event ingest settings. Omitted/false means no ingest route is
   * opened. Pass an object (often `{}`) to mount it.
   */
  ingest?: false | ErrorsPluginIngestOptions;
};

/**
 * Configure server request capture and browser-event ingest through one
 * Elysia plugin. The ingest route remains opt-in because opening an endpoint
 * is a security-relevant server decision.
 */
export const errorsPlugin = async (options: ErrorsPluginOptions) => {
  const app = new Elysia({ name: "@absolutejs/errors" });

  if (options.boundary !== false) {
    const boundary = options.boundary ?? {};
    app.use(
      errorBoundaryPlugin({
        ...boundary,
        capture: boundary.capture ?? options.tracker.captureException,
      }),
    );
  }

  if (options.ingest !== undefined && options.ingest !== false) {
    const { store: configuredStore, ...ingest } = options.ingest;
    const store = configuredStore ?? options.tracker.store;
    if (store === undefined) {
      throw new Error(
        "@absolutejs/errors errorsPlugin requires ingest.store or a store configured on tracker when ingest is enabled",
      );
    }
    const ingestApp = await ingestPlugin({ ...ingest, store });
    // `ingestPlugin` exposes a framework-light structural return type so its
    // lower-level API can stay lazily coupled to Elysia. Without a custom
    // factory it is guaranteed to return the real Elysia instance used here.
    app.use(ingestApp as Elysia);
  }

  return app;
};
