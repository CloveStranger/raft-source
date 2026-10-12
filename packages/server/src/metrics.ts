import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";
import express from "express";
import type { TraceDeploymentIdentity } from "./tracing/traceDeploymentIdentity";
import { readBuildIdentityStatus, type BuildIdentityStatus } from "./version";

// Dedicated registry (avoids polluting the global default)
export const register = new Registry();
register.setDefaultLabels({ app: "slock-server" });

export function configureMetricsDeploymentIdentity(identity: TraceDeploymentIdentity) {
  register.setDefaultLabels({
    app: "slock-server",
    service_instance_id: identity.serviceInstanceId,
    deployment_instance_source: identity.deploymentInstanceSource,
    deployment_identity_state: identity.deploymentIdentityState,
    ...(identity.ecsTaskId ? { ecs_task_id: identity.ecsTaskId } : {}),
  });
}

// Collect default Node.js metrics (event loop lag, heap, GC, active handles)
collectDefaultMetrics({ register, prefix: "slock_" });

/**
 * `git_sha` label value: the release commit from RAFT_RELEASE_SHA, or
 * "unknown" when the build identity is missing or invalid (dev, self-hosted).
 * One value per process, so one series per task.
 */
export function releaseShaLabel(status: BuildIdentityStatus): string {
  return status.ok ? status.identity.sha : "unknown";
}

/**
 * Presence marker for the private application metrics endpoint. `git_sha`
 * lets alert rules count the release commits serving at once
 * (#proj-sre:6e643496: more than two for 15 minutes opens a ticket).
 */
export const appMetricsInfo = new Gauge({
  name: "slock_app_metrics_info",
  help: "Constant 1 when the slock-server private application metrics endpoint is exporting metrics",
  labelNames: ["git_sha"] as const,
  registers: [register],
});
appMetricsInfo.set({ git_sha: releaseShaLabel(readBuildIdentityStatus()) }, 1);

