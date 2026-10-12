import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEGACY_RAFT_HOME_DIRNAME, RAFT_HOME_DIRNAME } from "@botiverse/raft-shared";
import type { MachineServiceAttestation } from "./lib/types";
import { readMachineServiceAttestation } from "./machineServiceAttestation";
import { listManagedServerIds, readServerAttachment } from "./serverState";
import { formatRaftHomeForDisplay } from "./paths";

/**
 * task #914 (from task #374): one host must not run two Computer services
 * that hold the same machine key. The known ways it happens are an old
 * install root still running its service next to a new one (`~/.slock` and
 * `~/.raft` can coexist: the default-root rule picks one, the other keeps
 * whatever service it had), and a stop that did not stop the old service.
 * Each extra service is a second daemon on the same key, and the server then
 * routes commands to either.
 *
 * The guard asks the sibling root's service to attest itself over IPC (that
 * is the liveness proof: a dead service answers nothing) and compares the
 * key fingerprints of the servers it manages with ours. A match names the
 * holder; `start` refuses to spawn and `doctor` reports it.
 */

/** sha256 prefix, the same path-free form the legacy lock owner uses. Never the key. */
export function machineKeyFingerprint(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex").slice(0, 16);
}

export interface DuplicateKeyHolder {
  /** Install root whose live service holds a key we also hold. */
  root: string;
  servicePid: number;
  computerVersion: string;
  /** Our server ids whose key that service also holds. */
  serverIds: string[];
  fingerprints: string[];
}

export interface DuplicateKeyGuardDeps {
  /** Roots to probe. Default: the other default root (`~/.slock` ↔ `~/.raft`) when it exists. */
  roots?: string[];
  homeDir?: string;
  exists?: (p: string) => boolean;
  /** Liveness + inventory of a root's service; null when nothing live answers. */
  readAttestation?: (root: string) => Promise<MachineServiceAttestation | null>;
  readAttachment?: (root: string, serverId: string) => Promise<{ apiKey: string } | null>;
  listManagedServerIds?: (root: string) => Promise<string[]>;
  /** This process's pid: a service never reports itself as a duplicate. */
  selfPid?: number;
}

/** The default roots other than `slockHome` that exist on this host. */
export function siblingDefaultRoots(
  slockHome: string,
  homeDir = os.homedir(),
  exists: (p: string) => boolean = existsSync,
): string[] {
  const self = path.resolve(slockHome);
  return [LEGACY_RAFT_HOME_DIRNAME, RAFT_HOME_DIRNAME]
    .map((name) => path.resolve(homeDir, name))
    .filter((root) => root !== self && exists(root));
}

export async function findDuplicateKeyHolder(
  slockHome: string,
  deps: DuplicateKeyGuardDeps = {},
): Promise<DuplicateKeyHolder | null> {
  const listIds = deps.listManagedServerIds ?? listManagedServerIds;
  const readAttachment = deps.readAttachment ?? readServerAttachment;
  const readAttestation = deps.readAttestation ?? ((root: string) => readMachineServiceAttestation(root));
  const selfPid = deps.selfPid ?? process.pid;
  const roots = deps.roots ?? siblingDefaultRoots(slockHome, deps.homeDir, deps.exists);

  const ours = new Map<string, string>();
  for (const serverId of await listIds(slockHome)) {
    const attachment = await readAttachment(slockHome, serverId);
    if (attachment?.apiKey) ours.set(machineKeyFingerprint(attachment.apiKey), serverId);
  }
  if (ours.size === 0 || roots.length === 0) return null;

  for (const root of roots) {
    const attestation = await readAttestation(root);
    if (!attestation || attestation.servicePid === selfPid) continue;
    const serverIds: string[] = [];
    const fingerprints: string[] = [];
    for (const theirServerId of attestation.managedServerIds) {
      const attachment = await readAttachment(root, theirServerId);
      if (!attachment?.apiKey) continue;
      const fingerprint = machineKeyFingerprint(attachment.apiKey);
      const ourServerId = ours.get(fingerprint);
      if (ourServerId === undefined) continue;
      serverIds.push(ourServerId);
      fingerprints.push(fingerprint);
    }
    if (serverIds.length > 0) {
      return { root, servicePid: attestation.servicePid, computerVersion: attestation.computerVersion, serverIds, fingerprints };
    }
  }
  return null;
}

/** One line for the owner: who holds the key, and the two ways out. Carries fingerprints, never keys. */
export function describeDuplicateKeyHolder(holder: DuplicateKeyHolder, homeDir = os.homedir()): string {
  const root = formatRaftHomeForDisplay(holder.root, homeDir);
  const servers = holder.serverIds.join(", ");
  const prints = holder.fingerprints.join(", ");
  return (
    `Another Computer service already holds this machine key: pid ${holder.servicePid} (Computer version ${holder.computerVersion}) ` +
    `under ${root}, server ${servers} (key fingerprint ${prints}). ` +
    `Stop it first (\`RAFT_HOME=${root} raft-computer stop\`) or re-bind this install with \`raft-computer setup\`; ` +
    `Raft cannot tell which of them should run your agents.`
  );
}
