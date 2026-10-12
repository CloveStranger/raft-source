import assert from "node:assert/strict";

import {
  classifyProfileOpenChunkRequest,
  withProfileOpenEvidence,
} from "./e2e/fixtures/profileOpenEvidence";

type Listener = (value: unknown) => void;

class FakePage {
  readonly handlers = new Map<string, Set<Listener>>();
  startedAt: number | null = null;
  stopped = false;
  hangEvaluations = false;

  on(name: string, listener: Listener) {
    const listeners = this.handlers.get(name) ?? new Set<Listener>();
    listeners.add(listener);
    this.handlers.set(name, listeners);
  }

  off(name: string, listener: Listener) {
    this.handlers.get(name)?.delete(listener);
  }

  emit(name: string, value: unknown) {
    for (const listener of this.handlers.get(name) ?? []) listener(value);
  }

  async evaluate(callback: unknown, argument?: number) {
    if (this.hangEvaluations) return new Promise(() => {});
    const source = String(callback);
    if (source.includes("startProfileOpenTimeline")) {
      this.startedAt = argument ?? null;
      return true;
    }
    if (source.includes("readProfileOpenTimeline")) {
      return {
        schema: "profile-open-browser-timeline",
        version: 1,
        origin: "shared-receipt-start",
        unit: "ms",
        active: true,
        events: [
          { atMs: 1, kind: "avatar-click", avatarKind: "agent", surface: "channel" },
          { atMs: 2, kind: "profile-store-open", profileType: "agent", source: "channel" },
        ],
        truncated: 0,
      };
    }
    if (source.includes("stopProfileOpenTimeline")) {
      this.stopped = true;
      return undefined;
    }
    throw new Error("unexpected evaluate callback");
  }

  get listenerCount() {
    let count = 0;
    for (const listeners of this.handlers.values()) count += listeners.size;
    return count;
  }
}

function fakeRequest(rawUrl: string, failureText?: string) {
  return {
    method: () => "GET",
    url: () => rawUrl,
    failure: () => failureText ? { errorText: failureText } : null,
  };
}

function fakeResponse(request: ReturnType<typeof fakeRequest>, status: number) {
  return { request: () => request, status: () => status };
}

test("chunk matcher returns only the two bounded module labels", () => {
  assert.equal(
    classifyProfileOpenChunkRequest("GET", "http://localhost/assets/ProfilePanel-abc_123.js?token=secret"),
    "profile-panel",
  );
  assert.equal(
    classifyProfileOpenChunkRequest("GET", "http://localhost/assets/AgentDetailPanel-z9-Y.js"),
    "agent-detail",
  );
  assert.equal(
    classifyProfileOpenChunkRequest("GET", "http://localhost/assets/OtherPanel-abc.js"),
    null,
  );
  assert.equal(
    classifyProfileOpenChunkRequest("POST", "http://localhost/assets/ProfilePanel-abc.js"),
    null,
  );
});

test("successful Profile open emits no attachment and removes observers", async () => {
  const page = new FakePage();
  let attachments = 0;

  const result = await withProfileOpenEvidence(
    page as never,
    { retry: 0, attach: async () => { attachments += 1; } } as never,
    "channel-avatar",
    async () => "visible",
  );

  assert.equal(result, "visible");
  assert.equal(attachments, 0);
  assert.equal(page.startedAt !== null, true);
  assert.equal(page.stopped, true);
  assert.equal(page.listenerCount, 0);
});

test("failed Profile open attaches bounded privacy-safe evidence and rethrows the same error", async () => {
  const page = new FakePage();
  const original = new Error("original profile assertion");
  const agentChunk = fakeRequest("http://localhost/assets/AgentDetailPanel-a1.js?token=do-not-record");
  const profileChunk = fakeRequest(
    "http://localhost/assets/ProfilePanel-b2.js?message=also-hidden",
    "net::ERR_CONNECTION_RESET https://private.example/token",
  );
  let attachmentName = "";
  let receipt: Record<string, unknown> | null = null;

  const caught = await withProfileOpenEvidence(
    page as never,
    {
      retry: 0,
      attach: async (name: string, attachment: { body: Buffer }) => {
        attachmentName = name;
        receipt = JSON.parse(attachment.body.toString("utf8"));
      },
    } as never,
    "channel-avatar",
    async () => {
      page.emit("request", agentChunk);
      page.emit("response", fakeResponse(agentChunk, 200));
      page.emit("requestfinished", agentChunk);
      page.emit("request", profileChunk);
      page.emit("requestfailed", profileChunk);
      throw original;
    },
  ).catch((error) => error);

  assert.equal(caught, original);
  assert.equal(attachmentName, "profile-open-channel-avatar.json");
  assert.equal(page.listenerCount, 0);
  assert.equal((receipt?.chunks as unknown[]).length, 2);
  assert.equal((receipt?.chunks as Array<{ chunk: string }>)[0].chunk, "agent-detail");
  assert.equal((receipt?.chunks as Array<{ chunk: string; failureKind?: string }>)[1].failureKind, "connection-reset");
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes("do-not-record"), false);
  assert.equal(serialized.includes("also-hidden"), false);
  assert.equal(serialized.includes("private.example"), false);
  assert.equal(serialized.includes("http://"), false);
});

test("a hung browser diagnostic cannot suppress or replace the product error", async () => {
  const page = new FakePage();
  page.hangEvaluations = true;
  const original = new Error("original profile assertion");
  let actionRan = false;
  let receipt: { browser?: { reason?: string } } | null = null;
  const startedAt = Date.now();

  const caught = await withProfileOpenEvidence(
    page as never,
    {
      retry: 0,
      attach: async (_name: string, attachment: { body: Buffer }) => {
        receipt = JSON.parse(attachment.body.toString("utf8"));
      },
    } as never,
    "channel-avatar",
    async () => {
      actionRan = true;
      throw original;
    },
  ).catch((error) => error);

  assert.equal(actionRan, true);
  assert.equal(caught, original);
  assert.equal(receipt?.browser?.reason, "hook-unavailable");
  assert.ok(Date.now() - startedAt < 1_000, "diagnostic deadline must remain bounded");
  assert.equal(page.listenerCount, 0);
});

test("a rejected attachment cannot replace the product error or skip cleanup", async () => {
  const page = new FakePage();
  const original = new Error("original profile assertion");

  const caught = await withProfileOpenEvidence(
    page as never,
    {
      retry: 0,
      attach: async () => { throw new Error("attachment failed"); },
    } as never,
    "channel-avatar",
    async () => { throw original; },
  ).catch((error) => error);

  assert.equal(caught, original);
  assert.equal(page.stopped, true);
  assert.equal(page.listenerCount, 0);
});

test("a hung attachment cannot suppress or replace the product error", async () => {
  const page = new FakePage();
  const original = new Error("original profile assertion");
  const startedAt = Date.now();

  const caught = await withProfileOpenEvidence(
    page as never,
    {
      retry: 0,
      attach: async () => new Promise(() => {}),
    } as never,
    "channel-avatar",
    async () => { throw original; },
  ).catch((error) => error);

  assert.equal(caught, original);
  assert.ok(Date.now() - startedAt < 1_000, "diagnostic deadline must remain bounded");
  assert.equal(page.stopped, true);
  assert.equal(page.listenerCount, 0);
});
