import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { afterEach, test, vi } from "vitest";
import { z } from "zod";

const CONTRACT_MODULES = ["./agentApiContract", "./agentApiMessageContract", "./daemonApiContract"] as const;

async function importContracts(): Promise<Record<string, unknown>[]> {
  return Promise.all(CONTRACT_MODULES.map((path) => import(path) as Promise<Record<string, unknown>>));
}

function jsonSchemaOf(schema: z.ZodType): unknown {
  try {
    return {
      input: z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
      output: z.toJSONSchema(schema, { io: "output", unrepresentable: "any" }),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// Every exported schema plus every route's request/response parts, keyed by a
// stable path, as JSON Schema. The route parts reach the module-private
// schemas that no export exposes.
function contractJsonSchemas(modules: Record<string, unknown>[]): Map<string, unknown> {
  const out = new Map<string, unknown>();
  modules.forEach((mod, index) => {
    for (const [name, value] of Object.entries(mod)) {
      if (value instanceof z.ZodType) out.set(`${CONTRACT_MODULES[index]}:${name}`, jsonSchemaOf(value));
    }
  });
  const routes = modules[0]!.agentApiContract as Record<string, { request: Record<string, z.ZodType>; response: Record<string, unknown> }>;
  for (const [key, route] of Object.entries(routes)) {
    for (const [part, schema] of Object.entries(route.request)) out.set(`route:${key}:request.${part}`, jsonSchemaOf(schema));
    for (const [part, schema] of Object.entries(route.response)) {
      if (schema instanceof z.ZodType) out.set(`route:${key}:response.${part}`, jsonSchemaOf(schema));
    }
  }
  return out;
}

afterEach(() => {
  vi.doUnmock("./lazySchema");
  vi.resetModules();
});

test("the contract files are fully rewritten by scripts/lazy-contract-schemas.mjs", () => {
  const result = spawnSync(process.execPath, [resolve(__dirname, "../scripts/lazy-contract-schemas.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("importing the contracts builds no schema until one is used", async () => {
  vi.resetModules();
  const [agentApi] = await importContracts();
  const { lazySchemaStats } = await import("./lazySchema");
  const before = lazySchemaStats();
  assert.ok(before.registered >= 250, `expected the contract schemas to be lazy, got ${before.registered}`);
  assert.equal(before.built, 0, "an import-time access forces schemas; keep top-level code off schema properties");

  const route = (agentApi!.agentApiContract as Record<string, { request: { query: z.ZodType } }>).historyRead;
  route.request.query.safeParse({});
  const after = lazySchemaStats();
  assert.ok(after.built > 0 && after.built < 40, `one route should build only its own schemas, built ${after.built}`);
});

test("lazy schemas produce the same JSON Schema as eagerly built ones", async () => {
  vi.resetModules();
  vi.doMock("./lazySchema", () => ({
    lazySchema: (_name: string, factory: () => unknown) => factory(),
    warmContractSchemas: () => 0,
    lazySchemaStats: () => ({ registered: 0, built: 0 }),
  }));
  const eager = contractJsonSchemas(await importContracts());
  vi.doUnmock("./lazySchema");
  vi.resetModules();
  const lazy = contractJsonSchemas(await importContracts());

  assert.ok(eager.size > 300, `expected the contract surface, got ${eager.size} schemas`);
  assert.deepEqual([...lazy.keys()].sort(), [...eager.keys()].sort());
  for (const [key, schema] of eager) assert.deepEqual(lazy.get(key), schema, key);
});

test("after warm-up, own-property reads match an eager build", async () => {
  vi.resetModules();
  vi.doMock("./lazySchema", () => ({
    lazySchema: (_name: string, factory: () => unknown) => factory(),
    warmContractSchemas: () => 0,
    lazySchemaStats: () => ({ registered: 0, built: 0 }),
  }));
  const eager = ownKeysOfSchemas(await importContracts());
  vi.doUnmock("./lazySchema");
  vi.resetModules();
  const lazyModules = await importContracts();
  const { warmContractSchemas } = await import("./lazySchema");
  // Before the build, own-property reads see the empty placeholder (the
  // documented blind spot); after it they must match.
  warmContractSchemas();
  const lazy = ownKeysOfSchemas(lazyModules);

  assert.ok(eager.size > 200, `expected the exported schemas, got ${eager.size}`);
  assert.deepEqual(lazy, eager);
});

function ownKeysOfSchemas(modules: Record<string, unknown>[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  modules.forEach((mod, index) => {
    for (const [name, value] of Object.entries(mod)) {
      if (value instanceof z.ZodType) out.set(`${CONTRACT_MODULES[index]}:${name}`, Object.keys(value).sort());
    }
  });
  return out;
}

test("warmContractSchemas builds every registered schema", async () => {
  vi.resetModules();
  await importContracts();
  const { lazySchemaStats, warmContractSchemas } = await import("./lazySchema");
  const count = warmContractSchemas();
  assert.deepEqual(lazySchemaStats(), { registered: count, built: count });
});
