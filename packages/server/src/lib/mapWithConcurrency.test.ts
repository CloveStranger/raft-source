import assert from "node:assert/strict";
import { createConcurrencyLimiter, mapWithConcurrency } from "./mapWithConcurrency";

test("mapWithConcurrency keeps input order and never exceeds the limit", async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 40 }, (_, i) => i);
  const results = await mapWithConcurrency(items, 8, async (item) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, (item * 7) % 5));
    inFlight -= 1;
    return item * 2;
  });
  assert.deepEqual(results, items.map((i) => i * 2));
  assert.equal(peak, 8);
});

test("mapWithConcurrency handles empty input, small lists and rejects like Promise.all", async () => {
  assert.deepEqual(await mapWithConcurrency([], 8, async () => 1), []);
  assert.deepEqual(await mapWithConcurrency([1, 2], 8, async (x) => x + 1), [2, 3]);
  await assert.rejects(
    mapWithConcurrency([1, 2, 3], 2, async (x) => {
      if (x === 2) throw new Error("boom");
      return x;
    }),
    /boom/,
  );
});

test("createConcurrencyLimiter shares one bound across callers, in call order, and frees a slot on rejection", async () => {
  const limit = createConcurrencyLimiter(3);
  let inFlight = 0;
  let peak = 0;
  const started: number[] = [];
  const run = (id: number, fail = false) => limit(async () => {
    started.push(id);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    inFlight -= 1;
    if (fail) throw new Error(`boom ${id}`);
    return id;
  });
  const settled = await Promise.allSettled(Array.from({ length: 12 }, (_, id) => run(id, id === 1)));
  assert.equal(peak, 3);
  assert.deepEqual(started, Array.from({ length: 12 }, (_, id) => id));
  assert.equal(settled[1]!.status, "rejected");
  assert.deepEqual(settled.filter((entry) => entry.status === "fulfilled").map((entry) => (entry as PromiseFulfilledResult<number>).value), [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test("createConcurrencyLimiter does not let a new caller take a slot that is being handed to a waiter", async () => {
  const limit = createConcurrencyLimiter(1);
  let running = 0;
  let peak = 0;
  const tracked = () => limit(async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 1));
    running -= 1;
  });
  let releaseFirst!: () => void;
  const firstWork = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = limit(() => firstWork);
  const waiter = tracked();
  // Runs right after the limiter's own continuation on firstWork (release),
  // before the woken waiter resumes: the window a new caller could slip into.
  let latecomer: Promise<void> | null = null;
  void firstWork.then(() => { latecomer = tracked(); });
  releaseFirst();
  await first;
  await waiter;
  await latecomer;
  assert.equal(peak, 1);
});
