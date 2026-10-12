import assert from "node:assert/strict";
import net from "node:net";
import pg from "pg";
import { afterEach, test } from "vitest";
import {
  DEFAULT_PG_CONNECT_CONCURRENCY,
  connectPermitWaitMs,
  createConnectGate,
  gatedClientClass,
  resolveConnectConcurrency,
} from "./connectGate";

// A TCP server that accepts connections and never answers the startup packet,
// so every pg handshake stays in progress until the test ends it. It records
// how many handshakes were open at once, which is what Neon's proxy limits.
async function hangingServer() {
  const sockets = new Set<net.Socket>();
  let accepted = 0;
  let maxOpen = 0;
  const server = net.createServer((socket) => {
    accepted += 1;
    sockets.add(socket);
    maxOpen = Math.max(maxOpen, sockets.size);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `postgres://gate-test@127.0.0.1:${port}/none`,
    stats: () => ({ accepted, open: sockets.size, maxOpen }),
    /** Ends the oldest open handshakes, so those connects fail and free their permits. */
    dropOldest(n: number) {
      for (const socket of [...sockets].slice(0, n)) socket.destroy();
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const until = async (check: () => boolean, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("PG_CONNECT_CONCURRENCY defaults to 8 and 0 disables the cap", () => {
  assert.equal(resolveConnectConcurrency({}), DEFAULT_PG_CONNECT_CONCURRENCY);
  assert.equal(resolveConnectConcurrency({ PG_CONNECT_CONCURRENCY: "" }), DEFAULT_PG_CONNECT_CONCURRENCY);
  assert.equal(resolveConnectConcurrency({ PG_CONNECT_CONCURRENCY: "0" }), 0);
  assert.equal(resolveConnectConcurrency({ PG_CONNECT_CONCURRENCY: "3" }), 3);
  assert.equal(resolveConnectConcurrency({ PG_CONNECT_CONCURRENCY: "nope" }), DEFAULT_PG_CONNECT_CONCURRENCY);
  assert.equal(resolveConnectConcurrency({ PG_CONNECT_CONCURRENCY: "-1" }), DEFAULT_PG_CONNECT_CONCURRENCY);
});

test("the gate grants permits in arrival order and reports the wait", async () => {
  let clock = 1_000;
  const gate = createConnectGate(1, () => clock);
  const first = await gate.acquire();
  const order: string[] = [];
  const second = gate.acquire().then((permit) => { order.push("second"); return permit; });
  const third = gate.acquire().then((permit) => { order.push("third"); return permit; });
  assert.deepEqual(gate.state(), { connecting: 1, queued: 2 });

  clock = 1_250;
  first.release();
  first.release(); // a second release must not free another permit
  const secondPermit = await second;
  assert.equal(secondPermit.waitMs, 250);
  assert.deepEqual(gate.state(), { connecting: 1, queued: 1 });

  secondPermit.release();
  (await third).release();
  assert.deepEqual(order, ["second", "third"]);
  assert.deepEqual(gate.state(), { connecting: 0, queued: 0 });
});

test("a pool with the gated client keeps at most N handshakes open at once", async () => {
  const server = await hangingServer();
  cleanups.push(server.close);
  const pool = new pg.Pool({ connectionString: server.url, max: 10, Client: gatedClientClass(createConnectGate(2)) });
  cleanups.push(() => pool.end().catch(() => {}));

  const results = Array.from({ length: 6 }, () => pool.connect().then(() => "ok", () => "failed"));
  await until(() => server.stats().accepted === 2);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(server.stats().accepted, 2, "queued connects must not reach the server");

  // Each failed handshake frees a permit for the next queued connect.
  while (server.stats().accepted < 6) {
    const before = server.stats().accepted;
    server.dropOldest(2);
    await until(() => server.stats().accepted > before);
  }
  server.dropOldest(2);
  assert.deepEqual(await Promise.all(results), Array(6).fill("failed"));
  assert.equal(server.stats().maxOpen, 2);
});

test("cap 0 sends every handshake at once, like plain pg.Pool", async () => {
  const server = await hangingServer();
  cleanups.push(server.close);
  const pool = new pg.Pool({ connectionString: server.url, max: 10, Client: gatedClientClass(createConnectGate(0)) });
  cleanups.push(() => pool.end().catch(() => {}));

  const results = Array.from({ length: 5 }, () => pool.connect().catch(() => undefined));
  await until(() => server.stats().accepted === 5);
  server.dropOldest(5);
  await Promise.all(results);
});

test("a connected client records how long it waited for its permit", async () => {
  const gate = createConnectGate(1);
  const waits: number[] = [];
  const GatedClient = gatedClientClass(gate, (waitMs) => waits.push(waitMs));
  const held = await gate.acquire();
  // An unreachable port makes connect fail right after the permit is granted.
  const client = new GatedClient({ connectionString: "postgres://gate-test@127.0.0.1:1/none" });
  const connecting = client.connect().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 50));
  held.release();
  await connecting;
  assert.equal(waits.length, 1);
  assert.ok(waits[0]! >= 40, `waited ${waits[0]}ms`);
  assert.equal(connectPermitWaitMs(client), waits[0]);
  assert.deepEqual(gate.state(), { connecting: 0, queued: 0 });
});

test("createPool installs the gate (the server's primary and search pools)", async () => {
  const server = await hangingServer();
  cleanups.push(server.close);
  const { createPool } = await import("./index");
  const pool = createPool(server.url, { label: "primary", connectConcurrency: 1 });
  cleanups.push(() => pool.end().catch(() => {}));

  const results = Array.from({ length: 3 }, () => pool.connect().catch(() => undefined));
  await until(() => server.stats().accepted === 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(server.stats().accepted, 1);
  while (server.stats().accepted < 3) {
    const before = server.stats().accepted;
    server.dropOldest(1);
    await until(() => server.stats().accepted > before);
  }
  server.dropOldest(1);
  await Promise.all(results);
  assert.equal(server.stats().maxOpen, 1);
});

test("queued connects fail at their own deadline, without dialing, while the permit holder is still busy", async () => {
  const server = await hangingServer();
  cleanups.push(server.close);
  const gate = createConnectGate(1);
  const pool = new pg.Pool({
    connectionString: server.url,
    max: 10,
    connectionTimeoutMillis: 300,
    Client: gatedClientClass(gate),
  });
  cleanups.push(() => pool.end().catch(() => {}));

  // The only permit is held well past the queued connects' deadline.
  const held = await gate.acquire();
  const startedAt = Date.now();
  const errors = await Promise.all(Array.from({ length: 3 }, () => pool.connect().then(() => null, (err: Error) => err)));
  const elapsedMs = Date.now() - startedAt;
  assert.ok(errors.every((err) => err instanceof Error));
  assert.ok(elapsedMs < 600, `failed after ${elapsedMs}ms; must not wait for the permit holder`);
  assert.deepEqual(gate.state(), { connecting: 1, queued: 0 }, "the timed-out connects left the queue");

  held.release();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(server.stats().accepted, 0);
  assert.deepEqual(gate.state(), { connecting: 0, queued: 0 });
});

test("an aborted acquire leaves the queue without taking a permit", async () => {
  const gate = createConnectGate(1);
  const held = await gate.acquire();
  const controller = new AbortController();
  const waiting = gate.acquire(controller.signal);
  const next = gate.acquire();
  controller.abort(new Error("gone"));
  await assert.rejects(waiting, /gone/);
  assert.deepEqual(gate.state(), { connecting: 1, queued: 1 });
  held.release();
  (await next).release();
  assert.deepEqual(gate.state(), { connecting: 0, queued: 0 });
});
