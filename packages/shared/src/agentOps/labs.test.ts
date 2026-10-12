import assert from "node:assert/strict";

import { createAgentApiClient, type AgentApiClient } from "../agentApiClient";
import { listLabs, setLabEnrollment, setLabsAccess } from "./index";

type Call = { method: string; path: string; body: unknown };

function client(script: (path: string, init: RequestInit) => Response, calls: Call[] = []): AgentApiClient {
  return createAgentApiClient({
    fetch: {
      baseUrl: "https://raft.example",
      auth: { authorization: "Bearer sk_agent_test" },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        calls.push({ method: init?.method ?? "GET", path: `${url.pathname}${url.search}`, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return script(url.pathname, init ?? {});
      },
    },
  });
}

const LAB = { labKey: "agent-panel-v2", name: "Agent panel v2", description: "The new Agent panel.", state: "open", enrolled: false, effective: false, updatedAt: null };
const LABS = { serverId: "server-1", accessEnabled: true, version: 3, canManageAccess: false, canManageEnrollments: true, labs: [LAB] };
const ENROLLED = { ...LABS, applied: true, auditEventId: "audit-1", version: 4, labs: [{ ...LAB, enrolled: true, effective: true, updatedAt: "2026-10-11T09:30:00.000Z" }] };

test("labs.list renders access, authority and each lab", async () => {
  const listed = await listLabs(client(() => Response.json(LABS)));
  assert.ok(listed.ok);
  assert.equal(listed.text, [
    "Labs access: on (version 3).",
    "You can turn Labs access on or off: no. You can change enrollments: yes.",
    "- agent-panel-v2: Agent panel v2 (open; enrolled: no; in effect: no). The new Agent panel.",
  ].join("\n"));
});

test("a write without expectedVersion reads the current version first; with it, sends straight away", async () => {
  const calls: Call[] = [];
  const api = client((path) => path === "/internal/agent-api/labs" ? Response.json(LABS) : Response.json(ENROLLED), calls);
  const enrolled = await setLabEnrollment(api, { lab: "agent-panel-v2", enabled: true });
  assert.ok(enrolled.ok);
  assert.equal(enrolled.state, "updated");
  assert.match(enrolled.text, /^Enrolled the server in agent-panel-v2\.\nLabs access: on \(version 4\)\./);
  assert.deepEqual(calls.map((call) => [call.method, call.path, call.body]), [
    ["GET", "/internal/agent-api/labs", undefined],
    ["PUT", "/internal/agent-api/labs/agent-panel-v2", { enabled: true, expectedVersion: 3 }],
  ]);

  calls.length = 0;
  await setLabEnrollment(api, { lab: "agent-panel-v2", enabled: true, expectedVersion: 7 });
  assert.deepEqual(calls.map((call) => call.method), ["PUT"]);
});

test("the owner-only refusal and a version conflict come back as the Server's codes", async () => {
  const refused = await setLabsAccess(client(() => Response.json({ error: "Only the server owner can change Labs access", code: "server_owner_required" }, { status: 403 })), { enabled: false, expectedVersion: 3 });
  assert.equal(refused.ok ? null : refused.error.serverCode, "server_owner_required");
  const stale = await setLabsAccess(client(() => Response.json({ error: "Labs changed", code: "server_labs_version_conflict", currentVersion: 5 }, { status: 409 })), { enabled: true, expectedVersion: 3 });
  assert.equal(stale.ok ? null : stale.error.serverCode, "server_labs_version_conflict");
});

test("Labs refusals without a Server next action get the one for their code, in the caller's form", async () => {
  const refuse = (status: number, code: string) => client(() => Response.json({ error: "refused", code }, { status }));
  const cases: Array<[number, string, string]> = [
    [403, "server_owner_required", "Only the server owner can turn Labs access on or off; ask the owner."],
    [409, "server_labs_access_disabled", "Labs access is off for this server; only the owner can turn it on (`labs_set_access`)."],
    [409, "lab_not_open", "This lab is not open for enrollment, so nobody can enroll now. Do not retry."],
    [404, "lab_not_found", "Check the lab key with `labs_list`."],
    [409, "server_labs_version_conflict", "Labs changed while you were working. Run `labs_list`, check the change still makes sense, then retry."],
  ];
  for (const [status, code, nextAction] of cases) {
    const refused = await setLabEnrollment(refuse(status, code), { lab: "agent-panel-v2", enabled: true, expectedVersion: 3 }, { hints: "tool" });
    assert.equal(refused.ok ? null : refused.error.nextAction, nextAction, code);
  }
  const admin = await setLabEnrollment(refuse(403, "server_admin_required"), { lab: "x", enabled: true, expectedVersion: 3 });
  assert.match(admin.ok ? "" : admin.error.nextAction, /^Changing lab enrollment needs the admin or owner role/);

  // The Server's own next action wins.
  const own = await setLabsAccess(client(() => Response.json({ error: "no", code: "server_owner_required", suggestedNextAction: "Ask @tygg." }, { status: 403 })), { enabled: true, expectedVersion: 3 });
  assert.equal(own.ok ? null : own.error.nextAction, "Ask @tygg.");
});
