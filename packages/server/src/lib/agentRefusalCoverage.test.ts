// Every 403 an agent can get from the channel/server admin routes carries a
// `code` and a `suggestedNextAction`: the Raft SDK forwards only those two to
// the model, so a bare `{ error }` reaches the model as a dead end (Sage,
// #raft-antiproton:9a4fe245).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const routesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "routes");
const AGENT_ADMIN_ROUTES = [
  "agentChannelCreate.ts",
  "agentChannelUpdate.ts",
  "agentChannelLifecycle.ts",
  "agentChannelMembers.ts",
  "agentServerManage.ts",
];

test("agent admin route 403s always go through the refusal helpers", async () => {
  for (const file of AGENT_ADMIN_ROUTES) {
    const source = await readFile(path.join(routesDir, file), "utf8");
    const sites = [...source.matchAll(/status: 403,?/g)];
    assert.ok(sites.length > 0, `${file}: expected at least one 403`);
    for (const site of sites) {
      const after = source.slice(site.index!, site.index! + 400);
      assert.match(
        after,
        /^status: 403,?\s*(?:body:\s*)?(?:\{\s*(?:body:\s*)?)?(?:\.\.\.)?(?:await\s+)?(?:agentServerRoleRequiredBody|agentRefusalBody)\(/,
        `${file}: a 403 must use agentServerRoleRequiredBody or agentRefusalBody:\n${after.slice(0, 160)}`,
      );
    }
  }
});
