import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler, Request, Response } from "express";
import { normalizeObservedRoutePattern } from "../middleware/requestObservability";
import { addTraceEvent, errorClassOf, getCurrentTraceContext } from "../tracing/semanticTrace";
import { sanitizeRouteErrorMessage } from "../tracing/routeFailure";
import { DmTargetResolutionError } from "../services/dmTargetResolutionError";
import { RisingWaveNotConfiguredError, RisingWaveOverloadedError, RisingWaveReadError } from "../db/risingwave";
import { setRequestTraceErrorCode } from "../middleware/requestObservability";
import { risingWaveUnavailableResponsesTotal } from "../metrics";

/** Seconds a client should wait before retrying a RisingWave-overloaded read. */
export const RISINGWAVE_OVERLOAD_RETRY_AFTER_SECONDS = 2;

function findRisingWaveOverload(err: unknown): RisingWaveOverloadedError | null {
  for (let current = err, depth = 0; current && depth < 5; depth += 1) {
    if (current instanceof RisingWaveOverloadedError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * The RisingWave pool was saturated (every connection busy past the acquire
 * timeout): a temporary overload, not a server bug. Answer 503 + Retry-After so
 * clients retry and 5xx-bug monitoring does not count it. There is deliberately
 * no Postgres fallback: these reads moved to RisingWave because the Postgres
 * versions are expensive, and shifting them onto the primary during an RW
 * slowdown would turn one incident into two (Tenny, 2026-10-06).
 */
export function respondToRisingWaveOverload(err: unknown, res: Response): boolean {
  const overload = findRisingWaveOverload(err);
  if (!overload) return false;
  res.setHeader("Retry-After", String(RISINGWAVE_OVERLOAD_RETRY_AFTER_SECONDS));
  sendRisingWaveUnavailable(res, {
    status: 503,
    code: "rw_overloaded",
    retryable: true,
    error: "Temporarily overloaded, retry shortly",
    errorClass: "RisingWaveOverloadedError",
  });
  return true;
}

/**
 * The typed RisingWave failure contract (task #162), for routes that adopted
 * it (`GET /api/channels/unread`): overload as above; RisingWave not
 * configured is 503 rw_unconfigured with no Retry-After (retrying will not
 * help); any other RisingWave read failure is 502 rw_read_failed. Everything
 * else returns false and stays the route's 500. Clients treat all three as
 * "not obtained", never as zero.
 */
export function respondToRisingWaveUnavailable(err: unknown, res: Response): boolean {
  if (respondToRisingWaveOverload(err, res)) return true;
  if (err instanceof RisingWaveNotConfiguredError) {
    sendRisingWaveUnavailable(res, {
      status: 503,
      code: "rw_unconfigured",
      retryable: false,
      error: "RisingWave is not configured",
      errorClass: "RisingWaveNotConfiguredError",
    });
    return true;
  }
  if (err instanceof RisingWaveReadError) {
    sendRisingWaveUnavailable(res, {
      status: 502,
      code: "rw_read_failed",
      retryable: true,
      error: "Read failed, retry shortly",
      errorClass: "RisingWaveReadError",
    });
    return true;
  }
  return false;
}

function sendRisingWaveUnavailable(res: Response, response: {
  status: 502 | 503;
  code: "rw_overloaded" | "rw_unconfigured" | "rw_read_failed";
  retryable: boolean;
  error: string;
  errorClass: string;
}): void {
  addTraceEvent(`server.route.${response.code}`, {
    event_kind: "route_error_response",
    outcome: "error",
    reason: response.code,
    http_status: response.status,
    error_class: response.errorClass,
  });
  // Also on the request's own span (server.http.request error_code), so
  // dashboards filter these by column instead of expanding span events.
  setRequestTraceErrorCode(res, response.code);
  risingWaveUnavailableResponsesTotal.inc({
    route_pattern: normalizeObservedRoutePattern(res.req),
    code: response.code,
    retryable: String(response.retryable),
  });
  res.status(response.status).json({
    error: response.error,
    code: response.code,
    retryable: response.retryable,
  });
}

interface JsonServerErrorOptions {
  error: string;
  code?: string;
  status?: number;
  logPrefix: string;
  err: unknown;
}

/**
 * Answer a DM target the caller can fix (ambiguous same-name peer, unknown
 * peer kind) with its 4xx status, stable code and suggestedNextAction. For
 * routes whose catch does not end in sendJsonServerError.
 */
export function respondToDmTargetResolutionError(err: unknown, res: Response): boolean {
  if (!(err instanceof DmTargetResolutionError)) return false;
  res.status(err.status).json(err.toResponseBody());
  return true;
}

/**
 * Body for a send whose transaction lost a deadlock/serialization race on every
 * bounded retry. It rolled back, so resending (same idempotency key) is safe.
 */
export function transientSendConflictBody() {
  return {
    error: "The message was not sent because of a temporary database conflict. Retry the send.",
    code: "send_transient_conflict",
    retryable: true,
    suggestedNextAction: "retry the same send (reuse the idempotencyKey)",
  };
}

export function sendJsonServerError(
  req: Request,
  res: Response,
  options: JsonServerErrorOptions,
): void {
  // A route that wraps channel resolution in a generic catch must still tell
  // the caller how to fix an ambiguous or malformed DM target.
  if (respondToDmTargetResolutionError(options.err, res)) return;
  if (respondToRisingWaveOverload(options.err, res)) return;
  const status = options.status ?? 500;
  const correlationId = getCurrentTraceContext()?.traceId ?? randomUUID();
  const errorClass = errorClassOf(options.err);
  const rawMessage = options.err instanceof Error ? options.err.message : String(options.err ?? "");
  const sanitizedMessage = sanitizeRouteErrorMessage(rawMessage);
  const route = normalizeObservedRoutePattern(req);

  console.error(options.logPrefix, {
    correlationId,
    method: req.method,
    route,
    status,
    errorClass,
    errorMessage: sanitizedMessage,
  });

  addTraceEvent("server.route.error_response", {
    event_kind: "route_error_response",
    outcome: "error",
    reason: "unexpected_server_error",
    http_status: status,
    correlation_id: correlationId,
    error_class: errorClass,
    error_message: sanitizedMessage,
    "http.route": route,
  });

  res.setHeader("X-Slock-Error-Id", correlationId);
  res.status(status).json({
    error: options.error,
    ...(options.code ? { code: options.code } : {}),
    correlationId,
  });
}

export const globalJsonServerErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  // A DM target the caller can fix (ambiguous same-name peer, unknown peer
  // kind): answer with its 4xx status and machine-readable code.
  if (respondToDmTargetResolutionError(err, res)) return;
  if (respondToRisingWaveOverload(err, res)) return;

  const candidateStatus = Number((err as { status?: unknown; statusCode?: unknown } | null)?.status
    ?? (err as { statusCode?: unknown } | null)?.statusCode);
  if (Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus < 500) {
    next(err);
    return;
  }

  const status = Number.isInteger(candidateStatus) && candidateStatus >= 500 && candidateStatus < 600
    ? candidateStatus
    : 500;

  sendJsonServerError(req, res, {
    error: "Internal server error",
    code: "internal_server_error",
    status,
    logPrefix: "[Server] Unhandled route error",
    err,
  });
};
