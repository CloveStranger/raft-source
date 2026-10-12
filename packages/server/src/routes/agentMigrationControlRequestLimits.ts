// Route-scoped request limit for POST /internal/computer/agent-migrations/by-id/:migrationId/resumable/control.
//
// The control manifest may be up to AGENT_MIGRATION_MAX_CONTROL_MANIFEST_BYTES
// (512 KB), but the global 100 KB `express.json()` answered anything larger
// with an HTML 413 before the route ran. One chunk entry is ~120 bytes, so every
// workspace above ~6 GB failed after uploading all of its chunks. This ONE route
// parses up to the manifest limit plus envelope headroom, after computer auth,
// so unauthenticated callers never get a large body parsed.
import type { ErrorRequestHandler } from "express";
import { AGENT_MIGRATION_MAX_CONTROL_MANIFEST_BYTES } from "@botiverse/raft-shared";

export const AGENT_MIGRATION_CONTROL_PATH = "/internal/computer/agent-migrations/by-id/:migrationId/resumable/control";
export const AGENT_MIGRATION_CONTROL_REQUEST_MAX_BYTES = AGENT_MIGRATION_MAX_CONTROL_MANIFEST_BYTES + 64 * 1024;
/** A JSON 413 (not Express's HTML page) so the daemon can classify it. */
export const agentMigrationControlBodyErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if ((err as { type?: unknown } | null)?.type === "entity.too.large") {
    res.status(413).json({
      error: `Migration control request body exceeds ${AGENT_MIGRATION_CONTROL_REQUEST_MAX_BYTES} bytes`,
      code: "migration_control_body_too_large",
      limitBytes: AGENT_MIGRATION_CONTROL_REQUEST_MAX_BYTES,
    });
    return;
  }
  next(err);
};
