import type { Server } from "node:http";

// The AWS ALB in front of this service reuses idle connections for up to its
// idle timeout (60 s, infra/aws-server/modules/trace-upload-service
// `alb_idle_timeout_seconds`). AWS: the target's keep-alive timeout must be
// longer than the load balancer's idle timeout, or the ALB sends a request on a
// connection the target has just closed and answers the client with 502.
// Node's default keepAliveTimeout is 5 s. headersTimeout must exceed
// keepAliveTimeout so a reused connection is not cut while its next request's
// headers arrive. Keep both above the ALB value if it is ever raised.
export const ALB_IDLE_TIMEOUT_MS = 60_000;
export const SERVER_KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const SERVER_HEADERS_TIMEOUT_MS = 66_000;

export function applyServerTimeouts(server: Server): Server {
  server.keepAliveTimeout = SERVER_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
  return server;
}
