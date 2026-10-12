import assert from "node:assert/strict";
import { join } from "node:path";
import type { MachineServiceAttestation } from "./lib/types";
import {
  describeDuplicateKeyHolder,
  findDuplicateKeyHolder,
  machineKeyFingerprint,
  siblingDefaultRoots,
} from "./duplicateKeyGuard";

const HOME = "/Users/someone";
const OURS = join(HOME, ".raft");
const THEIRS = join(HOME, ".slock");
const KEY = "sk_machine_test_key_0123456789abcdef";
const OTHER_KEY = "sk_machine_other_key_fedcba9876543210";

function attestation(servicePid: number, managedServerIds: string[]): MachineServiceAttestation {
  return { computerVersion: "1.0.25", serviceGeneration: "g1", servicePid, managedServerIds, managedSetRevision: "r1" };
}

/** A two-root host: our root manages server-a with KEY; the sibling root's live service manages `theirs`. */
function deps(theirs: Record<string, string>, opts: { attest?: MachineServiceAttestation | null; selfPid?: number } = {}) {
  const attachments: Record<string, Record<string, string>> = { [OURS]: { "server-a": KEY }, [THEIRS]: theirs };
  const probes: string[] = [];
  return {
    probes,
    deps: {
      roots: [THEIRS],
      selfPid: opts.selfPid ?? 4242,
      listManagedServerIds: async (root: string) => Object.keys(attachments[root] ?? {}),
      readAttachment: async (root: string, serverId: string) => {
        const apiKey = attachments[root]?.[serverId];
        return apiKey ? { apiKey } : null;
      },
      readAttestation: async (root: string) => {
        probes.push(root);
        return opts.attest === undefined ? attestation(777, Object.keys(attachments[root] ?? {})) : opts.attest;
      },
    },
  };
}

test("task #914: a live sibling service holding our key is named with pid, version, root, server and fingerprint — never the key", async () => {
  const { deps: d } = deps({ "server-legacy": KEY });
  const holder = await findDuplicateKeyHolder(OURS, d);
  assert.deepEqual(holder, {
    root: THEIRS,
    servicePid: 777,
    computerVersion: "1.0.25",
    serverIds: ["server-a"],
    fingerprints: [machineKeyFingerprint(KEY)],
  });
  const text = describeDuplicateKeyHolder(holder!, HOME);
  assert.match(text, /pid 777 \(Computer version 1\.0\.25\) under ~\/\.slock, server server-a \(key fingerprint [0-9a-f]{16}\)/);
  assert.match(text, /RAFT_HOME=~\/\.slock raft-computer stop/);
  assert.doesNotMatch(text, /sk_machine/, "the key itself never appears");
  assert.doesNotMatch(JSON.stringify(holder), /sk_machine/);
});

test("task #914: no verdict without a live holder of OUR key", async () => {
  // Sibling service holds a different key: not a duplicate.
  assert.equal(await findDuplicateKeyHolder(OURS, deps({ "server-legacy": OTHER_KEY }).deps), null);
  // Sibling root exists but nothing live answers the attestation.
  assert.equal(await findDuplicateKeyHolder(OURS, deps({ "server-legacy": KEY }, { attest: null }).deps), null);
  // The answering service is this very process (a self-restart hand-off): never a duplicate.
  assert.equal(await findDuplicateKeyHolder(OURS, deps({ "server-legacy": KEY }, { attest: attestation(4242, ["server-legacy"]) }).deps), null);
  // We hold no key at all: nothing to compare, and the sibling is not even probed.
  const { deps: d, probes } = deps({ "server-legacy": KEY });
  d.listManagedServerIds = async (root: string) => (root === OURS ? [] : ["server-legacy"]);
  assert.equal(await findDuplicateKeyHolder(OURS, d), null);
  assert.deepEqual(probes, [], "no attestation probe when we manage nothing");
});

test("task #914: the probed roots are the other default root(s) that exist, never our own", () => {
  const exists = (p: string) => p === OURS || p === THEIRS;
  assert.deepEqual(siblingDefaultRoots(OURS, HOME, exists), [THEIRS]);
  assert.deepEqual(siblingDefaultRoots(THEIRS, HOME, exists), [OURS]);
  assert.deepEqual(siblingDefaultRoots(join(HOME, "custom-home"), HOME, exists), [THEIRS, OURS]);
  assert.deepEqual(siblingDefaultRoots(OURS, HOME, (p) => p === OURS), [], "a sibling that does not exist is not probed");
});

test("task #914: the fingerprint is the sha256 prefix, stable and key-free", () => {
  assert.equal(machineKeyFingerprint(KEY), machineKeyFingerprint(KEY));
  assert.notEqual(machineKeyFingerprint(KEY), machineKeyFingerprint(OTHER_KEY));
  assert.match(machineKeyFingerprint(KEY), /^[0-9a-f]{16}$/);
});
