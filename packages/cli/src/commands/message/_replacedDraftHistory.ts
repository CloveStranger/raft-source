import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveStateDbPath } from "../../state/agentLedger";

export const REPLACED_DRAFT_HISTORY_LIMIT = 5;

function privateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("Replaced-draft history directory is not owned by this user");
  }
  fs.chmodSync(directory, 0o700);
}

function targetDirectory(agentId: string, target: string, env: NodeJS.ProcessEnv): string {
  const agentStateDirectory = path.dirname(resolveStateDbPath(agentId, env));
  privateDirectory(agentStateDirectory);
  const historyDirectory = path.join(agentStateDirectory, "replaced-drafts");
  privateDirectory(historyDirectory);
  const targetKey = createHash("sha256").update(target, "utf8").digest("hex");
  const directory = path.join(historyDirectory, targetKey);
  privateDirectory(directory);
  return directory;
}

function pruneOldHistory(directory: string, keepPath: string): void {
  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".txt"))
    .map((entry) => {
      const filePath = path.join(directory, entry.name);
      const stat = fs.lstatSync(filePath);
      return { filePath, mtimeMs: stat.mtimeMs, name: entry.name };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));

  const older = files.filter((file) => file.filePath !== keepPath);
  for (const file of older.slice(REPLACED_DRAFT_HISTORY_LIMIT - 1)) {
    try {
      fs.rmSync(file.filePath);
    } catch {
      // The full body is already durable. Retention cleanup is best-effort so
      // it can never turn a successful archive into a send blocker.
    }
  }
}

/**
 * Preserve the exact previous body before the one-slot held draft is replaced.
 * The caller deliberately treats failures as non-fatal: message delivery must
 * not depend on local recovery storage.
 */
export function archiveReplacedDraft(
  agentId: string,
  target: string,
  content: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const directory = targetDirectory(agentId, target, env);
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const filePath = path.join(directory, `${timestamp}-${randomUUID()}.txt`);
  fs.writeFileSync(filePath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  try {
    pruneOldHistory(directory, filePath);
  } catch {
    // See pruneOldHistory: recovery beats cleanup.
  }
  return filePath;
}
