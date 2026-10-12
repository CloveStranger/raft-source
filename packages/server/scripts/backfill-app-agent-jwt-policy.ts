import { closeDatabase, initDatabase } from "../src/db/index";
import { backfillLegacyAgentJwtPolicies } from "../src/services/agentAudienceJwtPolicyService";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--apply")) throw new Error("Usage: backfill-app-agent-jwt-policy.ts [--apply]");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
try {
  await initDatabase(databaseUrl);
  console.log(JSON.stringify(await backfillLegacyAgentJwtPolicies(args.includes("--apply"))));
} finally {
  await closeDatabase();
}
