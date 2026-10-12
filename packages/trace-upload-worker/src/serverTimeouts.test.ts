import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import {
  ALB_IDLE_TIMEOUT_MS,
  SERVER_HEADERS_TIMEOUT_MS,
  SERVER_KEEP_ALIVE_TIMEOUT_MS,
  applyServerTimeouts,
} from "./serverTimeouts";

// The public source snapshot ships without infra/aws-server.
const inSourceSnapshot = existsSync(new URL("../../../RELEASE_SOURCE", import.meta.url));

test("keep-alive outlasts the ALB idle timeout and headers timeout outlasts keep-alive", () => {
  const server = applyServerTimeouts(createServer());
  assert.equal(server.keepAliveTimeout, SERVER_KEEP_ALIVE_TIMEOUT_MS);
  assert.equal(server.headersTimeout, SERVER_HEADERS_TIMEOUT_MS);
  assert.ok(server.keepAliveTimeout > ALB_IDLE_TIMEOUT_MS, "Node would close idle connections the ALB still reuses (502)");
  assert.ok(server.headersTimeout > server.keepAliveTimeout, "headersTimeout must exceed keepAliveTimeout");
  server.close();
});

test.skipIf(inSourceSnapshot)("the Terraform ALB idle timeout stays below the server keep-alive", async () => {
  const { readFile } = await import("node:fs/promises");
  const variables = await readFile(
    new URL("../../../infra/aws-server/modules/trace-upload-service/variables.tf", import.meta.url),
    "utf8",
  );
  const block = variables.match(/variable "alb_idle_timeout_seconds" \{[\s\S]*?default\s*=\s*(\d+)/);
  assert.ok(block, "alb_idle_timeout_seconds default not found");
  const albIdleMs = Number(block![1]) * 1000;
  assert.equal(albIdleMs, ALB_IDLE_TIMEOUT_MS, "update ALB_IDLE_TIMEOUT_MS with the Terraform default");
  assert.ok(SERVER_KEEP_ALIVE_TIMEOUT_MS > albIdleMs, "raise the server keep-alive above the new ALB idle timeout");
});

test("the Node entrypoint applies the timeouts to its server", async () => {
  // node.ts starts listening on import, so check the wiring in its source.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./node.ts", import.meta.url), "utf8");
  assert.match(source, /applyServerTimeouts\(server\)/);
});
