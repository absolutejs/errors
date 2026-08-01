import { Elysia, StatusMap } from "elysia";

const DEFAULT_MINIMUM_STATUS = 500;
const DEFAULT_TRACE_HEADER = "x-trace-id";
const VALIDATION_STATUS = 422;

type CaptureResult = unknown | Promise<unknown>;

export type ErrorsCaptureContext = {
  tenant?: string;
  target?: string;
  traceId?: string;
  spanId?: string;
  replayId?: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  level?: "fatal" | "error" | "warning" | "info";
};

export type ErrorsServerContext = {
  request: Request;
  path?: string;
  route?: string;
  set?: {
    headers?: Record<string, string | number | readonly string[] | undefined>;
    status?: number | string;
  };
  [key: string]: unknown;
};

export type ErrorsCapture = (
  error: unknown,
  context?: ErrorsCaptureContext,
) => CaptureResult;

export type Returned5xxCaptureInput = {
  context: ErrorsServerContext;
  responseType: string;
  status: number;
};

export type Returned5xxCapturePolicy =
  | boolean
  | ((input: Returned5xxCaptureInput) => boolean | Promise<boolean>);

export type ServerBoundaryOptions = {
  capture: ErrorsCapture;
  context?: (
    context: ErrorsServerContext,
  ) =>
    | ErrorsCaptureContext
    | undefined
    | Promise<ErrorsCaptureContext | undefined>;
  /** Capture unexplained returned 5xx responses. A predicate can exclude
   * intentional control-plane responses such as readiness failures without
   * suppressing thrown or explicitly handled exceptions on the same route. */
  captureReturned5xx?: Returned5xxCapturePolicy;
  minimumStatus?: number;
  onCaptureError?: (error: unknown) => void;
  traceHeader?: string | null;
  traceId?: (context: ErrorsServerContext) => string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const handledErrors = new WeakMap<object, unknown>();

export const handledError = <ResponseValue extends object>(
  response: ResponseValue,
  error: unknown,
) => {
  handledErrors.set(response, error);

  return response;
};

const pathOf = (context: ErrorsServerContext) =>
  context.path ??
  context.route ??
  new URL(context.request.url, "http://localhost").pathname;

const statusFrom = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;

  return (StatusMap as Record<string, number>)[value];
};

const statusOfResponse = (response: unknown, setStatus: unknown) => {
  if (response instanceof Response) return response.status;
  if (isRecord(response)) {
    const responseStatus = statusFrom(response.code);
    if (responseStatus !== undefined) return responseStatus;
  }

  return statusFrom(setStatus) ?? 200;
};

const statusOfError = (error: unknown, code: unknown, setStatus: unknown) => {
  if (isRecord(error)) {
    const errorStatus = statusFrom(error.status);
    if (errorStatus !== undefined) return errorStatus;
  }
  const responseStatus = statusFrom(setStatus);
  if (responseStatus !== undefined && responseStatus >= 400) {
    return responseStatus;
  }

  return code === "VALIDATION" ? VALIDATION_STATUS : DEFAULT_MINIMUM_STATUS;
};

const responseType = (response: unknown) => {
  if (response instanceof Response) return "Response";
  if (response === null) return "null";
  if (Array.isArray(response)) return "array";

  return typeof response;
};

const generatedTraceId = () => crypto.randomUUID().replaceAll("-", "");

const mergeContext = (
  resolved: ErrorsCaptureContext | undefined,
  traceId: string,
  method: string,
  path: string,
  status: number,
  captureKind: "thrown_http_5xx" | "handled_http_5xx" | "returned_http_5xx",
  extra?: Record<string, unknown>,
): ErrorsCaptureContext => ({
  ...resolved,
  extra:
    extra === undefined ? resolved?.extra : { ...resolved?.extra, ...extra },
  level: resolved?.level ?? "error",
  tags: {
    ...resolved?.tags,
    captureKind,
    method,
    path,
    status: String(status),
  },
  target: resolved?.target ?? path,
  traceId: resolved?.traceId ?? traceId,
});

export const mountServerErrorBoundary = (
  app: Elysia,
  options: ServerBoundaryOptions,
) => {
  const minimumStatus = options.minimumStatus ?? DEFAULT_MINIMUM_STATUS;
  const traceHeader =
    options.traceHeader === undefined
      ? DEFAULT_TRACE_HEADER
      : options.traceHeader;
  const captureReturned5xx = options.captureReturned5xx ?? true;
  const traces = new WeakMap<Request, string>();
  const captured = new WeakSet<Request>();

  const reportCaptureFailure = (error: unknown) => {
    try {
      options.onCaptureError?.(error);
    } catch {
      // Observability must never break the request it observes.
    }
  };

  const capture = async (
    error: unknown,
    context: ErrorsServerContext,
    status: number,
    captureKind: "thrown_http_5xx" | "handled_http_5xx" | "returned_http_5xx",
    extra?: Record<string, unknown>,
  ): Promise<void> => {
    const traceId = traces.get(context.request) ?? generatedTraceId();
    const path = pathOf(context);
    try {
      const resolved = await options.context?.(context);
      await options.capture(
        error,
        mergeContext(
          resolved,
          traceId,
          context.request.method,
          path,
          status,
          captureKind,
          extra,
        ),
      );
    } catch (captureError) {
      reportCaptureFailure(captureError);
    }
  };

  return app
    .onRequest((rawContext) => {
      const context = rawContext as unknown as ErrorsServerContext;
      const traceId = options.traceId?.(context) ?? generatedTraceId();
      traces.set(context.request, traceId);
      if (traceHeader !== null && context.set?.headers !== undefined) {
        context.set.headers[traceHeader] = traceId;
      }
    })
    .onError({ as: "global" }, async (rawContext) => {
      const context = rawContext as unknown as ErrorsServerContext & {
        code?: unknown;
        error: unknown;
      };
      const status = statusOfError(
        context.error,
        context.code,
        context.set?.status,
      );
      if (status < minimumStatus || captured.has(context.request)) return;
      captured.add(context.request);
      await capture(context.error, context, status, "thrown_http_5xx");
    })
    .onAfterResponse({ as: "global" }, async (rawContext) => {
      const context = rawContext as unknown as ErrorsServerContext & {
        responseValue?: unknown;
      };
      if (captured.has(context.request)) return;
      const response = context.responseValue;
      const status = statusOfResponse(response, context.set?.status);
      if (status < minimumStatus) return;

      const hasHandledError = isRecord(response) && handledErrors.has(response);
      const returnedResponseType = responseType(response);
      if (!hasHandledError) {
        let shouldCapture: boolean;
        try {
          shouldCapture =
            typeof captureReturned5xx === "function"
              ? await captureReturned5xx({
                  context,
                  responseType: returnedResponseType,
                  status,
                })
              : captureReturned5xx;
        } catch (policyError) {
          reportCaptureFailure(policyError);
          return;
        }
        if (!shouldCapture) return;
      }
      captured.add(context.request);
      const path = pathOf(context);
      const error = hasHandledError
        ? handledErrors.get(response as object)
        : new Error(
            `HTTP ${status} response on ${context.request.method} ${path} completed without a captured exception`,
          );
      await capture(
        error,
        context,
        status,
        hasHandledError ? "handled_http_5xx" : "returned_http_5xx",
        { responseType: returnedResponseType, statusCode: status },
      );
    });
};