// Labels never include caller-supplied service names or Agent/token identifiers.
export const agentJwtIssuanceCounter = new Counter({
  name: "slock_agent_jwt_issuance_total",
  help: "Agent audience JWT issuance outcomes by registered App and finite reason",
  labelNames: ["client_id", "outcome", "reason"] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// Socket.io metrics
// ---------------------------------------------------------------------------

/** Currently connected Socket.io clients */
export const socketConnectedClients = new Gauge({
  name: "slock_socketio_connected_clients",
  help: "Number of currently connected Socket.io clients",
  labelNames: ["transport"] as const,
  registers: [register],
});

/** Total Socket.io disconnections by reason */
export const socketDisconnects = new Counter({
  name: "slock_socketio_disconnects_total",
  help: "Total Socket.io disconnections",
  labelNames: ["reason"] as const,
  registers: [register],
});

/** Total sync:resume attempts and their outcomes */
export const syncResumeTotal = new Counter({
  name: "slock_socketio_sync_resume_total",
  help: "Total sync:resume requests",
  labelNames: ["outcome"] as const, // ok, error, has_more
  registers: [register],
});

// ---------------------------------------------------------------------------
// Redis metrics
// ---------------------------------------------------------------------------

/** Duration of syncMaxSeqFromRedis calls (hottest server→Redis path) */
export const redisSyncDuration = new Histogram({
  name: "slock_redis_sync_duration_seconds",
  help: "Latency of syncMaxSeqFromRedis calls",
  buckets: [0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5],
  registers: [register],
});

/** Total Redis client errors by client name */
export const redisErrors = new Counter({
  name: "slock_redis_errors_total",
  help: "Total Redis client errors",
  labelNames: ["client"] as const, // redis, redis_pub, redis_sub, redis_replica_sub
  registers: [register],
});

/** Redis connection status per client (1=connected, 0=disconnected) */
export const redisConnected = new Gauge({
  name: "slock_redis_connected",
  help: "Redis connection status (1=connected, 0=disconnected)",
  labelNames: ["client"] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// HTTP request metrics
// ---------------------------------------------------------------------------

/**
 * Total HTTP requests observed by the main Express app.
 * Labels intentionally stay low-cardinality so this can be safely expanded on.
 */
export const httpRequestsTotal = new Counter({
  name: "slock_http_requests_total",
  help: "Total HTTP requests handled by the main app",
  labelNames: ["route_pattern", "method", "status_bucket"] as const,
  registers: [register],
});

/**
 * Responses that failed because RisingWave was unavailable: rw_overloaded,
 * rw_unconfigured, rw_read_failed (task #162). They stay 5xx in
 * slock_http_requests_total, so SLO v1 SLI 1 still counts them as unavailable;
 * this counter lets server-bug 5xx alerts subtract them and gives the
 * RisingWave-availability category its own alert. No user or server labels.
 */
export const risingWaveUnavailableResponsesTotal = new Counter({
  name: "slock_risingwave_unavailable_responses_total",
  help: "HTTP responses that failed because RisingWave was unavailable",
  labelNames: ["route_pattern", "code", "retryable"] as const,
  registers: [register],
});

/**
 * End-to-end request duration for the main Express app.
 * Uses the same low-cardinality labels as request totals.
 * The 2 s bucket is the SLO v1 latency threshold (task #431): "share of /api
 * requests done within 2 s" reads le="2" directly.
 */
export const httpRequestDuration = new Histogram({
  name: "slock_http_request_duration_seconds",
  help: "End-to-end HTTP request duration for the main app",
  labelNames: ["route_pattern", "method", "status_bucket"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 2.5, 5, 10],
  registers: [register],
});

/**
 * SLO v1 SLI 4 (task #431): a message reaches the daemon within 60 s.
 * Counted per pending ack record (one per agent:deliver until it settles), not
 * per send, so 5 s ack retries do not inflate the denominator.
 * online_at_first_attempt: the target machine's socket was open on the
 * tracking replica when the record was created. SLI 4 uses "true" only; a
 * record created after a failed first send ("false") is an offline delivery.
 * Records live in replica memory: one that vanishes in a drain has no outcome,
 * so read SLI 4 as acked-within-60s / tracked, never acked / settled.
 * delivery_kind: "mention" for a tracked @mention (the daemon acks it only once
 * the agent has been told, which can wait for the current turn to end),
 * "plain" otherwise (acked on receipt). Split so the two ack semantics can be
 * read apart (task #432).
 */
export const agentDeliveryTrackedTotal = new Counter({
  name: "slock_agent_delivery_tracked_total",
  help: "Agent deliveries that started waiting for a daemon ack",
  labelNames: ["online_at_first_attempt", "delivery_kind", "daemon_version"] as const,
  registers: [register],
});

/**
 * First send to arrival at the daemon, measured from the record's first
 * attempt. Arrival is the daemon ack, or for a tracked mention the earlier
 * `daemon_pending` transition (the daemon has it and waits for the agent to be
 * told; its ack can wait for the end of the current turn). Observed once per
 * record (task #432).
 */
export const agentDeliveryAckSeconds = new Histogram({
  name: "slock_agent_delivery_ack_seconds",
  help: "Time from first agent:deliver attempt to the daemon ack",
  labelNames: ["online_at_first_attempt", "delivery_kind", "daemon_version"] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
  registers: [register],
});

/**
 * How each pending ack record ended: acked, gave_up (ack retries exhausted),
 * dropped (retry gate), routed (handed to the owning replica, which tracks it
 * again), terminal (mention terminal error or identity drift), agent_stopped,
 * converted_to_wake (daemon rejected delivery, server started the agent),
 * replica_shutdown, parked_expired (machine stayed offline past the parked
 * max age, 30 min), held_expired (a mention that reached the daemon was not
 * settled within 30 min; its arrival already counted).
 * conn_age (gave_up and dropped only, "n/a" otherwise): age of this replica's
 * connection to the machine when the record failed: "<1h", "1-6h", ">6h",
 * "none" if the machine is not connected here, or "unknown" for a connection
 * without a recorded connect time (hand-built test connections only).
 */
export const agentDeliveryOutcomesTotal = new Counter({
  name: "slock_agent_delivery_outcomes_total",
  help: "Outcomes of agent deliveries waiting for a daemon ack",
  labelNames: ["outcome", "online_at_first_attempt", "delivery_kind", "conn_age", "daemon_version"] as const,
  registers: [register],
});

type AgentDeliveryPendingCounts = Array<{ parked: boolean; daemonVersion: string; count: number }>;
let agentDeliveryPendingProvider: (() => AgentDeliveryPendingCounts) | null = null;

/** The orchestrator registers its pending-ack map here. */
export function provideAgentDeliveryPending(provider: () => AgentDeliveryPendingCounts): void {
  agentDeliveryPendingProvider = provider;
}

/** Detach on shutdown, only if this provider is still the registered one. */
export function releaseAgentDeliveryPending(provider: () => AgentDeliveryPendingCounts): void {
  if (agentDeliveryPendingProvider === provider) agentDeliveryPendingProvider = null;
}

/**
 * Delivery records currently waiting for a daemon ack on this replica, read at
 * scrape time. parked="true" counts records whose machine went offline; they
 * wait for that machine to re-register here and have no timer of their own.
 * Healthy in-flight is a handful; growth with uptime means records without an
 * outcome (their replica_shutdown count is never scraped).
 */
export const agentDeliveryPending = new Gauge({
  name: "slock_agent_delivery_pending",
  help: "Agent deliveries currently waiting for a daemon ack on this replica",
  labelNames: ["parked", "daemon_version"] as const,
  registers: [register],
  collect() {
    // Reset first: a version with no pending records left must not keep its
    // last value; and with no orchestrator attached (released at shutdown)
    // nothing is exported.
    this.reset();
    const counts = agentDeliveryPendingProvider?.();
    if (!counts) return;
    for (const entry of counts) {
      this.set({ parked: String(entry.parked), daemon_version: entry.daemonVersion }, entry.count);
    }
  },
});

/**
 * `daemon_version` label value: the version the daemon reported, "unknown"
 * when none is known yet, "other" when it is not a plain semver-like string
 * (keeps cardinality to real versions). zhiqiang-zhou (#monitoring-alerts:
 * 1ad4e118): daemon-related metrics carry the real version so SLO rules can
 * exclude old daemons and readbacks can group by version.
 */
export function daemonVersionLabel(version: string | null | undefined): string {
  if (!version) return "unknown";
  return /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,32})?$/.test(version) ? version : "other";
}

/**
 * Machine websocket connections refused by this replica. A refusal never
 * becomes an HTTP request, so it is invisible to the request metrics above.
 * reason="draining": a connection that arrived after the drain started
 * (task #268). Post-deploy readouts report it beside SLO v1 SLI 3.
 */
/**
 * task #365 (RFC 071 terminal-failure breaker, dormant until it is enabled):
 * transitions of the spawn-error pause. `kind`: `spawn_error_counted` (a
 * proven never-created start paused automatic wakes), `retry_dispatched` /
 * `retry_refused` / `retry_error` (the retry sweep re-served a refused wake).
 * How many agents are paused right now is not measured (coverage gap).
 */
export const agentWakePauseTransitionsTotal = new Counter({
  name: "slock_agent_wake_pause_transitions_total",
  help: "Spawn-error wake pause transitions by kind",
  labelNames: ["kind"] as const,
  registers: [register],
});

/**
 * Task #440: cross-replica command routing and the owner lease that backs it.
 * Every label is a closed set (message_type is the protocol's message union).
 */
export const machineCommandRouteTotal = new Counter({
  name: "slock_machine_command_route_total",
  help: "Cross-replica machine command routing attempts by outcome, reason and message type",
  labelNames: ["outcome", "reason", "message_type"] as const,
  registers: [register],
});

export const machineOwnerRefreshTotal = new Counter({
  name: "slock_machine_owner_refresh_total",
  help: "Machine owner lease refreshes by the replica holding the socket, by trigger and result",
  labelNames: ["trigger", "result"] as const,
  registers: [register],
});

/**
 * Task #374: a live machine socket on this replica whose owner-lease refresh is
 * refused while another replica keeps renewing the lease, i.e. the same machine
 * key is connected twice. Counted once per connection. Observation only: no
 * connection is closed because of it yet.
 */
export const machineDuplicateConnectionsTotal = new Counter({
  name: "slock_machine_duplicate_connections_total",
  help: "Machine sockets that keep losing the owner lease to another replica that keeps renewing it, by daemon version",
  labelNames: ["daemon_version"] as const,
  registers: [register],
});

/**
 * Task #374 enforcement (behind SLOCK_MACHINE_DUPLICATE_CONNECTION_ENFORCEMENT):
 * `closed_older` when the refused older socket is closed, `refused_held` when a
 * new connection is refused because the winner still holds the key. A refused
 * connection has not sent `ready`, so `daemon_version` on `refused_held` is the
 * version of the connection that was closed as the duplicate (nearly always
 * the one reconnecting).
 */
export const machineDuplicateConnectionActionsTotal = new Counter({
  name: "slock_machine_duplicate_connection_actions_total",
  help: "Duplicate machine connection enforcement: older sockets closed and reconnects refused while the winner holds the key",
  labelNames: ["action", "daemon_version"] as const,
  registers: [register],
});

export const machineConnectionsRefusedTotal = new Counter({
  name: "slock_machine_connections_refused_total",
  help: "Machine websocket connections refused by this replica",
  labelNames: ["reason", "daemon_version"] as const,
  registers: [register],
});

/**
 * Machine websocket connections that ended on this replica, once per
 * connection: the stale or duplicate disconnect that follows for the same
 * socket (e.g. heartbeat_timeout, then socket_close) is not counted. Answers
 * "why does this machine reconnect so often" from AMP; until now the close
 * code was only in a log line that is not kept in full (#440,
 * #proj-o11y:d32a682c). daemon_version is "unknown" when the connection
 * closed before the daemon's `ready` was processed.
 */
export const machineDisconnectsTotal = new Counter({
  name: "slock_machine_disconnects_total",
  help: "Machine websocket connections that ended on this replica, by cause, close code, shutdown reason, daemon version and connection age",
  labelNames: ["cause", "close_code", "shutdown_reason", "daemon_version", "conn_age"] as const,
  registers: [register],
});

/** Websocket close code as a closed label set: the standard 1000–1015, our own 4000–4099, "none" when the socket sent no close, anything else "other". */
export function machineCloseCodeLabel(code: number | undefined): string {
  if (code === undefined) return "none";
  if (Number.isInteger(code) && ((code >= 1000 && code <= 1015) || (code >= 4000 && code <= 4099))) return String(code);
  return "other";
}

/**
 * How long a machine connection lived when it ended. Fine under 10 minutes,
 * where reconnect loops are: a proxy's fixed idle or maximum-connection
 * timeout shows as one bucket standing out (NotZZ saw 30 s, 90 s, 140 s).
 */
export function machineConnectionLifetimeLabel(
  lifetimeMs: number | undefined,
): "unknown" | "<30s" | "30-60s" | "1-2m" | "2-5m" | "5-10m" | "10-60m" | "1-6h" | ">6h" {
  if (lifetimeMs === undefined || !Number.isFinite(lifetimeMs)) return "unknown";
  if (lifetimeMs < 30_000) return "<30s";
  if (lifetimeMs < 60_000) return "30-60s";
  if (lifetimeMs < 120_000) return "1-2m";
  if (lifetimeMs < 300_000) return "2-5m";
  if (lifetimeMs < 600_000) return "5-10m";
  if (lifetimeMs < 3_600_000) return "10-60m";
  if (lifetimeMs < 6 * 3_600_000) return "1-6h";
  return ">6h";
}

/**
 * Raw Slack Events API requests are registered before express.json() so their
 * signature-sensitive body stays byte-for-byte intact. That also puts them
 * before the general request-observability middleware. Keep a dedicated,
 * low-cardinality counter here so an operator can distinguish provider
 * non-delivery from a request rejected before durable ingress without logging
 * the body, signature, token, provider event ID, or internal row IDs.
 *
 * Each request records one `arrival` observation and one terminal observation.
 * `delivery` records only whether Slack retry headers were present; their
 * values are intentionally never labels.
 */
export const slackBridgeIngressObservationsTotal = new Counter({
  name: "slock_slack_bridge_ingress_observations_total",
  help: "Slack Events API ingress observations by closed stage, outcome, and retry-header presence",
  labelNames: ["stage", "outcome", "delivery"] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// Database pool metrics
// ---------------------------------------------------------------------------

export const dbPoolConnections = new Gauge({
  name: "slock_db_pool_connections",
  help: "PostgreSQL pool connections by pool and state",
  labelNames: ["pool", "state"] as const, // total, idle
  registers: [register],
});

export const dbPoolWaitingRequests = new Gauge({
  name: "slock_db_pool_waiting_requests",
  help: "Requests waiting for a PostgreSQL pool connection",
  labelNames: ["pool"] as const,
  registers: [register],
});

// Time a new connection waited for a connect permit before its handshake
// started (db/connectGate.ts). Most observations are 0; a non-zero tail means
// the per-pool cap on concurrent handshakes delayed requests.
export const dbPoolConnectPermitWait = new Histogram({
  name: "slock_db_pool_connect_permit_wait_seconds",
  help: "Time a new PostgreSQL connection waited for a connect permit",
  labelNames: ["pool"] as const,
  buckets: [0.001, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register],
});

export const pgPoolReadOnlyClientRecycledTotal = new Counter({
  name: "slock_pg_pool_read_only_client_recycled_total",
  help: "Postgres pool clients destroyed after SQLSTATE 25006/read-only transaction errors",
  labelNames: ["pool"] as const,
  registers: [register],
});

// Labels stay bounded on purpose: `statement` is the leading SQL keyword class
// (select/insert/update/delete/transaction/unknown), never SQL text or a hash.
// Per-query detail lives in the server.db.connection trace span.
export const dbQueryDuration = new Histogram({
  name: "slock_db_query_duration_seconds",
  help: "PostgreSQL statement round trip by pool and statement kind",
  labelNames: ["pool", "statement"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30],
  registers: [register],
});

export const dbQueryErrorsTotal = new Counter({
  name: "slock_db_query_errors_total",
  help: "PostgreSQL statement failures by pool and bounded SQLSTATE (57014 = statement timeout or cancel)",
  labelNames: ["pool", "sqlstate"] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// Read-mutation worker metrics
// ---------------------------------------------------------------------------

/** Fair-worker drain cycles, including otherwise invisible empty polls. */
export const readMutationWorkerDrainsTotal = new Counter({
  name: "slock_read_mutation_worker_drains_total",
  help: "Read-mutation fair-worker drain cycles by closed outcome",
  labelNames: ["outcome"] as const, // empty, processed, failed, error
  registers: [register],
});

/** End-to-end duration of each fair-worker drain cycle. */
export const readMutationWorkerDrainDuration = new Histogram({
  name: "slock_read_mutation_worker_drain_duration_seconds",
  help: "End-to-end duration of read-mutation fair-worker drain cycles",
  labelNames: ["outcome"] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
});

/**
 * Requests from pre-frontier clients for which Done snapshots the current
 * canonical content frontier at admission. This is the retirement signal for
 * the temporary backwards-compatibility branch.
 */
export const legacyDoneFrontierFallbacksTotal = new Counter({
  name: "slock_legacy_done_frontier_fallbacks_total",
  help: "Done admissions that defaulted an omitted frontier to the current canonical latest",
  labelNames: ["target_kind"] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// Attachment lifecycle / GC metrics
// ---------------------------------------------------------------------------

export const attachmentLifecycleSweepsTotal = new Counter({
  name: "slock_attachment_lifecycle_sweeps_total",
  help: "Attachment lifecycle sweep attempts by closed outcome",
  labelNames: ["outcome"] as const,
  registers: [register],
});

export const attachmentLifecycleGcOutcomesTotal = new Counter({
  name: "slock_attachment_lifecycle_gc_outcomes_total",
  help: "Attachment object GC lease outcomes",
  labelNames: ["outcome"] as const,
  registers: [register],
});

export const attachmentLifecycleGcJobs = new Gauge({
  name: "slock_attachment_lifecycle_gc_jobs",
  help: "Current attachment object GC jobs by durable state",
  labelNames: ["state"] as const,
  registers: [register],
});

export const attachmentLifecycleGcOldestPendingSeconds = new Gauge({
  name: "slock_attachment_lifecycle_gc_oldest_pending_seconds",
  help: "Age in seconds of the oldest non-completed attachment object GC job",
  registers: [register],
});

// ---------------------------------------------------------------------------
// ScopeDB typed trace-event sink metrics
// ---------------------------------------------------------------------------

/** Whether the direct ScopeDB trace-event sink is enabled for this process. */
export const scopeDbTraceSinkEnabled = new Gauge({
  name: "slock_scopedb_trace_sink_enabled",
  help: "Whether the direct ScopeDB trace-event sink is enabled (1) or disabled (0)",
  registers: [register],
});

/** Number of typed trace rows currently waiting in the direct ScopeDB sink. */
export const scopeDbTraceSinkQueueRows = new Gauge({
  name: "slock_scopedb_trace_sink_queue_rows",
  help: "Typed trace rows currently queued for the direct ScopeDB sink",
  registers: [register],
});

/** Direct ScopeDB sink flush attempts by closed outcome. */
export const scopeDbTraceSinkFlushesTotal = new Counter({
  name: "slock_scopedb_trace_sink_flushes_total",
  help: "Direct ScopeDB trace-event sink flush attempts",
  labelNames: ["outcome"] as const, // success, error
  registers: [register],
});

/** Typed rows accepted by ScopeDB after a successful direct-sink flush. */
export const scopeDbTraceSinkRowsExportedTotal = new Counter({
  name: "slock_scopedb_trace_sink_rows_exported_total",
  help: "Typed trace rows exported successfully by the direct ScopeDB sink",
  registers: [register],
});

/** Typed rows dropped by the direct ScopeDB sink, grouped by a closed reason. */
export const scopeDbTraceSinkRowsDroppedTotal = new Counter({
  name: "slock_scopedb_trace_sink_rows_dropped_total",
  help: "Typed trace rows dropped by the direct ScopeDB sink",
  labelNames: ["reason"] as const, // queue_full, export_error
  registers: [register],
});

/** Unix timestamp of the most recent successful direct-sink flush. */
export const scopeDbTraceSinkLastSuccessTimestamp = new Gauge({
  name: "slock_scopedb_trace_sink_last_success_timestamp_seconds",
  help: "Unix timestamp of the most recent successful direct ScopeDB sink flush",
  registers: [register],
});

/** Unix timestamp of the most recent failed direct-sink flush. */
export const scopeDbTraceSinkLastErrorTimestamp = new Gauge({
  name: "slock_scopedb_trace_sink_last_error_timestamp_seconds",
  help: "Unix timestamp of the most recent failed direct ScopeDB sink flush",
  registers: [register],
});

// ---------------------------------------------------------------------------
// S3/R2 storage metrics
// ---------------------------------------------------------------------------

export const s3PutRequestsTotal = new Counter({
  name: "slock_s3_put_requests_total",
  help: "Total S3-compatible storage PutObject attempts",
  labelNames: ["bucket", "endpoint_host", "outcome"] as const,
  registers: [register],
});

export const s3PutDuration = new Histogram({
  name: "slock_s3_put_duration_seconds",
  help: "Latency of S3-compatible storage PutObject calls",
  labelNames: ["bucket", "endpoint_host", "outcome"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
});

// Seconds since each machine of the configured server last heartbeated
// (services/machineLivenessMetrics.ts). Scoped to one server, so about 40
// series per task.
export const machineHeartbeatAgeSeconds = new Gauge({
  name: "slock_machine_heartbeat_age_seconds",
  help: "Seconds since the machine last heartbeated, for machines of MACHINE_LIVENESS_METRICS_SERVER_ID",
  labelNames: ["machine_id"] as const,
  registers: [register],
});

export const s3SocketPoolSocketsInUse = new Gauge({
  name: "slock_s3_socket_pool_sockets_in_use",
  help: "Busy sockets in the S3-compatible storage HTTP agent",
  labelNames: ["bucket", "endpoint_host"] as const,
  registers: [register],
});

export const s3SocketPoolQueueLength = new Gauge({
  name: "slock_s3_socket_pool_queue_length",
  help: "Queued requests waiting for a socket in the S3-compatible storage HTTP agent",
  labelNames: ["bucket", "endpoint_host"] as const,
  registers: [register],
});

/**
 * Counts how many times the AWS SDK's @smithy/node-http-handler emitted its own
 * "socket usage at capacity" saturation warning for our S3 client. The SDK
 * fires this once-per-15s when sockets-in-use >= maxSockets AND queued
 * requests >= 2*maxSockets — i.e. the canonical "we are about to start
 * stalling" threshold the SDK author considered alert-worthy. This counter
 * is the dedicated alert signal: spikes mean we are racing the request rate
 * against the pool, regardless of whether each individual PutObject still
 * eventually completes.
 *
 * Per-put gauges (`s3_socket_pool_sockets_in_use` / `_queue_length`) describe
 * point-in-time state; this counter describes incident-threshold crossings.
 *
 * stdrc 2026-05-08 #engineering:dfe362e7 ("把tracing也加上") — observability
 * follow-up to PR #1457's hotfix.
 */
export const s3SocketPoolSaturationTotal = new Counter({
  name: "slock_s3_socket_pool_saturation_total",
  help: "Times the SDK socket pool saturation warning has fired for the S3-compatible storage client",
  labelNames: ["bucket", "endpoint_host"] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// Metrics HTTP server
// ---------------------------------------------------------------------------

const METRICS_PORT = Number(process.env.METRICS_PORT) || 9091;

export function startMetricsServer() {
  const app = express();

  app.get("/metrics", async (_req, res) => {
    try {
      res.set("Content-Type", register.contentType);
      res.end(await register.metrics());
    } catch (err) {
      res.status(500).end(String(err));
    }
  });

  app.listen(METRICS_PORT, "0.0.0.0", () => {
    console.log(`[Metrics] Prometheus endpoint on :${METRICS_PORT}/metrics`);
  });
}

/**
 * RFC-067 client product events by outcome: written | gated (user or workspace
 * controls) | unconfigured (no product store) | lost (store accepted fewer) |
 * rejected_<reason> (registry, timestamp, malformed body). decision_support:
 * counts are lower bounds.
 */
export const productEventIngestTotal = new Counter({
  name: "slock_product_event_ingest_total",
  help: "RFC-067 client product events by ingest outcome",
  labelNames: ["outcome"] as const,
  registers: [register],
});

/** RFC 073 durable tasks: lifecycle events per kind (created, succeeded, retry, needs_attention, fenced). */
export const durableTasksTotal = new Counter({
  name: "slock_durable_tasks_total",
  help: "Durable task lifecycle events by kind and closed outcome",
  labelNames: ["kind", "outcome"] as const,
  registers: [register],
});

/** Open durable tasks per kind, and how many of them are overdue (lease expired, not yet recovered). */
export const durableTasksOpenGauge = new Gauge({
  name: "slock_durable_tasks_open",
  help: "Open durable tasks per kind by lease status",
  labelNames: ["kind", "lease"] as const, // lease: active | overdue
  registers: [register],
});
