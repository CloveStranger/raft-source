import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import type { DatabaseExecutor } from "../db/index";
import * as schema from "../db/schema";
import { __dispatchReferralFinancialWebhookForTests } from "./billingService";
import {
  applyReferralProviderEvent,
  createReferralReservation,
  hashReferralProviderPayload,
  markReferralCheckoutCompleted,
  markReferralCheckoutCreated,
  markCampaignProviderProvisioningStarted,
  qualifyReferralRedemption,
  ReferralDiscountError,
  updateCampaignEconomics,
  upsertPaidHistoryCoverage,
} from "./referralDiscountService";

const REAL_PG_URL_ENV = "REFERRAL_DISCOUNT_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.REFERRAL_DISCOUNT_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

function quoteIdentifier(identifier: string): string {
  assert.match(identifier, /^[a-z0-9_]+$/);
  return `"${identifier}"`;
}

function databaseUrlFor(adminUrl: string, databaseName: string): string {
  const parsed = new URL(adminUrl);
  assert.match(parsed.protocol, /^postgres(?:ql)?:$/, `${REAL_PG_URL_ENV} must be a PostgreSQL URL`);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

async function createRealPgDatabase(): Promise<{ admin: pg.Client; pool: pg.Pool; databaseName: string }> {
  assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
  const databaseName = `referral_discount_${process.pid}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "referral-discount-admin" });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  const pool = new pg.Pool({ connectionString: databaseUrlFor(REAL_PG_URL, databaseName), application_name: "referral-discount-test", max: 4 });
  await migrate(drizzle(pool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
  return { admin, pool, databaseName };
}

async function dropRealPgDatabase(admin: pg.Client, databaseName: string) {
  await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
  await admin.end();
}

async function seedQualifiedReferralForInvoice(input: {
  db: DatabaseExecutor;
  campaignId: string;
  codeId: string;
  referrerId: string;
  redeemerId: string;
  serverId: string;
  invoiceId: string;
  customerId: string;
  subscriptionId: string;
}) {
  const decisionAt = new Date("2026-10-09T16:00:00.000Z");
  const redemption = await createReferralReservation({
    environment: "stripe",
    livemode: true,
    historyOriginAt: new Date("2026-01-01T00:00:00.000Z"),
    decisionAt,
    campaignId: input.campaignId,
    codeId: input.codeId,
    referrerUserId: input.referrerId,
    redeemingUserId: input.redeemerId,
    referredServerId: input.serverId,
    reservationExpiresAt: new Date("2026-10-09T16:30:00.000Z"),
  }, input.db);
  await input.db.update(schema.referralDiscountRedemptions)
    .set({ reservedAt: decisionAt })
    .where(eq(schema.referralDiscountRedemptions.id, redemption.id));
  await markReferralCheckoutCreated(redemption.id, {
    decisionAt,
    stripeCheckoutSessionId: `cs_${input.invoiceId}`,
    stripeCustomerId: input.customerId,
    stripeSubscriptionId: input.subscriptionId,
    reservationExpiresAt: new Date("2026-10-09T16:30:00.000Z"),
  }, input.db);
  await markReferralCheckoutCompleted(redemption.id, {
    stripeCheckoutSessionId: `cs_${input.invoiceId}`,
    stripeCustomerId: input.customerId,
    stripeSubscriptionId: input.subscriptionId,
  }, input.db);
  await qualifyReferralRedemption(redemption.id, {
    firstPaidInvoiceId: input.invoiceId,
    stripeCustomerId: input.customerId,
    stripeSubscriptionId: input.subscriptionId,
  }, input.db);
  return redemption;
}

async function dispatchRealPgReferralRefund(input: {
  db: DatabaseExecutor;
  eventId: string;
  eventType: "refund.created" | "refund.updated";
  eventCreated: number;
  refundId: string;
  invoiceId: string;
  amount: number;
  status: string;
}) {
  await __dispatchReferralFinancialWebhookForTests({
    id: input.eventId,
    type: input.eventType,
    created: input.eventCreated,
    livemode: false,
    data: {
      object: {
        id: input.refundId,
        object: "refund",
        livemode: false,
        invoice: input.invoiceId,
        charge: "ch_realpg_referral",
        currency: "usd",
        amount: input.amount,
        status: input.status,
      },
    },
  } as any, input.db);
}

test(
  "campaign_cap_real_postgres_two_transaction_test_allows_only_one_last_slot_holder",
  { skip: !(REAL_PG_URL || REAL_PG_REQUIRED), timeout: 120_000 },
  async () => {
    const { admin, pool, databaseName } = await createRealPgDatabase();
    try {
      const referrerId = randomUUID();
      const redeemer1Id = randomUUID();
      const redeemer2Id = randomUUID();
      const server1Id = randomUUID();
      const server2Id = randomUUID();
      const campaignId = randomUUID();
      const codeId = randomUUID();
      const db = drizzle(pool, { schema });
      const decisionAt = new Date("2026-10-09T16:00:00.000Z");
      await pool.query(`
        INSERT INTO users (id, email, name, password_hash)
        VALUES
          ($1, 'referrer@test.invalid', 'referrer', 'x'),
          ($2, 'redeemer1@test.invalid', 'redeemer1', 'x'),
          ($3, 'redeemer2@test.invalid', 'redeemer2', 'x')
      `, [referrerId, redeemer1Id, redeemer2Id]);
      await pool.query(`
        INSERT INTO servers (id, name, slug, owner_id)
        VALUES
          ($1, 'server1', 'referral-realpg-1', $2),
          ($3, 'server2', 'referral-realpg-2', $4)
      `, [server1Id, redeemer1Id, server2Id, redeemer2Id]);
      await upsertPaidHistoryCoverage({
        environment: "stripe",
        livemode: true,
        coverageOriginAt: new Date("2026-01-01T00:00:00.000Z"),
        coverageWatermarkAt: new Date("2026-10-09T17:00:00.000Z"),
        completedAt: new Date("2026-10-09T17:00:00.000Z"),
        source: "real-pg-test",
        auditReason: "real pg coverage",
      }, db);
      await db.insert(schema.referralDiscountCampaigns).values({
        id: campaignId,
        name: "real pg cap",
        status: "active",
        providerState: "ready",
        providerStrategy: "stripe_coupon_repeating_v1",
        percentOff: 20,
        durationMonths: 3,
        maxPaidRedemptions: 1,
        mutationReason: "test",
      });
      await db.insert(schema.referralDiscountCodes).values({
        id: codeId,
        campaignId,
        referrerUserId: referrerId,
        displayCode: "REALPG20",
        normalizedCode: "realpg20",
        status: "active",
        providerState: "ready",
        maxPaidRedemptions: 1,
        issuedReason: "test",
      });

      const results = await Promise.allSettled([
        createReferralReservation({
          environment: "stripe",
          livemode: true,
          historyOriginAt: new Date("2026-01-01T00:00:00.000Z"),
          decisionAt,
          campaignId,
          codeId,
          referrerUserId: referrerId,
          redeemingUserId: redeemer1Id,
          referredServerId: server1Id,
          reservationExpiresAt: new Date("2026-10-09T16:30:00.000Z"),
        }, db),
        createReferralReservation({
          environment: "stripe",
          livemode: true,
          historyOriginAt: new Date("2026-01-01T00:00:00.000Z"),
          decisionAt,
          campaignId,
          codeId,
          referrerUserId: referrerId,
          redeemingUserId: redeemer2Id,
          referredServerId: server2Id,
          reservationExpiresAt: new Date("2026-10-09T16:30:00.000Z"),
        }, db),
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      const reason = rejected[0]?.status === "rejected" ? rejected[0].reason : null;
      assert.ok(reason instanceof ReferralDiscountError);
      assert.equal(reason.code, "cap_exhausted");

      const finalCounts = await pool.query<{ live_reserved_count: number; qualified_count: number }>(`
        SELECT live_reserved_count, qualified_count
          FROM referral_discount_campaigns
         WHERE id = $1
      `, [campaignId]);
      const finalCodeCounts = await pool.query<{ live_reserved_count: number; qualified_count: number }>(`
        SELECT live_reserved_count, qualified_count
          FROM referral_discount_codes
         WHERE id = $1
      `, [codeId]);
      const redemptionCount = await pool.query<{ count: string }>("SELECT count(*) FROM referral_discount_redemptions WHERE campaign_id = $1", [campaignId]);
      assert.deepEqual(finalCounts.rows[0], { live_reserved_count: 1, qualified_count: 0 });
      assert.deepEqual(finalCodeCounts.rows[0], { live_reserved_count: 1, qualified_count: 0 });
      assert.equal(redemptionCount.rows[0]?.count, "1");
    } finally {
      await pool.end();
      await dropRealPgDatabase(admin, databaseName);
    }
  },
);

test(
  "financial_lineage_real_postgres_two_transaction_test_converges_to_serial_terminal_state",
  { skip: !(REAL_PG_URL || REAL_PG_REQUIRED), timeout: 120_000 },
  async () => {
    const { admin, pool, databaseName } = await createRealPgDatabase();
    try {
      const referrerId = randomUUID();
      const redeemerId = randomUUID();
      const serverId = randomUUID();
      const campaignId = randomUUID();
      const codeId = randomUUID();
      const db = drizzle(pool, { schema });
      await pool.query(`
        INSERT INTO users (id, email, name, password_hash)
        VALUES
          ($1, 'lineage-referrer@test.invalid', 'lineage-referrer', 'x'),
          ($2, 'lineage-redeemer@test.invalid', 'lineage-redeemer', 'x')
      `, [referrerId, redeemerId]);
      await pool.query(`
        INSERT INTO servers (id, name, slug, owner_id)
        VALUES ($1, 'lineage-server', 'referral-realpg-lineage', $2)
      `, [serverId, redeemerId]);
      await upsertPaidHistoryCoverage({
        environment: "stripe",
        livemode: true,
        coverageOriginAt: new Date("2026-01-01T00:00:00.000Z"),
        coverageWatermarkAt: new Date("2026-10-09T17:00:00.000Z"),
        completedAt: new Date("2026-10-09T17:00:00.000Z"),
        source: "real-pg-test",
        auditReason: "real pg coverage",
      }, db);
      await db.insert(schema.referralDiscountCampaigns).values({
        id: campaignId,
        name: "real pg lineage",
        status: "active",
        providerState: "ready",
        providerStrategy: "stripe_coupon_repeating_v1",
        percentOff: 20,
        durationMonths: 3,
        maxPaidRedemptions: 10,
        mutationReason: "test",
      });
      await db.insert(schema.referralDiscountCodes).values({
        id: codeId,
        campaignId,
        referrerUserId: referrerId,
        displayCode: "REALPGLINEAGE20",
        normalizedCode: "realpglineage20",
        status: "active",
        providerState: "ready",
        maxPaidRedemptions: 10,
        issuedReason: "test",
      });
      await seedQualifiedReferralForInvoice({
        db,
        campaignId,
        codeId,
        referrerId,
        redeemerId,
        serverId,
        invoiceId: "in_realpg_lineage",
        customerId: "cus_realpg_lineage",
        subscriptionId: "sub_realpg_lineage",
      });

      const results = await Promise.allSettled([
        dispatchRealPgReferralRefund({ db, eventId: "evt_realpg_refund_created", eventType: "refund.created", eventCreated: 100, refundId: "re_realpg_lineage", invoiceId: "in_realpg_lineage", amount: 250, status: "pending" }),
        dispatchRealPgReferralRefund({ db, eventId: "evt_realpg_refund_failed", eventType: "refund.updated", eventCreated: 200, refundId: "re_realpg_lineage", invoiceId: "in_realpg_lineage", amount: 250, status: "failed" }),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);

      const rows = await pool.query<{ stripe_event_id: string; net_revenue_delta: number }>(`
        SELECT stripe_event_id, net_revenue_delta
          FROM referral_discount_financial_adjustments
         WHERE provider_fact_id = 're_realpg_lineage'
         ORDER BY provider_fact_sequence, stripe_event_id
      `);
      assert.equal(rows.rows.reduce((total, row) => total + row.net_revenue_delta, 0), 0);
      assert.equal(rows.rows.find((row) => row.stripe_event_id === "evt_realpg_refund_created")?.net_revenue_delta, -250);
      assert.equal(rows.rows.find((row) => row.stripe_event_id === "evt_realpg_refund_failed")?.net_revenue_delta, 250);
    } finally {
      await pool.end();
      await dropRealPgDatabase(admin, databaseName);
    }
  },
);

test(
  "provider_event_real_postgres_business_failure_stays_parked_atomically",
  { skip: !(REAL_PG_URL || REAL_PG_REQUIRED), timeout: 120_000 },
  async () => {
    const { admin, pool, databaseName } = await createRealPgDatabase();
    try {
      const db = drizzle(pool, { schema });
      await assert.rejects(
        () => applyReferralProviderEvent({
          environment: "stripe",
          livemode: false,
          stripeEventId: "evt_realpg_business_failure",
          stripeEventType: "refund.updated",
          providerObjectId: "re_realpg_business_failure",
          sourceApiVersion: "2026-02-25.clover",
          payloadHash: hashReferralProviderPayload({ eventType: "refund.updated", providerObjectId: "re_realpg_business_failure" }),
          normalizedPayload: { refundId: "re_realpg_business_failure" },
        }, async () => {
          throw new ReferralDiscountError("financial_adjustment_unjoinable", "synthetic business failure");
        }, db),
      );
      const row = await pool.query<{ processing_state: string; sanitized_error_code: string | null }>(`
        SELECT processing_state, sanitized_error_code
          FROM referral_discount_provider_events
         WHERE stripe_event_id = 'evt_realpg_business_failure'
      `);
      assert.equal(row.rows[0]?.processing_state, "parked");
      assert.equal(row.rows[0]?.sanitized_error_code, null);
    } finally {
      await pool.end();
      await dropRealPgDatabase(admin, databaseName);
    }
  },
);

test(
  "campaign_economics_real_postgres_two_transaction_test_loses_to_provider_provisioning",
  { skip: !(REAL_PG_URL || REAL_PG_REQUIRED), timeout: 120_000 },
  async () => {
    const { admin, pool, databaseName } = await createRealPgDatabase();
    const locker = new pg.Client({ connectionString: databaseUrlFor(REAL_PG_URL!, databaseName), application_name: "referral-discount-locker" });
    let lockerConnected = false;
    let lockerCommitted = false;
    try {
      const campaignId = randomUUID();
      const db = drizzle(pool, { schema });
      await db.insert(schema.referralDiscountCampaigns).values({
        id: campaignId,
        name: "real pg economics lock",
        status: "draft",
        providerState: "pending",
        providerStrategy: "stripe_coupon_repeating_v1",
        percentOff: 20,
        durationMonths: 3,
        maxPaidRedemptions: 10,
        mutationReason: "test",
      });

      await locker.connect();
      lockerConnected = true;
      await locker.query("BEGIN");
      const lockedDb = drizzle(locker, { schema });
      await markCampaignProviderProvisioningStarted(campaignId, lockedDb);
      const blockedUpdate = updateCampaignEconomics(campaignId, { percentOff: 25, mutationReason: "race loser" }, db);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await locker.query("COMMIT");
      lockerCommitted = true;

      await assert.rejects(
        () => blockedUpdate,
        (error) => {
          assert.ok(error instanceof ReferralDiscountError);
          assert.equal(error.code, "campaign_economics_locked");
          return true;
        },
      );
      const row = await pool.query<{ percent_off: number; provider_provisioning_started_at: Date | null }>(`
        SELECT percent_off, provider_provisioning_started_at
          FROM referral_discount_campaigns
         WHERE id = $1
      `, [campaignId]);
      assert.equal(row.rows[0]?.percent_off, 20);
      assert.ok(row.rows[0]?.provider_provisioning_started_at);
    } finally {
      if (lockerConnected) {
        try {
          if (!lockerCommitted) await locker.query("ROLLBACK");
        } catch {
          // Connection may already have committed or closed.
        }
        await locker.end();
      }
      await pool.end();
      await dropRealPgDatabase(admin, databaseName);
    }
  },
);
