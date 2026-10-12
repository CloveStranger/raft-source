import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { vi } from "vitest";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import type { Database } from "../db/index";
import { dbTest as test } from "../test/integration/dbTest";
import type { createSeed } from "../test/integration/seed";
import {
  billingPaidIdentityEvents,
  billingPaidIdentityResolutions,
  subscriptions,
  referralDiscountFinancialAdjustmentResolutions,
  referralDiscountCampaigns,
  referralDiscountCodes,
  referralDiscountFinancialAdjustments,
  referralDiscountProviderEvents,
  referralDiscountProviderOperations,
  referralDiscountRedemptions,
} from "../db/schema";
import {
  __dispatchReferralFinancialWebhookForTests,
  __invokeReferralCheckoutProviderForTests,
  __resetStripeForTests,
  __setReferralStripeForTests,
  __setStripeForTests,
  handleWebhookEvent,
  proveReferralStripeAccountForTests,
  provisionReferralCampaignCouponForTests,
  provisionReferralCodePromotionForTests,
  referralStripeAcceptanceAuthorizationFromEnv,
  runReferralDurationAcceptanceForTests,
  runReferralProviderProvisioningReadinessForTests,
  runReferralStripeAccountAcceptanceForTests,
  REFERRAL_STRIPE_API_VERSION,
} from "./billingService";
import { runWithTraceSpan } from "../tracing/semanticTrace";

vi.mock("@botiverse/raft-trace-client", () => ({
  getActiveSpan: () => null,
  runWithActiveSpan: (_span: unknown, work: () => unknown) => work(),
}));

import {
  assertReferralCheckoutMetadataPair,
  applyReferralProviderEvent,
  beginReferralProviderOperation,
  buildReferralCheckoutMetadata,
  createReferralReservationForCode,
  createReferralReservation,
  evaluateReferralEligibility,
  expireReferralCheckoutSession,
  expireReferralReservation,
  fingerprintReferralProviderRequest,
  hashReferralProviderPayload,
  ingestNormalizedPaidIdentityFact,
  ingestReferralProviderEvent,
  markReferralCheckoutCompleted,
  markReferralCheckoutCreated,
  markCampaignProviderProvisioningStarted,
  markReferralProviderOperationStarted,
  confirmReferralProviderOperation,
  parkReferralProviderOperation,
  normalizeReferralCode,
  previewReferralCode,
  qualifyReferralRedemption,
  qualifyReferralInvoicePayment,
  referralDiagnosticToken,
  readActiveReferralReservationForCode,
  recordReferralFinancialAdjustment,
  ReferralDiscountError,
  resolvePaidIdentityFact,
  updateCampaignEconomics,
  upsertPaidHistoryCoverage,
  voidReferralReservation,
} from "./referralDiscountService";

const HISTORY_ORIGIN = new Date("2026-01-01T00:00:00.000Z");
const DECISION_AT = new Date("2026-10-09T16:00:00.000Z");
const CHECKOUT_EXPIRES_AT = new Date("2026-10-09T16:30:00.000Z");
const WATERMARK = new Date("2026-10-09T17:00:00.000Z");
const REFERRAL_PROVIDER_STRATEGY = `stripe_coupon_repeating_v1@${REFERRAL_STRIPE_API_VERSION}`;
const REFERRAL_FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "stripe",
  "referral-discount",
  REFERRAL_STRIPE_API_VERSION,
);
const REFERRAL_FIXTURE_HASH = "6e9576b28bbf028b04bc9370f602f1f2c8391189a8738c63a9d947cf9ccece79";
const REFERRAL_AUTH_ENV = {
  REFERRAL_DISCOUNT_STRIPE_ACCEPTANCE: "1",
  REFERRAL_DISCOUNT_STRIPE_EXPECTED_ACCOUNT_ID: "acct_referral_test",
  REFERRAL_DISCOUNT_STRIPE_PROFILE: "sandbox",
  REFERRAL_DISCOUNT_STRIPE_SECRET_KEY: "sk_test_referral_123",
  REFERRAL_DISCOUNT_DIAGNOSTIC_KEY: "referral-diagnostic-test-key",
} as NodeJS.ProcessEnv;

type DbTestContext = { db: Database; seed: ReturnType<typeof createSeed> };

async function loadReferralFixture<T = any>(file: string): Promise<T> {
  return JSON.parse(await readFile(join(REFERRAL_FIXTURE_DIR, file), "utf8")) as T;
}

async function referralFixtureHash(): Promise<string> {
  const files = (await readdir(REFERRAL_FIXTURE_DIR)).filter((entry) => entry.endsWith(".json")).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(await readFile(join(REFERRAL_FIXTURE_DIR, file)));
  }
  return hash.digest("hex");
}

function accountProofClient(overrides: {
  accountId?: string;
  accountApiVersion?: string | null;
  balanceApiVersion?: string | null;
  balanceLivemode?: boolean;
  profile?: string;
  coupons?: any;
  promotionCodes?: any;
} = {}) {
  return {
    __referralProfile: overrides.profile ?? "sandbox",
    accounts: {
      retrieve: async () => ({
        id: overrides.accountId ?? "acct_referral_test",
        lastResponse: {
          ...(overrides.accountApiVersion === null ? {} : { apiVersion: overrides.accountApiVersion ?? REFERRAL_STRIPE_API_VERSION }),
          requestId: "req_acct",
        },
      }),
    },
    balance: {
      retrieve: async () => ({
        object: "balance",
        livemode: overrides.balanceLivemode ?? false,
        available: [],
        pending: [],
        lastResponse: {
          ...(overrides.balanceApiVersion === null ? {} : { apiVersion: overrides.balanceApiVersion ?? REFERRAL_STRIPE_API_VERSION }),
          requestId: "req_balance",
        },
      }),
    },
    coupons: overrides.coupons,
    promotionCodes: overrides.promotionCodes,
  };
}

function referralStripeFactory(stripe = accountProofClient(), observe?: (env: NodeJS.ProcessEnv, authorization: any) => void) {
  return (env: NodeJS.ProcessEnv, authorization: any) => {
    observe?.(env, authorization);
    return { ...stripe, __referralProfile: authorization.profile };
  };
}

async function referralAuthorization(stripe = accountProofClient()) {
  const result = await runReferralProviderProvisioningReadinessForTests(REFERRAL_AUTH_ENV, referralStripeFactory(stripe) as any);
  assert.equal("status" in result, false);
  return result as Exclude<typeof result, { status: "not_run" }>;
}

function providerCouponId(campaignId: string): string {
  return `raft_ref_coupon_${campaignId.replace(/-/g, "")}`;
}

function providerPromotionCode(codeId: string): string {
  return `RAFTREF${codeId.replace(/-/g, "").slice(0, 24).toUpperCase()}`;
}

function testCoupon(input: {
  campaignId: string;
  couponId: string;
  percentOff?: number;
  durationMonths?: number;
  maxRedemptions?: number | null;
  redeemBy?: number | null;
  livemode?: boolean;
  apiVersion?: string;
  requestId?: string;
}): Stripe.Coupon {
  return {
    id: input.couponId,
    object: "coupon",
    amount_off: null,
    created: 1_790_000_000,
    currency: null,
    duration: "repeating",
    duration_in_months: input.durationMonths ?? 3,
    livemode: input.livemode ?? false,
    max_redemptions: input.maxRedemptions ?? 10,
    metadata: {
      raft_use: "referral_discount_checkout",
      referral_campaign_id: input.campaignId,
      provider_strategy: REFERRAL_PROVIDER_STRATEGY,
      product_scope: "pro",
      billing_interval_scope: "both",
    },
    name: null,
    percent_off: input.percentOff ?? 20,
    redeem_by: input.redeemBy ?? null,
    times_redeemed: 0,
    valid: true,
    lastResponse: {
      apiVersion: input.apiVersion ?? REFERRAL_STRIPE_API_VERSION,
      requestId: input.requestId ?? "req_coupon",
    },
  } as unknown as Stripe.Coupon;
}

function testPromotionCode(input: {
  id: string;
  codeId: string;
  campaignId: string;
  referrerUserId: string;
  couponId: string;
  providerCode: string;
  maxRedemptions?: number | null;
  expiresAt?: number | null;
  livemode?: boolean;
  apiVersion?: string;
  requestId?: string;
  active?: boolean;
}): Stripe.PromotionCode {
  return {
    id: input.id,
    object: "promotion_code",
    active: input.active ?? true,
    code: input.providerCode,
    created: 1_790_000_000,
    customer: null,
    expires_at: input.expiresAt ?? null,
    livemode: input.livemode ?? false,
    max_redemptions: input.maxRedemptions ?? 10,
    metadata: {
      raft_use: "referral_discount_checkout",
      referral_campaign_id: input.campaignId,
      referral_code_id: input.codeId,
      referral_referrer_user_id: input.referrerUserId,
      provider_strategy: REFERRAL_PROVIDER_STRATEGY,
    },
    promotion: {
      type: "coupon",
      coupon: testCoupon({ campaignId: input.campaignId, couponId: input.couponId }),
    },
    restrictions: {},
    times_redeemed: 0,
    lastResponse: {
      apiVersion: input.apiVersion ?? REFERRAL_STRIPE_API_VERSION,
      requestId: input.requestId ?? "req_promotion",
    },
  } as unknown as Stripe.PromotionCode;
}

async function createReferralFixture({ db, seed }: DbTestContext, opts: { cap?: number | null } = {}) {
  const referrer = await seed.human();
  const redeemer = await seed.human();
  const owner = await seed.human();
  const server = await seed.server({ owner });
  await upsertPaidHistoryCoverage({
    environment: "stripe",
    livemode: true,
    coverageOriginAt: HISTORY_ORIGIN,
    coverageWatermarkAt: WATERMARK,
    completedAt: WATERMARK,
    source: "test-backfill",
    auditReason: "test coverage",
  }, db);
  const [campaign] = await db.insert(referralDiscountCampaigns).values({
    name: `Campaign ${randomUUID()}`,
    status: "active",
    providerState: "ready",
    providerStrategy: "stripe_coupon_repeating_v1",
    percentOff: 20,
    durationMonths: 3,
    maxPaidRedemptions: opts.cap ?? 10,
    mutationReason: "test",
  }).returning();
  const displayCode = `Founders-${randomUUID()}`;
  const [code] = await db.insert(referralDiscountCodes).values({
    campaignId: campaign.id,
    referrerUserId: referrer.id,
    displayCode,
    normalizedCode: normalizeReferralCode(displayCode),
    status: "active",
    providerState: "ready",
    maxPaidRedemptions: opts.cap ?? 10,
    issuedReason: "test",
  }).returning();
  return { referrer, redeemer, owner, server, campaign, code };
}

async function reserveFixture(ctx: DbTestContext, opts: { cap?: number | null } = {}) {
  const fixture = await createReferralFixture(ctx, opts);
  const redemption = await createReferralReservation({
    environment: "stripe",
    livemode: true,
    historyOriginAt: HISTORY_ORIGIN,
    decisionAt: DECISION_AT,
    campaignId: fixture.campaign.id,
    codeId: fixture.code.id,
    referrerUserId: fixture.referrer.id,
    redeemingUserId: fixture.redeemer.id,
    referredServerId: fixture.server.id,
    reservationExpiresAt: new Date("2026-10-09T16:30:00.000Z"),
  }, ctx.db);
  const [reserved] = await ctx.db.update(referralDiscountRedemptions)
    .set({ reservedAt: DECISION_AT })
    .where(eq(referralDiscountRedemptions.id, redemption.id))
    .returning();
  return { ...fixture, redemption: reserved };
}

async function completeCheckout(redemptionId: string, db: Database) {
  const stripeCheckoutSessionId = `cs_${randomUUID()}`;
  await markReferralCheckoutCreated(redemptionId, {
    decisionAt: DECISION_AT,
    stripeCheckoutSessionId,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    reservationExpiresAt: CHECKOUT_EXPIRES_AT,
  }, db);
  return markReferralCheckoutCompleted(redemptionId, {
    stripeCheckoutSessionId,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
  }, db);
}

async function qualifyFixture(redemptionId: string, invoiceId: string, db: Database) {
  await completeCheckout(redemptionId, db);
  return qualifyReferralRedemption(redemptionId, {
    firstPaidInvoiceId: invoiceId,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
  }, db);
}

async function seedPaidInvoiceFact(
  invoiceId: string,
  amountPaid: number,
  db: Database,
  identity?: { serverId: string; payerUserId: string; ownerUserId: string; livemode?: boolean },
) {
  const livemode = identity?.livemode ?? false;
  const stripeEventId = `evt_paid_${livemode ? "live" : "test"}_${invoiceId}_${randomUUID()}`;
  await ingestNormalizedPaidIdentityFact({
    environment: "stripe",
    livemode,
    stripeEventId,
    stripeInvoiceId: invoiceId,
    stripeProductId: "prod_pro",
    stripePriceId: "price_pro",
    paidAt: new Date("2026-10-09T16:10:00.000Z"),
    currency: "usd",
    invoiceSubtotal: amountPaid,
    invoiceTotal: amountPaid,
    amountPaid,
    source: "referral-test",
  }, db);
  if (identity) {
    await resolvePaidIdentityFact({
      environment: "stripe",
      livemode,
      stripeEventId,
      serverId: identity.serverId,
      payerUserId: identity.payerUserId,
      ownerUserId: identity.ownerUserId,
      source: "referral-test",
      auditReason: "resolved paid invoice test identity",
    }, db);
  }
}

function assertReferralError(error: unknown, code: string) {
  assert.ok(error instanceof ReferralDiscountError, `expected ReferralDiscountError, got ${String(error)}`);
  assert.equal(error.code, code);
}

test("provider_operation_replay_requires_same_idempotency_key_and_fingerprint", async ({ db }) => {
  const localTargetId = randomUUID();
  const fingerprint = fingerprintReferralProviderRequest({
    apiVersion: "2026-02-25.clover",
    localTargetId,
    promotionCodeId: "promo_123",
  });
  const first = await beginReferralProviderOperation({
    environment: "stripe",
    livemode: false,
    operationType: "checkout_session_create",
    localTargetId,
    idempotencyKey: "idem_123",
    requestFingerprint: fingerprint,
    requestPayload: { apiVersion: "2026-02-25.clover", localTargetId, promotionCodeId: "promo_123" },
  }, db);
  const replay = await beginReferralProviderOperation({
    environment: "stripe",
    livemode: false,
    operationType: "checkout_session_create",
    localTargetId,
    idempotencyKey: "idem_123",
    requestFingerprint: fingerprint,
    requestPayload: { apiVersion: "2026-02-25.clover", localTargetId, promotionCodeId: "promo_123" },
  }, db);

  assert.equal(replay.id, first.id);
  await assert.rejects(
    () => beginReferralProviderOperation({
      environment: "stripe",
      livemode: false,
      operationType: "checkout_session_create",
      localTargetId,
      idempotencyKey: "idem_other",
      requestFingerprint: fingerprint,
      requestPayload: { apiVersion: "2026-02-25.clover", localTargetId, promotionCodeId: "promo_123" },
    }, db),
    (error) => {
      assertReferralError(error, "provider_operation_replay_mismatch");
      return true;
    },
  );
  const rows = await db.select().from(referralDiscountProviderOperations);
  assert.equal(rows.length, 1);
});

test("provider_operation_cas_preserves_confirmed_terminal_state", async ({ db }) => {
  const localTargetId = randomUUID();
  const operation = await beginReferralProviderOperation({
    environment: "stripe",
    livemode: false,
    operationType: "checkout_session_create",
    localTargetId,
    idempotencyKey: "idem_terminal",
    requestFingerprint: fingerprintReferralProviderRequest({ localTargetId, promotionCodeId: "promo_terminal" }),
    requestPayload: { localTargetId, promotionCodeId: "promo_terminal" },
  }, db);
  await markReferralProviderOperationStarted(operation.id, { providerRequestId: "req_1" }, db);
  const confirmed = await confirmReferralProviderOperation(operation.id, {
    providerObjectId: "cs_terminal",
    providerRequestId: "req_1",
  }, db);

  const startedReplay = await markReferralProviderOperationStarted(operation.id, { providerRequestId: "req_2" }, db);
  assert.equal(startedReplay.state, "confirmed");
  assert.equal(startedReplay.providerObjectId, "cs_terminal");
  const confirmedReplay = await confirmReferralProviderOperation(operation.id, {
    providerObjectId: "cs_terminal",
    providerRequestId: "req_1",
  }, db);
  assert.equal(confirmedReplay.id, confirmed.id);
  await assert.rejects(
    () => parkReferralProviderOperation(operation.id, {
      code: "provider_operation_ambiguous",
      message: "late catch must not overwrite terminal",
    }, db),
    (error) => {
      assertReferralError(error, "provider_operation_replay_mismatch");
      return true;
    },
  );
  await assert.rejects(
    () => confirmReferralProviderOperation(operation.id, {
      providerObjectId: "cs_changed",
      providerRequestId: "req_1",
    }, db),
    (error) => {
      assertReferralError(error, "provider_operation_replay_mismatch");
      return true;
    },
  );
  const [row] = await db.select().from(referralDiscountProviderOperations)
    .where(eq(referralDiscountProviderOperations.id, operation.id));
  assert.equal(row.state, "confirmed");
  assert.equal(row.providerObjectId, "cs_terminal");
  assert.equal(row.sanitizedErrorCode, null);
});

test("confirmed_referral_checkout_operation_retrieves_provider_session_without_second_create", async () => {
  const calls = { create: 0, retrieve: 0 };
  const stripe = {
    checkout: {
      sessions: {
        create: async () => {
          calls.create += 1;
          return { id: "cs_new" };
        },
        retrieve: async (id: string) => {
          calls.retrieve += 1;
          return { id };
        },
      },
    },
  } as never;

  const session = await __invokeReferralCheckoutProviderForTests(stripe, {
    operationState: "confirmed",
    providerObjectId: "cs_confirmed",
    idempotencyKey: "idem_confirmed",
    requestPayload: {
      apiVersion: "2026-02-25.clover",
      mode: "subscription",
      successUrl: "https://example.test/success",
      cancelUrl: "https://example.test/cancel",
      clientReferenceId: "server_1",
      customer: null,
      discounts: [{ promotion_code: "promo_1" }],
      lineItems: [{ price: "price_1", quantity: 1 }],
      metadata: {},
      subscriptionData: { metadata: {} },
      reservationExpiresAt: CHECKOUT_EXPIRES_AT.toISOString(),
    },
  });

  assert.equal((session as { id: string }).id, "cs_confirmed");
  assert.deepEqual(calls, { create: 0, retrieve: 1 });
});

test("started_referral_checkout_operation_replays_exact_stored_create_request_and_key", async () => {
  const calls: Array<{ params: unknown; options: unknown }> = [];
  const stripe = {
    checkout: {
      sessions: {
        create: async (params: unknown, options: unknown) => {
          calls.push({ params, options });
          return { id: "cs_created" };
        },
        retrieve: async () => {
          throw new Error("retrieve should not be called for started operation");
        },
      },
    },
  } as never;
  const requestPayload = {
    apiVersion: "2026-02-25.clover",
    mode: "subscription",
    successUrl: "https://example.test/success",
    cancelUrl: "https://example.test/cancel",
    clientReferenceId: "server_1",
    customer: "cus_existing",
    discounts: [{ promotion_code: "promo_1" }],
    lineItems: [{ price: "price_1", quantity: 2 }],
    metadata: { referralRedemptionId: "redemption_1" },
    subscriptionData: { metadata: { referralRedemptionId: "redemption_1" } },
    reservationExpiresAt: CHECKOUT_EXPIRES_AT.toISOString(),
  };

  await __invokeReferralCheckoutProviderForTests(stripe, {
    operationState: "provider_started",
    providerObjectId: null,
    idempotencyKey: "idem_started",
    requestPayload,
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, { idempotencyKey: "idem_started" });
  assert.deepEqual(calls[0].params, {
    mode: "subscription",
    success_url: requestPayload.successUrl,
    cancel_url: requestPayload.cancelUrl,
    client_reference_id: requestPayload.clientReferenceId,
    customer: requestPayload.customer,
    discounts: requestPayload.discounts,
    line_items: requestPayload.lineItems,
    metadata: requestPayload.metadata,
    subscription_data: requestPayload.subscriptionData,
  });
});

test("provider_operation_parking_sanitizes_secret_shaped_messages", async ({ db }) => {
  const localTargetId = randomUUID();
  const operation = await beginReferralProviderOperation({
    environment: "stripe",
    livemode: false,
    operationType: "checkout_session_create",
    localTargetId,
    idempotencyKey: "idem_sanitize",
    requestFingerprint: fingerprintReferralProviderRequest({ localTargetId }),
    requestPayload: { localTargetId },
  }, db);

  const parked = await parkReferralProviderOperation(operation.id, {
    code: "unknown_raw_provider_error",
    // Built at runtime so secret scanners don't flag this test sample.
    message: "Stripe failed with sk_" + "test_SECRETSECRETSECRETSECRET and referral HUMAN-CODE-ABCDEF0123456789",
  }, db);

  assert.equal(parked.sanitizedErrorCode, "provider_unavailable");
  assert.match(parked.sanitizedErrorMessage ?? "", /redacted-stripe-key/);
  assert.doesNotMatch(parked.sanitizedErrorMessage ?? "", /sk_test_SECRET/);
  assert.doesNotMatch(parked.sanitizedErrorMessage ?? "", /HUMAN-CODE-ABCDEF0123456789/);
});

test("provider_event_replay_requires_same_payload_hash", async ({ db }) => {
  const payloadHash = hashReferralProviderPayload({ invoiceId: "in_123", promotion: "promo_123" });
  const first = await ingestReferralProviderEvent({
    environment: "stripe",
    livemode: false,
    stripeEventId: "evt_referral_invoice",
    stripeEventType: "invoice.paid",
    providerObjectId: "in_123",
    sourceApiVersion: "2026-02-25.clover",
    payloadHash,
  }, db);
  const replay = await ingestReferralProviderEvent({
    environment: "stripe",
    livemode: false,
    stripeEventId: "evt_referral_invoice",
    stripeEventType: "invoice.paid",
    providerObjectId: "in_123",
    sourceApiVersion: "2026-02-25.clover",
    payloadHash,
  }, db);

  assert.equal(replay.id, first.id);
  await assert.rejects(
    () => ingestReferralProviderEvent({
      environment: "stripe",
      livemode: false,
      stripeEventId: "evt_referral_invoice",
      stripeEventType: "invoice.paid",
      providerObjectId: "in_123",
      sourceApiVersion: "2026-02-25.clover",
      payloadHash: hashReferralProviderPayload({ invoiceId: "in_123", promotion: "promo_other" }),
    }, db),
    (error) => {
      assertReferralError(error, "provider_event_replay_mismatch");
      return true;
    },
  );
  const rows = await db.select().from(referralDiscountProviderEvents);
  assert.equal(rows.length, 1);
});

test("provider_event_transition_stays_parked_when_business_transition_fails", async ({ db, seed }) => {
  const { redemption } = await reserveFixture({ db, seed });
  const payloadHash = hashReferralProviderPayload({ sessionId: "cs_atomic", redemptionId: redemption.id });

  await assert.rejects(
    () => applyReferralProviderEvent({
      environment: "stripe",
      livemode: false,
      stripeEventId: "evt_atomic_failure",
      stripeEventType: "checkout.session.completed",
      providerObjectId: "cs_atomic",
      sourceApiVersion: "2026-02-25.clover",
      payloadHash,
      normalizedPayload: { sessionId: "cs_atomic", redemptionId: redemption.id },
    }, async (tx) => {
      await markReferralCheckoutCompleted(redemption.id, {
        stripeCheckoutSessionId: "cs_atomic",
        stripeCustomerId: null,
        stripeSubscriptionId: null,
      }, tx);
    }, db),
  );

  const [event] = await db.select().from(referralDiscountProviderEvents)
    .where(eq(referralDiscountProviderEvents.stripeEventId, "evt_atomic_failure"));
  assert.equal(event.processingState, "parked");
  assert.deepEqual(event.normalizedPayload, { sessionId: "cs_atomic", redemptionId: redemption.id });
  const [row] = await db.select().from(referralDiscountRedemptions)
    .where(eq(referralDiscountRedemptions.id, redemption.id));
  assert.equal(row.acquisitionState, "reserved");
});

test("provider_event_marks_applied_atomically_with_business_transition", async ({ db, seed }) => {
  const { redemption } = await reserveFixture({ db, seed });
  const payloadHash = hashReferralProviderPayload({ sessionId: "cs_atomic_success", redemptionId: redemption.id });

  await applyReferralProviderEvent({
    environment: "stripe",
    livemode: false,
    stripeEventId: "evt_atomic_success",
    stripeEventType: "checkout.session.completed",
    providerObjectId: "cs_atomic_success",
    sourceApiVersion: "2026-02-25.clover",
    payloadHash,
    normalizedPayload: { sessionId: "cs_atomic_success", redemptionId: redemption.id },
  }, async (tx) => {
    await markReferralCheckoutCreated(redemption.id, {
      decisionAt: DECISION_AT,
      stripeCheckoutSessionId: "cs_atomic_success",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      reservationExpiresAt: CHECKOUT_EXPIRES_AT,
    }, tx);
    await markReferralCheckoutCompleted(redemption.id, {
      stripeCheckoutSessionId: "cs_atomic_success",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    }, tx);
  }, db);

  const [event] = await db.select().from(referralDiscountProviderEvents)
    .where(eq(referralDiscountProviderEvents.stripeEventId, "evt_atomic_success"));
  assert.equal(event.processingState, "applied");
  const [row] = await db.select().from(referralDiscountRedemptions)
    .where(eq(referralDiscountRedemptions.id, redemption.id));
  assert.equal(row.acquisitionState, "checkout_completed");
});

test("checkout_referral_metadata_requires_both_layers_and_exact_equality", () => {
  const metadata = buildReferralCheckoutMetadata({
    redemptionId: randomUUID(),
    codeId: randomUUID(),
    campaignId: randomUUID(),
    referrerUserId: randomUUID(),
    providerStrategy: "stripe_coupon_repeating_v1@2026-02-25.clover",
  });

  assert.equal(assertReferralCheckoutMetadataPair(metadata, metadata).redemptionId, metadata.referralRedemptionId);
  assert.throws(
    () => assertReferralCheckoutMetadataPair(metadata, { ...metadata, referralCodeId: randomUUID() }),
    (error) => {
      assertReferralError(error, "referral_metadata_mismatch");
      return true;
    },
  );
  assert.throws(
    () => assertReferralCheckoutMetadataPair(metadata, { ...metadata, referralProviderStrategy: undefined }),
    (error) => {
      assertReferralError(error, "referral_metadata_mismatch");
      return true;
    },
  );
});

test("referral_diagnostic_token_requires_keyed_non_reversible_secret", () => {
  assert.throws(() => referralDiagnosticToken("SLOPPY-CODE", ""), /REFERRAL_DISCOUNT_DIAGNOSTIC_KEY/);
  const one = referralDiagnosticToken("SLOPPY-CODE", "0123456789abcdef");
  const two = referralDiagnosticToken("sloppy-code", "0123456789abcdef");
  assert.equal(one, two);
  assert.notEqual(one, normalizeReferralCode("SLOPPY-CODE"));
});

test("reservation_by_code_reruns_eligibility_and_uses_code_owner", async ({ db, seed }) => {
  const fixture = await createReferralFixture({ db, seed });

  const redemption = await createReferralReservationForCode({
    environment: "stripe",
    livemode: true,
    historyOriginAt: HISTORY_ORIGIN,
    decisionAt: DECISION_AT,
    normalizedCode: normalizeReferralCode(fixture.code.displayCode),
    redeemingUserId: fixture.redeemer.id,
    referredServerId: fixture.server.id,
    reservationExpiresAt: CHECKOUT_EXPIRES_AT,
  }, db);

  assert.equal(redemption.codeId, fixture.code.id);
  assert.equal(redemption.campaignId, fixture.campaign.id);
  assert.equal(redemption.referrerUserId, fixture.referrer.id);
  assert.equal(redemption.acquisitionState, "reserved");
});

test("active_reservation_by_code_replays_same_local_target_for_same_key_resume", async ({ db, seed }) => {
  const fixture = await createReferralFixture({ db, seed });
  await db.update(referralDiscountCampaigns)
    .set({ billingIntervalScope: "monthly" })
    .where(eq(referralDiscountCampaigns.id, fixture.campaign.id));

  const input = {
    environment: "stripe",
    livemode: true,
    historyOriginAt: HISTORY_ORIGIN,
    decisionAt: DECISION_AT,
    normalizedCode: normalizeReferralCode(fixture.code.displayCode),
    targetProductScope: "pro" as const,
    targetBillingInterval: "monthly" as const,
    redeemingUserId: fixture.redeemer.id,
    referredServerId: fixture.server.id,
    stripeCustomerId: "cus_same_key",
    reservationExpiresAt: CHECKOUT_EXPIRES_AT,
    referralCheckoutIdempotencyKey: "referral-checkout:same-key",
  };
  const first = await createReferralReservationForCode(input, db);
  const replay = await readActiveReferralReservationForCode(input, db);

  assert.ok(replay);
  assert.equal(replay.id, first.id);
  assert.equal(replay.referralCheckoutIdempotencyKey, "referral-checkout:same-key");
  assert.equal(replay.targetBillingInterval, "monthly");
  assert.equal(await readActiveReferralReservationForCode({ ...input, targetBillingInterval: "annual" }, db), null);
});

test("campaign_product_interval_scope_is_frozen_at_preview_reservation_and_qualification", async ({ db, seed }) => {
  const fixture = await createReferralFixture({ db, seed });
  await db.update(referralDiscountCampaigns)
    .set({ billingIntervalScope: "monthly" })
    .where(eq(referralDiscountCampaigns.id, fixture.campaign.id));

  await previewReferralCode({
    environment: "stripe",
    livemode: true,
    historyOriginAt: HISTORY_ORIGIN,
    decisionAt: DECISION_AT,
    normalizedCode: normalizeReferralCode(fixture.code.displayCode),
    targetProductScope: "pro",
    targetBillingInterval: "monthly",
    redeemingUserId: fixture.redeemer.id,
    referredServerId: fixture.server.id,
  }, db);
  await assert.rejects(
    () => previewReferralCode({
      environment: "stripe",
      livemode: true,
      historyOriginAt: HISTORY_ORIGIN,
      decisionAt: DECISION_AT,
      normalizedCode: normalizeReferralCode(fixture.code.displayCode),
      targetProductScope: "pro",
      targetBillingInterval: "annual",
      redeemingUserId: fixture.redeemer.id,
      referredServerId: fixture.server.id,
    }, db),
    (error) => {
      assertReferralError(error, "code_not_redeemable");
      return true;
    },
  );

  const redemption = await createReferralReservationForCode({
    environment: "stripe",
    livemode: true,
    historyOriginAt: HISTORY_ORIGIN,
    decisionAt: DECISION_AT,
    normalizedCode: normalizeReferralCode(fixture.code.displayCode),
    targetProductScope: "pro",
    targetBillingInterval: "monthly",
    redeemingUserId: fixture.redeemer.id,
    referredServerId: fixture.server.id,
    reservationExpiresAt: CHECKOUT_EXPIRES_AT,
  }, db);
  await db.update(referralDiscountRedemptions)
    .set({ reservedAt: DECISION_AT })
    .where(eq(referralDiscountRedemptions.id, redemption.id));
  await completeCheckout(redemption.id, db);
  await assert.rejects(
    () => qualifyReferralInvoicePayment({
      redemptionId: redemption.id,
      firstPaidInvoiceId: `in_${randomUUID()}`,
      stripeSubscriptionId: null,
      stripeCustomerId: null,
      stripePromotionCodeId: fixture.code.stripePromotionCodeId ?? "promo_missing",
      stripeCouponId: fixture.campaign.stripeCouponId ?? "coupon_missing",
      stripePriceId: "price_annual",
      billingInterval: "annual",
      expectedPriceIds: ["price_monthly", "price_annual"],
    }, db),
    (error) => {
      assertReferralError(error, "referral_scope_mismatch");
      return true;
    },
  );
});

test("paid_history_coverage_missing_denies_referral_eligibility", async ({ db, seed }) => {
  const referrer = await seed.human();
  const redeemer = await seed.human();
  const owner = await seed.human();
  const server = await seed.server({ owner });

  const decision = await evaluateReferralEligibility({
    environment: "stripe",
    livemode: true,
    historyOriginAt: HISTORY_ORIGIN,
    decisionAt: DECISION_AT,
    referrerUserId: referrer.id,
    redeemingUserId: redeemer.id,
    referredServerId: server.id,
  }, db);

  assert.deepEqual(decision, { eligible: false, reason: "paid_history_incomplete" });
});

test("paid_history_coverage_wrong_livemode_denies_referral_eligibility", async ({ db, seed }) => {
  const referrer = await seed.human();
  const redeemer = await seed.human();
  const owner = await seed.human();
  const server = await seed.server({ owner });
  await upsertPaidHistoryCoverage({
    environment: "stripe",
    livemode: false,
    coverageOriginAt: HISTORY_ORIGIN,
    coverageWatermarkAt: WATERMARK,
    completedAt: WATERMARK,
    source: "test-backfill",
    auditReason: "test coverage",
  }, db);

  const decision = await evaluateReferralEligibility({
    environment: "stripe",
    livemode: true,
    historyOriginAt: HISTORY_ORIGIN,
    decisionAt: DECISION_AT,
    referrerUserId: referrer.id,
    redeemingUserId: redeemer.id,
    referredServerId: server.id,
  }, db);

  assert.deepEqual(decision, { eligible: false, reason: "paid_history_incomplete" });
});

test("paid_history_coverage_same_livemode_different_environment_denies_referral_eligibility", async ({ db, seed }) => {
  const referrer = await seed.human();
  const redeemer = await seed.human();
  const owner = await seed.human();
  const server = await seed.server({ owner });
  await upsertPaidHistoryCoverage({
    environment: "stripe-other",
    livemode: true,
    coverageOriginAt: HISTORY_ORIGIN,
    coverageWatermarkAt: WATERMARK,
    completedAt: WATERMARK,
    source: "test-backfill",
    auditReason: "test coverage",
  }, db);

  const decision = await evaluateReferralEligibility({
    environment: "stripe",
    livemode: true,
    historyOriginAt: HISTORY_ORIGIN,
    decisionAt: DECISION_AT,
    referrerUserId: referrer.id,
    redeemingUserId: redeemer.id,
    referredServerId: server.id,
  }, db);

  assert.deepEqual(decision, { eligible: false, reason: "paid_history_incomplete" });
});

test("paid_history_coverage_parked_before_coverage_keeps_authority_incomplete", async ({ db, seed }) => {
  const referrer = await seed.human();
  const redeemer = await seed.human();
  const owner = await seed.human();
  const server = await seed.server({ owner });
  await ingestNormalizedPaidIdentityFact({
    environment: "stripe",
    livemode: true,
    stripeEventId: `evt_${randomUUID()}`,
    stripeInvoiceId: `in_${randomUUID()}`,
    stripeProductId: "prod_pro",
    stripePriceId: "price_pro",
    serverId: server.id,
    payerUserId: redeemer.id,
    ownerUserId: null,
    paidAt: new Date("2026-03-01T00:00:00.000Z"),
    currency: "usd",
    invoiceSubtotal: 1000,
    invoiceTotal: 1000,
    amountPaid: 1000,
    source: "test-normalized-fact",
  }, db);
  const coverage = await upsertPaidHistoryCoverage({
    environment: "stripe",
    livemode: true,
    coverageOriginAt: HISTORY_ORIGIN,
    coverageWatermarkAt: WATERMARK,
    completedAt: WATERMARK,
    source: "test-backfill",
    auditReason: "test coverage",
  }, db);

  assert.equal(coverage.unresolvedIdentityCount, 1);
  const decision = await evaluateReferralEligibility({
    environment: "stripe",
    livemode: true,
    historyOriginAt: HISTORY_ORIGIN,
    decisionAt: DECISION_AT,
    referrerUserId: referrer.id,
    redeemingUserId: redeemer.id,
    referredServerId: server.id,
  }, db);

  assert.deepEqual(decision, { eligible: false, reason: "paid_history_incomplete" });
});

test("paid_identity_resolution_unblocks_only_matching_environment_after_complete_coverage", async ({ db, seed }) => {
  const referrer = await seed.human();
  const redeemer = await seed.human();
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const otherServer = await seed.server({ owner });
  const stripeEventId = `evt_${randomUUID()}`;
  await ingestNormalizedPaidIdentityFact({
    environment: "stripe",
    livemode: true,
    stripeEventId,
    stripeInvoiceId: `in_${randomUUID()}`,
    stripeProductId: "prod_pro",
    stripePriceId: "price_pro",
    serverId: null,
    payerUserId: null,
    ownerUserId: null,
    paidAt: new Date("2026-03-01T00:00:00.000Z"),
    currency: "usd",
    invoiceSubtotal: 1000,
    invoiceTotal: 1000,
    amountPaid: 1000,
    source: "test-normalized-fact",
  }, db);
  await upsertPaidHistoryCoverage({
    environment: "stripe",
    livemode: true,
    coverageOriginAt: HISTORY_ORIGIN,
    coverageWatermarkAt: WATERMARK,
    completedAt: WATERMARK,
    source: "test-backfill",
    auditReason: "test coverage",
  }, db);
  await upsertPaidHistoryCoverage({
    environment: "stripe-other",
    livemode: true,
    coverageOriginAt: HISTORY_ORIGIN,
    coverageWatermarkAt: WATERMARK,
    completedAt: WATERMARK,
    source: "test-backfill",
    auditReason: "other coverage",
  }, db);

  await resolvePaidIdentityFact({
    environment: "stripe",
    livemode: true,
    stripeEventId,
    serverId: server.id,
    payerUserId: redeemer.id,
    ownerUserId: owner.id,
    source: "test-resolver",
    auditReason: "resolved missing identity",
  }, db);

  const [event] = await db.select().from(billingPaidIdentityEvents);
  assert.equal(event.identityResolutionState, "parked", "raw fact stays append-only and parked");
  assert.equal(event.serverId, null);
  const [resolution] = await db.select().from(billingPaidIdentityResolutions);
  assert.equal(resolution.serverId, server.id);
  const stripeDecision = await evaluateReferralEligibility({
    environment: "stripe",
    livemode: true,
    historyOriginAt: HISTORY_ORIGIN,
    decisionAt: DECISION_AT,
    referrerUserId: referrer.id,
    redeemingUserId: redeemer.id,
    referredServerId: otherServer.id,
  }, db);
  assert.deepEqual(stripeDecision, { eligible: false, reason: "prior_paid_user" });
  const otherDecision = await evaluateReferralEligibility({
    environment: "stripe-other",
    livemode: true,
    historyOriginAt: HISTORY_ORIGIN,
    decisionAt: DECISION_AT,
    referrerUserId: referrer.id,
    redeemingUserId: redeemer.id,
    referredServerId: otherServer.id,
  }, db);
  assert.deepEqual(otherDecision, { eligible: true });
});

test("paid_identity_resolution_conflict_fails_closed", async ({ db, seed }) => {
  const payer = await seed.human();
  const owner = await seed.human();
  const otherOwner = await seed.human();
  const server = await seed.server({ owner });
  const stripeEventId = `evt_${randomUUID()}`;
  await ingestNormalizedPaidIdentityFact({
    environment: "stripe",
    livemode: true,
    stripeEventId,
    stripeInvoiceId: `in_${randomUUID()}`,
    stripeProductId: "prod_pro",
    stripePriceId: "price_pro",
    paidAt: new Date("2026-03-01T00:00:00.000Z"),
    currency: "usd",
    invoiceSubtotal: 1000,
    invoiceTotal: 1000,
    amountPaid: 1000,
    source: "test-normalized-fact",
  }, db);
  await resolvePaidIdentityFact({
    environment: "stripe",
    livemode: true,
    stripeEventId,
    serverId: server.id,
    payerUserId: payer.id,
    ownerUserId: owner.id,
    source: "test-resolver",
    auditReason: "first resolution",
  }, db);

  await assert.rejects(
    () => resolvePaidIdentityFact({
      environment: "stripe",
      livemode: true,
      stripeEventId,
      serverId: server.id,
      payerUserId: payer.id,
      ownerUserId: otherOwner.id,
      source: "test-resolver",
      auditReason: "conflicting resolution",
    }, db),
    (error) => {
      assertReferralError(error, "identity_resolution_conflict");
      return true;
    },
  );
});

test("paid_history_coverage_attempted_reset_or_regression_does_not_clear_unresolved_history", async ({ db, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  await upsertPaidHistoryCoverage({
    environment: "stripe",
    livemode: true,
    coverageOriginAt: HISTORY_ORIGIN,
    coverageWatermarkAt: WATERMARK,
    completedAt: WATERMARK,
    source: "test-backfill",
    auditReason: "test coverage",
  }, db);
  await ingestNormalizedPaidIdentityFact({
    environment: "stripe",
    livemode: true,
    stripeEventId: `evt_${randomUUID()}`,
    stripeInvoiceId: `in_${randomUUID()}`,
    stripeProductId: "prod_pro",
    stripePriceId: "price_pro",
    serverId: server.id,
    payerUserId: null,
    ownerUserId: owner.id,
    paidAt: new Date("2026-03-01T00:00:00.000Z"),
    currency: "usd",
    invoiceSubtotal: 1000,
    invoiceTotal: 1000,
    amountPaid: 1000,
    source: "test-normalized-fact",
  }, db);

  const reset = await upsertPaidHistoryCoverage({
    environment: "stripe",
    livemode: true,
    coverageOriginAt: new Date("2026-05-01T00:00:00.000Z"),
    coverageWatermarkAt: new Date("2026-06-01T00:00:00.000Z"),
    completedAt: new Date("2026-06-01T00:00:00.000Z"),
    source: "test-backfill",
    auditReason: "attempted reset",
    unresolvedIdentityCount: 0,
  }, db);

  assert.equal(reset.coverageOriginAt.getTime(), HISTORY_ORIGIN.getTime());
  assert.equal(reset.coverageWatermarkAt.getTime(), WATERMARK.getTime());
  assert.equal(reset.unresolvedIdentityCount, 1);
});

test("paid_identity_ledger_requires_livemode_event_invoice_and_pro_lineage", async ({ db }) => {
  await assert.rejects(
    () => db.execute(sql`
      INSERT INTO billing_paid_identity_events
        (environment, stripe_event_id, stripe_invoice_id, paid_fact_kind, stripe_product_id, stripe_price_id,
         identity_resolution_state, paid_at, currency, invoice_subtotal, invoice_total, amount_paid, source)
      VALUES
        ('stripe', 'evt_missing_livemode', 'in_missing_livemode', 'pro_invoice_paid', 'prod_pro', 'price_pro',
         'parked', now(), 'usd', 1000, 1000, 1000, 'test')
    `),
  );
  await assert.rejects(
    () => db.execute(sql`
      INSERT INTO billing_paid_identity_events
        (environment, livemode, stripe_event_id, stripe_invoice_id, paid_fact_kind, stripe_product_id, stripe_price_id,
         identity_resolution_state, paid_at, currency, invoice_subtotal, invoice_total, amount_paid, source)
      VALUES
        ('stripe', true, NULL, 'in_missing_event', 'pro_invoice_paid', 'prod_pro', 'price_pro',
         'parked', now(), 'usd', 1000, 1000, 1000, 'test')
    `),
  );
  await assert.rejects(
    () => db.execute(sql`
      INSERT INTO billing_paid_identity_events
        (environment, livemode, stripe_event_id, stripe_invoice_id, paid_fact_kind, stripe_product_id, stripe_price_id,
         identity_resolution_state, paid_at, currency, invoice_subtotal, invoice_total, amount_paid, source)
      VALUES
        ('stripe', true, 'evt_missing_price', 'in_missing_price', 'pro_invoice_paid', 'prod_pro', NULL,
         'parked', now(), 'usd', 1000, 1000, 1000, 'test')
    `),
  );
});

test("paid_identity_missing_payer_or_owner_fails_closed_for_that_axis", async ({ db, seed }) => {
  const referrer = await seed.human();
  const redeemer = await seed.human();
  const owner = await seed.human();
  const server = await seed.server({ owner });
  await upsertPaidHistoryCoverage({
    environment: "stripe",
    livemode: true,
    coverageOriginAt: HISTORY_ORIGIN,
    coverageWatermarkAt: WATERMARK,
    completedAt: WATERMARK,
    source: "test-backfill",
    auditReason: "test coverage",
  }, db);
  await ingestNormalizedPaidIdentityFact({
    environment: "stripe",
    livemode: true,
    stripeEventId: `evt_${randomUUID()}`,
    stripeInvoiceId: `in_${randomUUID()}`,
    stripeProductId: "prod_pro",
    stripePriceId: "price_pro",
    serverId: server.id,
    payerUserId: redeemer.id,
    ownerUserId: null,
    paidAt: new Date("2026-03-01T00:00:00.000Z"),
    currency: "usd",
    invoiceSubtotal: 1000,
    invoiceTotal: 1000,
    amountPaid: 1000,
    source: "test-normalized-fact",
  }, db);

  const decision = await evaluateReferralEligibility({
    environment: "stripe",
    livemode: true,
    historyOriginAt: HISTORY_ORIGIN,
    decisionAt: DECISION_AT,
    referrerUserId: referrer.id,
    redeemingUserId: redeemer.id,
    referredServerId: server.id,
  }, db);

  assert.deepEqual(decision, { eligible: false, reason: "paid_history_incomplete" });
});

test("paid_identity_ledger_ingests_normalized_invoice_paid_fact_append_only", async ({ db, seed }) => {
  const payer = await seed.human();
  const owner = await seed.human();
  const server = await seed.server({ owner });
  await upsertPaidHistoryCoverage({
    environment: "stripe",
    livemode: true,
    coverageOriginAt: HISTORY_ORIGIN,
    coverageWatermarkAt: WATERMARK,
    completedAt: WATERMARK,
    source: "test-backfill",
    auditReason: "test coverage",
  }, db);
  const eventId = `evt_${randomUUID()}`;
  const invoiceId = `in_${randomUUID()}`;
  const paidAt = new Date("2026-03-01T00:00:00.000Z");

  const fact = {
    environment: "stripe",
    livemode: true,
    stripeEventId: eventId,
    stripeInvoiceId: invoiceId,
    stripeProductId: "prod_pro",
    stripePriceId: "price_pro",
    serverId: server.id,
    payerUserId: payer.id,
    ownerUserId: owner.id,
    paidAt,
    currency: "USD",
    invoiceSubtotal: 1000,
    invoiceTotal: 1000,
    amountPaid: 1000,
    source: "test-normalized-fact",
  } as const;

  const first = await ingestNormalizedPaidIdentityFact(fact, db);
  const replay = await ingestNormalizedPaidIdentityFact(fact, db);

  assert.equal(replay.id, first.id);
  await assert.rejects(
    () => ingestNormalizedPaidIdentityFact({ ...fact, stripeInvoiceId: `in_different_${randomUUID()}`, invoiceTotal: 2000, amountPaid: 2000 }, db),
    (error) => {
      assertReferralError(error, "paid_fact_replay_mismatch");
      return true;
    },
  );
  const rows = await db.select().from(billingPaidIdentityEvents);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].invoiceTotal, 1000);
  assert.equal(rows[0].currency, "usd");
});

test("provider_provisioning_started_at_locks_campaign_economics_irreversibly", async ({ db }) => {
  const [campaign] = await db.insert(referralDiscountCampaigns).values({
    name: "Provider lock",
    status: "draft",
    providerState: "pending",
    providerStrategy: "stripe_coupon_repeating_v1",
    percentOff: 20,
    durationMonths: 3,
    mutationReason: "test",
  }).returning();

  await updateCampaignEconomics(campaign.id, { percentOff: 25, mutationReason: "before provider" }, db);
  await markCampaignProviderProvisioningStarted(campaign.id, db);

  await assert.rejects(
    () => updateCampaignEconomics(campaign.id, { percentOff: 30, mutationReason: "after provider" }, db),
    (error) => {
      assertReferralError(error, "campaign_economics_locked");
      return true;
    },
  );
});

test("provider_failed_retry_cannot_change_campaign_economics", async ({ db }) => {
  const [campaign] = await db.insert(referralDiscountCampaigns).values({
    name: "Provider failed retry",
    status: "draft",
    providerState: "failed",
    providerProvisioningStartedAt: new Date("2026-10-09T16:00:00.000Z"),
    providerStrategy: "stripe_coupon_repeating_v1",
    percentOff: 20,
    durationMonths: 3,
    mutationReason: "test",
  }).returning();

  await assert.rejects(
    () => updateCampaignEconomics(campaign.id, { durationMonths: 6, mutationReason: "retry changed economics" }, db),
    (error) => {
      assertReferralError(error, "campaign_economics_locked");
      return true;
    },
  );
});

test("referral_stripe_acceptance_requires_explicit_opt_in_profile_expected_account_and_test_key", async () => {
  assert.deepEqual(referralStripeAcceptanceAuthorizationFromEnv({}), {
    status: "not_run",
    reason: "NOT_RUN_UNAUTHORIZED",
  });
  assert.deepEqual(referralStripeAcceptanceAuthorizationFromEnv({
    REFERRAL_DISCOUNT_STRIPE_ACCEPTANCE: "1",
    REFERRAL_DISCOUNT_STRIPE_EXPECTED_ACCOUNT_ID: "acct_expected",
    REFERRAL_DISCOUNT_STRIPE_PROFILE: "sandbox",
    REFERRAL_DISCOUNT_STRIPE_SECRET_KEY: "sk_live_forbidden",
  }), {
    status: "not_run",
    reason: "NOT_RUN_UNAUTHORIZED",
  });

  const notRun = await runReferralStripeAccountAcceptanceForTests({} as any, {
    REFERRAL_DISCOUNT_STRIPE_ACCEPTANCE: "0",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(notRun, { status: "not_run", reason: "NOT_RUN_UNAUTHORIZED" });
});

test("referral_stripe_account_proof_checks_account_balance_test_mode_and_pinned_api_version", async () => {
  const fixture = await loadReferralFixture<{ objects: any[] }>("account-proof.json");
  const stripe = {
    accounts: { retrieve: async () => fixture.objects[0] },
    balance: { retrieve: async () => fixture.objects[1] },
  };

  const proof = await proveReferralStripeAccountForTests(stripe as any, "acct_referral_test");
  assert.deepEqual(proof, {
    status: "ok",
    accountId: "acct_referral_test",
    livemode: false,
    apiVersion: REFERRAL_STRIPE_API_VERSION,
  });

  await assert.rejects(
    () => proveReferralStripeAccountForTests(stripe as any, "acct_wrong"),
    /account id mismatch/,
  );
  await assert.rejects(
    () => proveReferralStripeAccountForTests(accountProofClient({ accountApiVersion: null }) as any, "acct_referral_test"),
    /API version mismatch/,
  );
});

test("referral_duration_acceptance_defaults_not_run_without_authorization", async () => {
  let factoryCalls = 0;
  const result = await runReferralDurationAcceptanceForTests({}, () => {
    factoryCalls += 1;
    return accountProofClient({
      coupons: {
        create: async () => {
          throw new Error("must not create without authorization");
        },
      },
    }) as any;
  });
  assert.deepEqual(result, { status: "not_run", reason: "NOT_RUN_UNAUTHORIZED" });
  assert.equal(factoryCalls, 0);

  const readiness = await runReferralProviderProvisioningReadinessForTests({});
  assert.deepEqual(readiness, { status: "not_run", reason: "NOT_RUN_UNAUTHORIZED" });
});

test("referral_duration_acceptance_cleans_up_authorized_coupon", async () => {
  const previousGlobalKey = process.env.REFERRAL_DISCOUNT_STRIPE_SECRET_KEY;
  process.env.REFERRAL_DISCOUNT_STRIPE_SECRET_KEY = "sk_test_global_must_not_be_used";
  let createdId = "";
  let deleteCalls = 0;
  const stripe = accountProofClient({
    coupons: {
      create: async (params: any) => {
        createdId = params.id;
        return testCoupon({
          campaignId: params.metadata.referral_campaign_id,
          couponId: params.id,
          percentOff: params.percent_off,
          durationMonths: params.duration_in_months,
          maxRedemptions: params.max_redemptions,
        });
      },
      retrieve: async (id: string) => {
        assert.equal(id, createdId);
        return testCoupon({
          campaignId: `acceptance-${createdId.replace("raft_ref_accept_", "")}`,
          couponId: id,
          percentOff: 1,
          durationMonths: 1,
          maxRedemptions: 1,
        });
      },
      del: async (id: string) => {
        deleteCalls += 1;
        assert.equal(id, createdId);
        return {
          id,
          object: "coupon",
          deleted: true,
          lastResponse: { apiVersion: REFERRAL_STRIPE_API_VERSION, requestId: "req_deleted_coupon" },
        };
      },
    },
  });

  try {
    const result = await runReferralDurationAcceptanceForTests(REFERRAL_AUTH_ENV, referralStripeFactory(stripe, (env, authorization) => {
      assert.equal(env.REFERRAL_DISCOUNT_STRIPE_SECRET_KEY, "sk_test_referral_123");
      assert.equal(authorization.profile, "sandbox");
    }) as any);
    assert.equal(result.status, "ok");
    assert.equal(result.cleanup, "confirmed");
    assert.equal(deleteCalls, 1);
  } finally {
    if (previousGlobalKey === undefined) {
      delete process.env.REFERRAL_DISCOUNT_STRIPE_SECRET_KEY;
    } else {
      process.env.REFERRAL_DISCOUNT_STRIPE_SECRET_KEY = previousGlobalKey;
    }
  }
});

test("referral_duration_acceptance_preserves_primary_create_rejection_when_cleanup_not_needed", async () => {
  let retrievedId = "";
  let deleteCalls = 0;
  const stripe = accountProofClient({
    coupons: {
      create: async () => {
        throw new Error("duration=repeating rejected by provider");
      },
      retrieve: async (id: string) => {
        retrievedId = id;
        const error: any = new Error(`No such coupon: ${id}`);
        error.statusCode = 404;
        throw error;
      },
      del: async () => {
        deleteCalls += 1;
        throw new Error("must not cleanup a proven absent coupon");
      },
    },
  });

  await assert.rejects(
    () => runReferralDurationAcceptanceForTests(REFERRAL_AUTH_ENV, referralStripeFactory(stripe) as any),
    /duration=repeating rejected/,
  );
  assert.match(retrievedId, /^raft_ref_accept_/);
  assert.equal(deleteCalls, 0);
});

test("referral_duration_acceptance_cleans_ambiguous_create_before_rethrowing_primary", async () => {
  let createdId = "";
  let deleteCalls = 0;
  const stripe = accountProofClient({
    coupons: {
      create: async (params: any) => {
        createdId = params.id;
        throw new Error("provider timeout after create request");
      },
      retrieve: async (id: string) => {
        assert.equal(id, createdId);
        return testCoupon({
          campaignId: `acceptance-${id.replace("raft_ref_accept_", "")}`,
          couponId: id,
          percentOff: 1,
          durationMonths: 1,
          maxRedemptions: 1,
        });
      },
      del: async (id: string) => {
        deleteCalls += 1;
        assert.equal(id, createdId);
        return {
          id,
          object: "coupon",
          deleted: true,
          lastResponse: { apiVersion: REFERRAL_STRIPE_API_VERSION, requestId: "req_deleted_coupon" },
        };
      },
    },
  });

  await assert.rejects(
    () => runReferralDurationAcceptanceForTests(REFERRAL_AUTH_ENV, referralStripeFactory(stripe) as any),
    /provider timeout after create request/,
  );
  assert.equal(deleteCalls, 1);
});

test("referral_duration_acceptance_preserves_primary_when_ambiguous_reconcile_fails", async () => {
  let createdId = "";
  const stripe = accountProofClient({
    coupons: {
      create: async (params: any) => {
        createdId = params.id;
        throw new Error("provider timeout after create request");
      },
      retrieve: async (id: string) => {
        assert.equal(id, createdId);
        throw new Error("retrieve timeout after ambiguous create");
      },
      del: async () => {
        throw new Error("cleanup should not run without a matched object");
      },
    },
  });

  await assert.rejects(
    () => runReferralDurationAcceptanceForTests(REFERRAL_AUTH_ENV, referralStripeFactory(stripe) as any),
    (error) => {
      assert(error instanceof Error);
      assert.match(error.message, /provider timeout after create request/);
      assert.match(error.message, /reconciliation unconfirmed/);
      assert.match(error.message, /retrieve timeout after ambiguous create/);
      return true;
    },
  );
});

test("referral_duration_acceptance_cleanup_failure_uses_redacted_locator", async () => {
  let createdId = "";
  const stripe = accountProofClient({
    coupons: {
      create: async (params: any) => {
        createdId = params.id;
        return testCoupon({
          campaignId: params.metadata.referral_campaign_id,
          couponId: params.id,
          percentOff: params.percent_off,
          durationMonths: params.duration_in_months,
          maxRedemptions: params.max_redemptions,
        });
      },
      retrieve: async (id: string) => testCoupon({
        campaignId: `acceptance-${id.replace("raft_ref_accept_", "")}`,
        couponId: id,
        percentOff: 1,
        durationMonths: 1,
        maxRedemptions: 1,
      }),
      del: async (id: string) => {
        const error: any = new Error(`No such coupon: ${id}`);
        error.statusCode = 404;
        throw error;
      },
    },
  });

  await assert.rejects(
    () => runReferralDurationAcceptanceForTests(REFERRAL_AUTH_ENV, referralStripeFactory(stripe) as any),
    (error) => {
      assert(error instanceof Error);
      assert.match(error.message, /cleanup unconfirmed/);
      assert.match(error.message, /coupon:raft_ref_accept_\[redacted\]:/);
      assert.equal(error.message.includes(createdId), false);
      return true;
    },
  );
});

test("referral_duration_acceptance_ambiguous_create_cleanup_failure_keeps_primary_and_redacted_locator", async () => {
  let createdId = "";
  const authEnvWithoutDiagnosticKey = { ...REFERRAL_AUTH_ENV };
  delete authEnvWithoutDiagnosticKey.REFERRAL_DISCOUNT_DIAGNOSTIC_KEY;
  const stripe = accountProofClient({
    coupons: {
      create: async (params: any) => {
        createdId = params.id;
        throw new Error("provider timeout after create request");
      },
      retrieve: async (id: string) => {
        assert.equal(id, createdId);
        return testCoupon({
          campaignId: `acceptance-${id.replace("raft_ref_accept_", "")}`,
          couponId: id,
          percentOff: 1,
          durationMonths: 1,
          maxRedemptions: 1,
        });
      },
      del: async (id: string) => {
        const error: any = new Error(`No such coupon: ${id}`);
        error.statusCode = 404;
        throw error;
      },
    },
  });

  await assert.rejects(
    () => runReferralDurationAcceptanceForTests(authEnvWithoutDiagnosticKey, referralStripeFactory(stripe) as any),
    (error) => {
      assert(error instanceof Error);
      assert.match(error.message, /provider timeout after create request/);
      assert.match(error.message, /cleanup unconfirmed/);
      assert.match(error.message, /coupon:raft_ref_accept_\[redacted\]:/);
      assert.equal(error.message.includes(createdId), false);
      return true;
    },
  );
});

test("referral_duration_acceptance_error_context_is_redacted_and_bounded", async () => {
  let createdId = "";
  // Built at runtime so secret scanners don't flag this test sample.
  const rawSecret = "sk_" + "test_secretBoundaryToken1234567890";
  const rawReferralCode = "RAWREFERRALCODE12345678901234567890";
  const oversizedTail = "x".repeat(600);
  const stripe = accountProofClient({
    coupons: {
      create: async (params: any) => {
        createdId = params.id;
        throw new Error(`provider timeout for ${params.id} ${rawSecret} ${rawReferralCode} ${oversizedTail}`);
      },
      retrieve: async (id: string) => {
        assert.equal(id, createdId);
        throw new Error(`retrieve failed for ${id} ${rawSecret} ${rawReferralCode} ${oversizedTail}`);
      },
      del: async () => {
        throw new Error("cleanup should not run without a matched object");
      },
    },
  });

  await assert.rejects(
    () => runReferralDurationAcceptanceForTests(REFERRAL_AUTH_ENV, referralStripeFactory(stripe) as any),
    (error) => {
      assert(error instanceof Error);
      assert.match(error.message, /provider timeout/);
      assert.match(error.message, /reconciliation unconfirmed/);
      assert.match(error.message, /coupon:raft_ref_accept_\[redacted\]:/);
      assert.equal(error.message.includes(createdId), false);
      assert.equal(error.message.includes(rawSecret), false);
      assert.equal(error.message.includes(rawReferralCode), false);
      assert.equal(error.message.includes(oversizedTail.slice(0, 120)), false);
      assert(error.message.length <= 320);
      return true;
    },
  );
});

test("referral_duration_acceptance_readback_failure_is_redacted_and_bounded", async () => {
  let createdId = "";
  let deleteCalls = 0;
  // Built at runtime so secret scanners don't flag this test sample.
  const rawSecret = "sk_" + "test_readbackSecretBoundary1234567890";
  const rawReferralCode = "READBACKREFERRALCODE12345678901234567890";
  const oversizedTail = "y".repeat(600);
  const stripe = accountProofClient({
    coupons: {
      create: async (params: any) => {
        createdId = params.id;
        return testCoupon({
          campaignId: params.metadata.referral_campaign_id,
          couponId: params.id,
          percentOff: params.percent_off,
          durationMonths: params.duration_in_months,
          maxRedemptions: params.max_redemptions,
        });
      },
      retrieve: async (id: string) => {
        assert.equal(id, createdId);
        throw new Error(`readback failed for ${id} ${rawSecret} ${rawReferralCode} ${oversizedTail}`);
      },
      del: async (id: string) => {
        deleteCalls += 1;
        assert.equal(id, createdId);
        return {
          id,
          object: "coupon",
          deleted: true,
          lastResponse: { apiVersion: REFERRAL_STRIPE_API_VERSION, requestId: "req_deleted_coupon" },
        };
      },
    },
  });

  await assert.rejects(
    () => runReferralDurationAcceptanceForTests(REFERRAL_AUTH_ENV, referralStripeFactory(stripe) as any),
    (error) => {
      assert(error instanceof Error);
      assert.match(error.message, /readback failed/);
      assert.match(error.message, /coupon:raft_ref_accept_\[redacted\]:/);
      assert.equal(error.message.includes(createdId), false);
      assert.equal(error.message.includes(rawSecret), false);
      assert.equal(error.message.includes(rawReferralCode), false);
      assert.equal(error.message.includes(oversizedTail.slice(0, 120)), false);
      assert(error.message.length <= 320);
      return true;
    },
  );
  assert.equal(deleteCalls, 1);
});

test("referral_duration_acceptance_readback_and_cleanup_failures_are_redacted_and_bounded", async () => {
  let createdId = "";
  // Built at runtime so secret scanners don't flag this test sample.
  const rawSecret = "sk_" + "test_readbackCleanupSecret1234567890";
  const rawReferralCode = "READBACKCLEANUPREFERRALCODE1234567890";
  const oversizedTail = "z".repeat(600);
  const stripe = accountProofClient({
    coupons: {
      create: async (params: any) => {
        createdId = params.id;
        return testCoupon({
          campaignId: params.metadata.referral_campaign_id,
          couponId: params.id,
          percentOff: params.percent_off,
          durationMonths: params.duration_in_months,
          maxRedemptions: params.max_redemptions,
        });
      },
      retrieve: async (id: string) => {
        assert.equal(id, createdId);
        throw new Error(`readback failed for ${id} ${rawSecret} ${rawReferralCode} ${oversizedTail}`);
      },
      del: async (id: string) => {
        const error: any = new Error(`No such coupon: ${id}`);
        error.statusCode = 404;
        throw error;
      },
    },
  });

  await assert.rejects(
    () => runReferralDurationAcceptanceForTests(REFERRAL_AUTH_ENV, referralStripeFactory(stripe) as any),
    (error) => {
      assert(error instanceof Error);
      assert.match(error.message, /readback failed/);
      assert.match(error.message, /cleanup unconfirmed/);
      assert.match(error.message, /coupon:raft_ref_accept_\[redacted\]:/);
      assert.equal(error.message.includes(createdId), false);
      assert.equal(error.message.includes(rawSecret), false);
      assert.equal(error.message.includes(rawReferralCode), false);
      assert.equal(error.message.includes(oversizedTail.slice(0, 120)), false);
      assert(error.message.length <= 320);
      return true;
    },
  );
});

test("referral_provider_write_path_requires_account_proof_before_coupon_create", async ({ db, seed }) => {
  const fixture = await createReferralFixture({ db, seed });
  await db.update(referralDiscountCampaigns).set({
    providerState: "pending",
    providerStrategy: REFERRAL_PROVIDER_STRATEGY,
    stripeCouponId: null,
  }).where(eq(referralDiscountCampaigns.id, fixture.campaign.id));
  let createCalls = 0;
  const stripe = accountProofClient({
    accountId: "acct_wrong",
    coupons: {
      create: async () => {
        createCalls += 1;
        throw new Error("must not create");
      },
      retrieve: async () => {
        throw new Error("must not retrieve");
      },
    },
  });

  const authorization = await referralAuthorization();
  await assert.rejects(
    () => provisionReferralCampaignCouponForTests(fixture.campaign.id, stripe as any, authorization, db),
    /account id mismatch/,
  );
  assert.equal(createCalls, 0);
});

test("referral_provider_write_path_blocks_unproved_profile_live_balance_and_missing_version_before_create", async ({ db, seed }) => {
  const fixture = await createReferralFixture({ db, seed });
  await db.update(referralDiscountCampaigns).set({
    providerState: "pending",
    providerStrategy: REFERRAL_PROVIDER_STRATEGY,
    stripeCouponId: null,
  }).where(eq(referralDiscountCampaigns.id, fixture.campaign.id));

  const authorization = await referralAuthorization();
  for (const [name, client, pattern] of [
    ["profile", accountProofClient({ profile: "other" }), /profile does not match/],
    ["live", accountProofClient({ balanceLivemode: true }), /not test mode/],
    ["version", accountProofClient({ balanceApiVersion: null }), /API version mismatch/],
  ] as const) {
    let createCalls = 0;
    client.coupons = {
      create: async () => {
        createCalls += 1;
        throw new Error(`must not create for ${name}`);
      },
      retrieve: async () => {
        throw new Error(`must not retrieve for ${name}`);
      },
    };
    await assert.rejects(
      () => provisionReferralCampaignCouponForTests(fixture.campaign.id, client as any, authorization, db),
      pattern,
    );
    assert.equal(createCalls, 0, `${name} must block before provider create`);
  }
});

test("provision_referral_campaign_coupon_confirms_only_exact_test_mode_readback", async ({ db, seed }) => {
  const fixture = await createReferralFixture({ db, seed });
  await db.update(referralDiscountCampaigns).set({
    providerState: "pending",
    providerStrategy: REFERRAL_PROVIDER_STRATEGY,
    stripeCouponId: null,
  }).where(eq(referralDiscountCampaigns.id, fixture.campaign.id));

  const couponId = providerCouponId(fixture.campaign.id);
  const couponCreateFixture = await loadReferralFixture<Stripe.Coupon>("coupon-create.json");
  const couponRetrieveFixture = await loadReferralFixture<Stripe.Coupon>("coupon-retrieve.json");
  const createCalls: Array<{ params: any; options: any }> = [];
  const stripe = accountProofClient({
    coupons: {
      create: async (params: any, options: any) => {
        createCalls.push({ params, options });
        return {
          ...couponCreateFixture,
          id: couponId,
          metadata: testCoupon({ campaignId: fixture.campaign.id, couponId }).metadata,
        } as Stripe.Coupon;
      },
      retrieve: async (id: string) => {
        assert.equal(id, couponId);
        return {
          ...couponRetrieveFixture,
          id: couponId,
          metadata: testCoupon({ campaignId: fixture.campaign.id, couponId }).metadata,
        } as Stripe.Coupon;
      },
    },
  });

  const authorization = await referralAuthorization(stripe);
  const coupon = await provisionReferralCampaignCouponForTests(fixture.campaign.id, stripe as any, authorization, db);
  assert.equal(coupon.id, couponId);
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].params.id, couponId);
  assert.equal(createCalls[0].params.duration, "repeating");
  assert.equal(createCalls[0].params.duration_in_months, 3);
  assert.equal(createCalls[0].params.metadata.raft_use, "referral_discount_checkout");
  assert.equal(createCalls[0].options.idempotencyKey, `referral-coupon:${fixture.campaign.id}:${REFERRAL_STRIPE_API_VERSION}`);

  const [campaign] = await db.select().from(referralDiscountCampaigns)
    .where(eq(referralDiscountCampaigns.id, fixture.campaign.id));
  assert.equal(campaign.providerState, "ready");
  assert.equal(campaign.stripeCouponId, couponId);
  const [operation] = await db.select().from(referralDiscountProviderOperations)
    .where(eq(referralDiscountProviderOperations.localTargetId, fixture.campaign.id));
  assert.equal(operation.state, "confirmed");
  assert.equal(operation.providerObjectId, couponId);
  assert.equal((operation.requestPayload as any).apiVersion, REFERRAL_STRIPE_API_VERSION);
});

test("provision_referral_campaign_coupon_parks_live_or_version_mismatched_readback", async ({ db, seed }) => {
  const fixture = await createReferralFixture({ db, seed });
  await db.update(referralDiscountCampaigns).set({
    providerState: "pending",
    providerStrategy: REFERRAL_PROVIDER_STRATEGY,
    stripeCouponId: null,
  }).where(eq(referralDiscountCampaigns.id, fixture.campaign.id));
  const couponId = providerCouponId(fixture.campaign.id);
  const stripe = accountProofClient({
    coupons: {
      create: async () => testCoupon({ campaignId: fixture.campaign.id, couponId }),
      retrieve: async () => testCoupon({ campaignId: fixture.campaign.id, couponId, livemode: true }),
    },
  });

  const authorization = await referralAuthorization(stripe);
  await assert.rejects(
    () => provisionReferralCampaignCouponForTests(fixture.campaign.id, stripe as any, authorization, db),
    /not test mode/,
  );
  const [operation] = await db.select().from(referralDiscountProviderOperations)
    .where(eq(referralDiscountProviderOperations.localTargetId, fixture.campaign.id));
  assert.equal(operation.state, "parked");
  const [campaign] = await db.select().from(referralDiscountCampaigns)
    .where(eq(referralDiscountCampaigns.id, fixture.campaign.id));
  assert.equal(campaign.providerState, "pending");
  assert.equal(campaign.stripeCouponId, null);
});

test("provision_referral_campaign_coupon_retrieves_deterministic_coupon_before_recreating_after_ambiguous_create", async ({ db, seed }) => {
  const fixture = await createReferralFixture({ db, seed });
  await db.update(referralDiscountCampaigns).set({
    providerState: "pending",
    providerStrategy: REFERRAL_PROVIDER_STRATEGY,
    stripeCouponId: null,
  }).where(eq(referralDiscountCampaigns.id, fixture.campaign.id));
  const couponId = providerCouponId(fixture.campaign.id);
  let createCalls = 0;
  let retrieveCalls = 0;
  const stripe = accountProofClient({
    coupons: {
      create: async () => {
        createCalls += 1;
        throw new Error("provider timeout after coupon create");
      },
      retrieve: async (id: string) => {
        retrieveCalls += 1;
        assert.equal(id, couponId);
        return testCoupon({ campaignId: fixture.campaign.id, couponId });
      },
    },
  });

  const authorization = await referralAuthorization(stripe);
  await assert.rejects(
    () => provisionReferralCampaignCouponForTests(fixture.campaign.id, stripe as any, authorization, db),
    /provider timeout/,
  );
  await provisionReferralCampaignCouponForTests(fixture.campaign.id, stripe as any, authorization, db);
  assert.equal(createCalls, 1);
  assert.equal(retrieveCalls, 2);
  const [operation] = await db.select().from(referralDiscountProviderOperations)
    .where(eq(referralDiscountProviderOperations.localTargetId, fixture.campaign.id));
  assert.equal(operation.state, "confirmed");
  assert.equal(operation.providerObjectId, couponId);
});

test("provision_referral_code_promotion_uses_typed_promotion_shape_and_never_persists_raw_display_code", async ({ db, seed }) => {
  const fixture = await createReferralFixture({ db, seed });
  const couponId = `coupon_${randomUUID()}`;
  await db.update(referralDiscountCampaigns).set({
    providerState: "ready",
    providerStrategy: REFERRAL_PROVIDER_STRATEGY,
    stripeCouponId: couponId,
  }).where(eq(referralDiscountCampaigns.id, fixture.campaign.id));
  await db.update(referralDiscountCodes).set({
    displayCode: "HUMAN-CODE-ABCDEF0123456789",
    normalizedCode: normalizeReferralCode("HUMAN-CODE-ABCDEF0123456789"),
    providerState: "pending",
    stripePromotionCodeId: null,
  }).where(eq(referralDiscountCodes.id, fixture.code.id));

  const promotionId = `promo_${randomUUID().replace(/-/g, "")}`;
  const providerCode = providerPromotionCode(fixture.code.id);
  const promotionCreateFixture = await loadReferralFixture<Stripe.PromotionCode>("promotion-code-create.json");
  const promotionRetrieveFixture = await loadReferralFixture<Stripe.PromotionCode>("promotion-code-retrieve.json");
  const createCalls: Array<{ params: any; options: any }> = [];
  const stripe = accountProofClient({
    promotionCodes: {
      create: async (params: any, options: any) => {
        createCalls.push({ params, options });
        assert.equal(params.coupon, undefined);
        assert.deepEqual(params.promotion, { type: "coupon", coupon: couponId });
        return {
          ...promotionCreateFixture,
          id: promotionId,
          code: providerCode,
          promotion: { type: "coupon", coupon: testCoupon({ campaignId: fixture.campaign.id, couponId }) },
          metadata: testPromotionCode({ id: promotionId, codeId: fixture.code.id, campaignId: fixture.campaign.id, referrerUserId: fixture.referrer.id, couponId, providerCode }).metadata,
        } as Stripe.PromotionCode;
      },
      retrieve: async (id: string, params: any) => {
        assert.equal(id, promotionId);
        assert.deepEqual(params, { expand: ["promotion.coupon"] });
        return {
          ...promotionRetrieveFixture,
          id: promotionId,
          code: providerCode,
          promotion: { type: "coupon", coupon: testCoupon({ campaignId: fixture.campaign.id, couponId }) },
          metadata: testPromotionCode({ id: promotionId, codeId: fixture.code.id, campaignId: fixture.campaign.id, referrerUserId: fixture.referrer.id, couponId, providerCode }).metadata,
        } as Stripe.PromotionCode;
      },
    },
  });

  const authorization = await referralAuthorization(stripe);
  const promotion = await provisionReferralCodePromotionForTests(fixture.code.id, stripe as any, authorization, db);
  assert.equal(promotion.id, promotionId);
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].params.code, providerCode);
  assert.equal(createCalls[0].options.idempotencyKey, `referral-promotion:${fixture.code.id}:${REFERRAL_STRIPE_API_VERSION}`);
  const [code] = await db.select().from(referralDiscountCodes)
    .where(eq(referralDiscountCodes.id, fixture.code.id));
  assert.equal(code.providerState, "ready");
  assert.equal(code.stripePromotionCodeId, promotionId);
  const [operation] = await db.select().from(referralDiscountProviderOperations)
    .where(eq(referralDiscountProviderOperations.localTargetId, fixture.code.id));
  assert.equal(operation.state, "confirmed");
  assert.equal(operation.providerObjectId, promotionId);
  assert.equal(JSON.stringify(operation.requestPayload).includes("HUMAN-CODE-ABCDEF0123456789"), false);
});

test("provision_referral_code_promotion_replays_ambiguous_create_without_provider_id_same_key_and_payload", async ({ db, seed }) => {
  const fixture = await createReferralFixture({ db, seed });
  const couponId = `coupon_${randomUUID()}`;
  await db.update(referralDiscountCampaigns).set({
    providerState: "ready",
    providerStrategy: REFERRAL_PROVIDER_STRATEGY,
    stripeCouponId: couponId,
  }).where(eq(referralDiscountCampaigns.id, fixture.campaign.id));
  await db.update(referralDiscountCodes).set({ providerState: "pending" })
    .where(eq(referralDiscountCodes.id, fixture.code.id));

  const promotionId = `promo_${randomUUID().replace(/-/g, "")}`;
  const providerCode = providerPromotionCode(fixture.code.id);
  const createCalls: Array<{ params: any; options: any }> = [];
  let createAttempt = 0;
  const stripe = accountProofClient({
    promotionCodes: {
      create: async (params: any, options: any) => {
        createCalls.push({ params, options });
        createAttempt += 1;
        if (createAttempt === 1) throw new Error("provider timeout after create");
        return testPromotionCode({
          id: promotionId,
          codeId: fixture.code.id,
          campaignId: fixture.campaign.id,
          referrerUserId: fixture.referrer.id,
          couponId,
          providerCode,
        });
      },
      retrieve: async (id: string) => {
        assert.equal(id, promotionId);
        return testPromotionCode({
          id: promotionId,
          codeId: fixture.code.id,
          campaignId: fixture.campaign.id,
          referrerUserId: fixture.referrer.id,
          couponId,
          providerCode,
        });
      },
    },
  });

  const authorization = await referralAuthorization(stripe);
  await assert.rejects(
    () => provisionReferralCodePromotionForTests(fixture.code.id, stripe as any, authorization, db),
    /provider timeout/,
  );
  const [parked] = await db.select().from(referralDiscountProviderOperations)
    .where(eq(referralDiscountProviderOperations.localTargetId, fixture.code.id));
  assert.equal(parked.state, "parked");
  assert.equal(parked.providerObjectId, null);

  await provisionReferralCodePromotionForTests(fixture.code.id, stripe as any, authorization, db);
  assert.equal(createCalls.length, 2);
  assert.deepEqual(createCalls[1].params, createCalls[0].params);
  assert.deepEqual(createCalls[1].options, createCalls[0].options);
  const [confirmed] = await db.select().from(referralDiscountProviderOperations)
    .where(eq(referralDiscountProviderOperations.localTargetId, fixture.code.id));
  assert.equal(confirmed.state, "confirmed");
  assert.equal(confirmed.providerObjectId, promotionId);
});

test("provision_referral_code_promotion_pruned_key_without_provider_id_stays_parked_without_searching", async ({ db, seed }) => {
  const fixture = await createReferralFixture({ db, seed });
  const couponId = `coupon_${randomUUID()}`;
  await db.update(referralDiscountCampaigns).set({
    providerState: "ready",
    providerStrategy: REFERRAL_PROVIDER_STRATEGY,
    stripeCouponId: couponId,
  }).where(eq(referralDiscountCampaigns.id, fixture.campaign.id));
  await db.update(referralDiscountCodes).set({ providerState: "pending" })
    .where(eq(referralDiscountCodes.id, fixture.code.id));

  let createAttempt = 0;
  const stripe = accountProofClient({
    promotionCodes: {
      create: async () => {
        createAttempt += 1;
        throw new Error(createAttempt === 1 ? "provider timeout after create" : "idempotency key retention expired");
      },
      list: async () => {
        throw new Error("display-code search must not be used as recovery authority");
      },
      retrieve: async () => {
        throw new Error("no provider id was stored");
      },
    },
  });

  const authorization = await referralAuthorization(stripe);
  await assert.rejects(
    () => provisionReferralCodePromotionForTests(fixture.code.id, stripe as any, authorization, db),
    /provider timeout/,
  );
  await assert.rejects(
    () => provisionReferralCodePromotionForTests(fixture.code.id, stripe as any, authorization, db),
    /retention expired/,
  );
  const [operation] = await db.select().from(referralDiscountProviderOperations)
    .where(eq(referralDiscountProviderOperations.localTargetId, fixture.code.id));
  assert.equal(operation.state, "parked");
  assert.equal(operation.providerObjectId, null);
});

test("referral_provider_fixtures_are_versioned_test_mode_and_sanitized", async () => {
  const files = await readdir(REFERRAL_FIXTURE_DIR);
  assert.ok(files.length >= 5, "fixture directory must carry account/coupon/promotion examples");
  assert.equal(await referralFixtureHash(), REFERRAL_FIXTURE_HASH);
  for (const file of files.filter((entry) => entry.endsWith(".json"))) {
    const text = await readFile(join(REFERRAL_FIXTURE_DIR, file), "utf8");
    assert.equal(/sk_(test|live)_/.test(text), false, `${file} must not contain Stripe keys`);
    assert.equal(text.includes("HUMAN-CODE-ABCDEF0123456789"), false, `${file} must not contain raw referral code`);
    const payload = JSON.parse(text);
    const blobs = Array.isArray(payload.objects) ? payload.objects : [payload];
    for (const blob of blobs) {
      if (blob.lastResponse) assert.equal(blob.lastResponse.apiVersion, REFERRAL_STRIPE_API_VERSION, file);
      if (Object.prototype.hasOwnProperty.call(blob, "livemode")) assert.equal(blob.livemode, false, file);
    }
  }
});

test("campaign_cap_reservation_uses_atomic_counters_with_campaign_then_code_lock_order", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed }, { cap: 2 });

  const [campaign] = await db.select().from(referralDiscountCampaigns);
  const [code] = await db.select().from(referralDiscountCodes);
  assert.equal(campaign.liveReservedCount, 1);
  assert.equal(campaign.qualifiedCount, 0);
  assert.equal(code.liveReservedCount, 1);
  assert.equal(code.qualifiedCount, 0);
  assert.equal(fixture.redemption.capSlotState, "held");
});

test("campaign_cap_expiry_or_void_releases_reserved_slot", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed }, { cap: 1 });

  await markReferralCheckoutCreated(fixture.redemption.id, {
    decisionAt: DECISION_AT,
    stripeCheckoutSessionId: `cs_${randomUUID()}`,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    reservationExpiresAt: CHECKOUT_EXPIRES_AT,
  }, db);
  await expireReferralReservation(fixture.redemption.id, db);

  const [campaign] = await db.select().from(referralDiscountCampaigns);
  const [code] = await db.select().from(referralDiscountCodes);
  assert.equal(campaign.liveReservedCount, 0);
  assert.equal(code.liveReservedCount, 0);
  const [redemption] = await db.select().from(referralDiscountRedemptions);
  assert.equal(redemption.capSlotState, "released");
  assert.equal(redemption.acquisitionState, "checkout_expired");
});

test("checkout_expiry_requires_canonical_stored_session_join", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed }, { cap: 1 });
  const sessionId = `cs_${randomUUID()}`;
  await markReferralCheckoutCreated(fixture.redemption.id, {
    decisionAt: DECISION_AT,
    stripeCheckoutSessionId: sessionId,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    reservationExpiresAt: CHECKOUT_EXPIRES_AT,
  }, db);

  await assert.rejects(
    () => expireReferralCheckoutSession(fixture.redemption.id, `cs_${randomUUID()}`, db),
    (error) => {
      assertReferralError(error, "acquisition_replay_mismatch");
      return true;
    },
  );
  const [stillHeld] = await db.select().from(referralDiscountRedemptions)
    .where(eq(referralDiscountRedemptions.id, fixture.redemption.id));
  assert.equal(stillHeld.acquisitionState, "checkout_created");
  assert.equal(stillHeld.capSlotState, "held");

  await expireReferralCheckoutSession(fixture.redemption.id, sessionId, db);
  const [expired] = await db.select().from(referralDiscountRedemptions)
    .where(eq(referralDiscountRedemptions.id, fixture.redemption.id));
  assert.equal(expired.acquisitionState, "checkout_expired");
  assert.equal(expired.capSlotState, "released");
});

test("campaign_cap_qualification_consumes_reserved_slot", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed }, { cap: 1 });

  await qualifyFixture(fixture.redemption.id, `in_${randomUUID()}`, db);

  const [campaign] = await db.select().from(referralDiscountCampaigns);
  const [code] = await db.select().from(referralDiscountCodes);
  const [redemption] = await db.select().from(referralDiscountRedemptions);
  assert.equal(campaign.liveReservedCount, 0);
  assert.equal(campaign.qualifiedCount, 1);
  assert.equal(code.liveReservedCount, 0);
  assert.equal(code.qualifiedCount, 1);
  assert.equal(redemption.capSlotState, "consumed");
  assert.equal(redemption.qualificationDisposition, "qualified");
});

test("cap_slot_transition_replay_is_idempotent", async ({ db, seed }) => {
  const expired = await reserveFixture({ db, seed }, { cap: 1 });
  await markReferralCheckoutCreated(expired.redemption.id, {
    decisionAt: DECISION_AT,
    stripeCheckoutSessionId: `cs_${randomUUID()}`,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    reservationExpiresAt: CHECKOUT_EXPIRES_AT,
  }, db);
  await expireReferralReservation(expired.redemption.id, db);
  await expireReferralReservation(expired.redemption.id, db);

  const [campaign] = await db.select().from(referralDiscountCampaigns);
  assert.equal(campaign.liveReservedCount, 0);

  const second = await createReferralReservation({
    environment: "stripe",
    livemode: true,
    historyOriginAt: HISTORY_ORIGIN,
    decisionAt: DECISION_AT,
    campaignId: expired.campaign.id,
    codeId: expired.code.id,
    referrerUserId: expired.referrer.id,
    redeemingUserId: (await seed.human()).id,
    referredServerId: (await seed.server({ owner: expired.owner })).id,
    reservationExpiresAt: new Date("2026-10-09T16:30:00.000Z"),
  }, db);
  await db.update(referralDiscountRedemptions)
    .set({ reservedAt: DECISION_AT })
    .where(eq(referralDiscountRedemptions.id, second.id));
  const invoiceId = `in_${randomUUID()}`;
  await qualifyFixture(second.id, invoiceId, db);
  await qualifyReferralRedemption(second.id, {
    firstPaidInvoiceId: invoiceId,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
  }, db);

  const rows = await db.select().from(referralDiscountCampaigns);
  assert.equal(rows[0].liveReservedCount, 0);
  assert.equal(rows[0].qualifiedCount, 1);
});

test("acquisition_state_requires_checkout_completed_before_qualification", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed });

  await assert.rejects(
    () => qualifyReferralRedemption(fixture.redemption.id, {
      firstPaidInvoiceId: "in_direct_qualified",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    }, db),
    (error) => {
      assertReferralError(error, "invalid_transition");
      return true;
    },
  );
  await assert.rejects(
    () => markReferralCheckoutCompleted(fixture.redemption.id, {
      stripeCheckoutSessionId: `cs_${randomUUID()}`,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    }, db),
    (error) => {
      assertReferralError(error, "invalid_transition");
      return true;
    },
  );
});

test("acquisition_replays_require_canonical_payload_and_frozen_edges", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed });
  const sessionId = `cs_${randomUUID()}`;
  await markReferralCheckoutCreated(fixture.redemption.id, {
    decisionAt: DECISION_AT,
    stripeCheckoutSessionId: sessionId,
    stripeCustomerId: "cus_original",
    stripeSubscriptionId: "sub_original",
    reservationExpiresAt: new Date("2026-10-10T16:45:00.000Z"),
  }, db);
  await markReferralCheckoutCreated(fixture.redemption.id, {
    decisionAt: DECISION_AT,
    stripeCheckoutSessionId: sessionId,
    stripeCustomerId: "cus_original",
    stripeSubscriptionId: "sub_original",
    reservationExpiresAt: new Date("2026-10-10T16:45:00.000Z"),
  }, db);
  await assert.rejects(
    () => markReferralCheckoutCreated(fixture.redemption.id, {
      decisionAt: DECISION_AT,
      stripeCheckoutSessionId: sessionId,
      stripeCustomerId: "cus_changed",
      stripeSubscriptionId: "sub_original",
      reservationExpiresAt: new Date("2026-10-10T16:45:00.000Z"),
    }, db),
    (error) => {
      assertReferralError(error, "acquisition_replay_mismatch");
      return true;
    },
  );
  await assert.rejects(
    () => markReferralCheckoutCreated(fixture.redemption.id, {
      decisionAt: DECISION_AT,
      stripeCheckoutSessionId: sessionId,
      reservationExpiresAt: new Date("2026-10-10T16:45:00.000Z"),
    } as never, db),
    (error) => {
      assertReferralError(error, "acquisition_replay_mismatch");
      return true;
    },
  );
  await db.update(referralDiscountRedemptions)
    .set({ reservedAt: new Date("2026-10-09T16:01:00.000Z") })
    .where(eq(referralDiscountRedemptions.id, fixture.redemption.id));
  await assert.rejects(
    () => markReferralCheckoutCreated(fixture.redemption.id, {
      decisionAt: new Date("2026-10-09T16:20:00.000Z"),
      stripeCheckoutSessionId: sessionId,
      stripeCustomerId: "cus_original",
      stripeSubscriptionId: "sub_original",
      reservationExpiresAt: new Date("2026-10-09T16:10:00.000Z"),
    }, db),
    (error) => {
      assertReferralError(error, "invalid_reservation_window");
      return true;
    },
  );

  const backwardTime = await reserveFixture({ db, seed });
  await db.update(referralDiscountRedemptions)
    .set({ reservedAt: new Date("2026-10-09T16:20:00.000Z") })
    .where(eq(referralDiscountRedemptions.id, backwardTime.redemption.id));
  await assert.rejects(
    () => markReferralCheckoutCreated(backwardTime.redemption.id, {
      decisionAt: new Date("2026-10-09T16:10:00.000Z"),
      stripeCheckoutSessionId: `cs_${randomUUID()}`,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      reservationExpiresAt: new Date("2026-10-09T16:30:00.000Z"),
    }, db),
    (error) => {
      assertReferralError(error, "invalid_reservation_window");
      return true;
    },
  );

  const knownCustomer = await reserveFixture({ db, seed });
  await db.update(referralDiscountRedemptions).set({
    stripeCustomerId: "cus_reserved",
    stripeSubscriptionId: "sub_reserved",
  }).where(eq(referralDiscountRedemptions.id, knownCustomer.redemption.id));
  await assert.rejects(
    () => markReferralCheckoutCreated(knownCustomer.redemption.id, {
      decisionAt: DECISION_AT,
      stripeCheckoutSessionId: `cs_${randomUUID()}`,
      stripeCustomerId: null,
      stripeSubscriptionId: "sub_reserved",
      reservationExpiresAt: CHECKOUT_EXPIRES_AT,
    }, db),
    (error) => {
      assertReferralError(error, "acquisition_replay_mismatch");
      return true;
    },
  );
  await assert.rejects(
    () => markReferralCheckoutCreated(knownCustomer.redemption.id, {
      decisionAt: DECISION_AT,
      stripeCheckoutSessionId: `cs_${randomUUID()}`,
      stripeCustomerId: "cus_other",
      stripeSubscriptionId: "sub_reserved",
      reservationExpiresAt: CHECKOUT_EXPIRES_AT,
    }, db),
    (error) => {
      assertReferralError(error, "acquisition_replay_mismatch");
      return true;
    },
  );
  await assert.rejects(
    () => markReferralCheckoutCreated(knownCustomer.redemption.id, {
      decisionAt: DECISION_AT,
      stripeCheckoutSessionId: `cs_${randomUUID()}`,
      stripeCustomerId: "cus_reserved",
      stripeSubscriptionId: null,
      reservationExpiresAt: CHECKOUT_EXPIRES_AT,
    }, db),
    (error) => {
      assertReferralError(error, "acquisition_replay_mismatch");
      return true;
    },
  );
  await markReferralCheckoutCompleted(fixture.redemption.id, {
    stripeCheckoutSessionId: sessionId,
    stripeCustomerId: "cus_original",
    stripeSubscriptionId: "sub_original",
  }, db);
  await markReferralCheckoutCompleted(fixture.redemption.id, {
    stripeCheckoutSessionId: sessionId,
    stripeCustomerId: "cus_original",
    stripeSubscriptionId: "sub_original",
  }, db);
  await assert.rejects(
    () => markReferralCheckoutCompleted(fixture.redemption.id, {
      stripeCheckoutSessionId: sessionId,
      stripeCustomerId: "cus_original",
    } as never, db),
    (error) => {
      assertReferralError(error, "acquisition_replay_mismatch");
      return true;
    },
  );
  await assert.rejects(
    () => expireReferralReservation(fixture.redemption.id, db),
    (error) => {
      assertReferralError(error, "invalid_transition");
      return true;
    },
  );
  await qualifyReferralRedemption(fixture.redemption.id, {
    firstPaidInvoiceId: "in_canonical",
    stripeCustomerId: "cus_original",
    stripeSubscriptionId: "sub_original",
  }, db);
  await qualifyReferralRedemption(fixture.redemption.id, {
    firstPaidInvoiceId: "in_canonical",
    stripeCustomerId: "cus_original",
    stripeSubscriptionId: "sub_original",
  }, db);
  await assert.rejects(
    () => qualifyReferralRedemption(fixture.redemption.id, {
      firstPaidInvoiceId: "in_changed",
      stripeCustomerId: "cus_original",
      stripeSubscriptionId: "sub_original",
    }, db),
    (error) => {
      assertReferralError(error, "acquisition_replay_mismatch");
      return true;
    },
  );
  await assert.rejects(
    () => qualifyReferralRedemption(fixture.redemption.id, {
      firstPaidInvoiceId: "in_canonical",
      stripeCustomerId: "cus_original",
    } as never, db),
    (error) => {
      assertReferralError(error, "acquisition_replay_mismatch");
      return true;
    },
  );
});

test("reservation_requires_campaign_code_windows_and_future_expiry", async ({ db, seed }) => {
  const fixture = await createReferralFixture({ db, seed });
  await db.update(referralDiscountCampaigns).set({ startsAt: new Date("2026-10-10T00:00:00.000Z") });

  await assert.rejects(
    () => createReferralReservation({
      environment: "stripe",
      livemode: true,
      historyOriginAt: HISTORY_ORIGIN,
      decisionAt: DECISION_AT,
      campaignId: fixture.campaign.id,
      codeId: fixture.code.id,
      referrerUserId: fixture.referrer.id,
      redeemingUserId: fixture.redeemer.id,
      referredServerId: fixture.server.id,
      reservationExpiresAt: new Date("2026-10-09T16:30:00.000Z"),
    }, db),
    (error) => {
      assertReferralError(error, "campaign_not_redeemable");
      return true;
    },
  );

  await db.update(referralDiscountCampaigns).set({ startsAt: null });
  await db.update(referralDiscountCodes).set({ expiresAt: DECISION_AT });
  await assert.rejects(
    () => createReferralReservation({
      environment: "stripe",
      livemode: true,
      historyOriginAt: HISTORY_ORIGIN,
      decisionAt: DECISION_AT,
      campaignId: fixture.campaign.id,
      codeId: fixture.code.id,
      referrerUserId: fixture.referrer.id,
      redeemingUserId: fixture.redeemer.id,
      referredServerId: fixture.server.id,
      reservationExpiresAt: new Date("2026-10-09T16:30:00.000Z"),
    }, db),
    (error) => {
      assertReferralError(error, "code_not_redeemable");
      return true;
    },
  );

  await db.update(referralDiscountCodes).set({ expiresAt: null });
  await assert.rejects(
    () => createReferralReservation({
      environment: "stripe",
      livemode: true,
      historyOriginAt: HISTORY_ORIGIN,
      decisionAt: DECISION_AT,
      campaignId: fixture.campaign.id,
      codeId: fixture.code.id,
      referrerUserId: fixture.referrer.id,
      redeemingUserId: fixture.redeemer.id,
      referredServerId: fixture.server.id,
      reservationExpiresAt: DECISION_AT,
    }, db),
    (error) => {
      assertReferralError(error, "invalid_reservation_window");
      return true;
    },
  );
});

test("financial_risk_dispute_open_sets_disputed_without_reversing", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed });
  await qualifyFixture(fixture.redemption.id, "in_dispute_open", db);

  const folded = await recordReferralFinancialAdjustment({
    redemptionId: fixture.redemption.id,
    environment: "stripe",
    livemode: true,
    kind: "dispute_opened",
    providerFactId: "dp_open_1",
    stripeEventId: "evt_dp_open_1",
    stripeInvoiceId: "in_dispute_open",
    stripeDisputeId: "dp_1",
    currency: "usd",
    amount: 1000,
    netRevenueDelta: 0,
  }, db);

  assert.equal(folded.status, "recorded");
  assert.equal(folded.redemption?.qualificationDisposition, "qualified");
  assert.equal(folded.redemption?.financialRisk, "disputed");
});

test("financial_adjustment_partial_refund_keeps_qualified_and_adjusts_net_revenue", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed });
  await qualifyFixture(fixture.redemption.id, "in_partial_refund", db);

  const folded = await recordReferralFinancialAdjustment({
    redemptionId: fixture.redemption.id,
    environment: "stripe",
    livemode: true,
    kind: "refund",
    providerFactId: "re_partial_1",
    stripeEventId: "evt_re_partial_1",
    stripeInvoiceId: "in_partial_refund",
    stripeRefundId: "re_1",
    currency: "usd",
    amount: 250,
    netRevenueDelta: -250,
    fullEconomicReversal: false,
  }, db);

  assert.equal(folded.redemption?.qualificationDisposition, "qualified");
  assert.equal(folded.redemption?.financialRisk, "clear");
  const [adjustment] = await db.select().from(referralDiscountFinancialAdjustments);
  assert.equal(adjustment.netRevenueDelta, -250);
});

test("financial_adjustment_provider_object_lineage_accepts_ordered_updates_without_exact_replay", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed });
  await qualifyFixture(fixture.redemption.id, "in_refund_lineage", db);

  const first = await recordReferralFinancialAdjustment({
    redemptionId: fixture.redemption.id,
    environment: "stripe",
    livemode: true,
    kind: "refund",
    providerFactId: "re_same_object",
    providerFactSequence: 1,
    stripeEventId: "evt_re_created",
    stripeInvoiceId: "in_refund_lineage",
    stripeRefundId: "re_same_object",
    currency: "usd",
    amount: 250,
    netRevenueDelta: -250,
    fullEconomicReversal: false,
  }, db);
  assert.equal(first.status, "recorded");

  const updated = await recordReferralFinancialAdjustment({
    redemptionId: fixture.redemption.id,
    environment: "stripe",
    livemode: true,
    kind: "refund",
    providerFactId: "re_same_object",
    providerFactSequence: 2,
    stripeEventId: "evt_re_updated",
    stripeInvoiceId: "in_refund_lineage",
    stripeRefundId: "re_same_object",
    currency: "usd",
    amount: 275,
    netRevenueDelta: -25,
    fullEconomicReversal: false,
  }, db);

  assert.equal(updated.status, "recorded");
  const adjustments = await db.select().from(referralDiscountFinancialAdjustments)
    .where(eq(referralDiscountFinancialAdjustments.providerFactId, "re_same_object"));
  assert.equal(adjustments.length, 2);
  assert.equal(adjustments[0].providerFactId, "re_same_object");
  assert.equal(adjustments.reduce((total, adjustment) => total + adjustment.netRevenueDelta, 0), -275);
});

test("financial_adjustment_provider_event_replay_requires_exact_same_payload", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed });
  await qualifyFixture(fixture.redemption.id, "in_refund_sequence_replay", db);

  await recordReferralFinancialAdjustment({
    redemptionId: fixture.redemption.id,
    environment: "stripe",
    livemode: true,
    kind: "refund",
    providerFactId: "re_sequence_replay",
    providerFactSequence: 2,
    stripeEventId: "evt_re_updated",
    stripeInvoiceId: "in_refund_sequence_replay",
    stripeRefundId: "re_sequence_replay",
    currency: "usd",
    amount: 275,
    netRevenueDelta: -275,
    fullEconomicReversal: false,
  }, db);

  await assert.rejects(
    () => recordReferralFinancialAdjustment({
      redemptionId: fixture.redemption.id,
      environment: "stripe",
      livemode: true,
      kind: "refund",
      providerFactId: "re_sequence_replay",
      providerFactSequence: 2,
      stripeEventId: "evt_re_updated",
      stripeInvoiceId: "in_refund_sequence_replay",
      stripeRefundId: "re_sequence_replay",
      currency: "usd",
      amount: 300,
      netRevenueDelta: -300,
      fullEconomicReversal: false,
    }, db),
    (error) => {
      assertReferralError(error, "financial_adjustment_unjoinable");
      return true;
    },
  );
});

test("financial_adjustment_provider_updates_are_ordered_by_explicit_sequence_not_delivery_order", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed });
  await qualifyFixture(fixture.redemption.id, "in_refund_out_of_order", db);

  await recordReferralFinancialAdjustment({
    redemptionId: fixture.redemption.id,
    environment: "stripe",
    livemode: true,
    kind: "refund",
    providerFactId: "re_out_of_order",
    providerFactSequence: 2,
    stripeEventId: "evt_re_updated_first",
    stripeInvoiceId: "in_refund_out_of_order",
    stripeRefundId: "re_out_of_order",
    currency: "usd",
    amount: 275,
    netRevenueDelta: -25,
    fullEconomicReversal: false,
  }, db);
  await recordReferralFinancialAdjustment({
    redemptionId: fixture.redemption.id,
    environment: "stripe",
    livemode: true,
    kind: "refund",
    providerFactId: "re_out_of_order",
    providerFactSequence: 1,
    stripeEventId: "evt_re_created_late",
    stripeInvoiceId: "in_refund_out_of_order",
    stripeRefundId: "re_out_of_order",
    currency: "usd",
    amount: 250,
    netRevenueDelta: -250,
    fullEconomicReversal: false,
  }, db);

  const rows = await db.select().from(referralDiscountFinancialAdjustments)
    .where(eq(referralDiscountFinancialAdjustments.providerFactId, "re_out_of_order"));
  assert.equal(rows.length, 2);
  assert.equal(rows.reduce((total, row) => total + row.netRevenueDelta, 0), -275);
});

async function dispatchReferralRefundWebhook(input: {
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
        charge: "ch_test_referral",
        currency: "usd",
        amount: input.amount,
        status: input.status,
      },
    },
  } as any);
}

async function dispatchReferralCreditNoteWebhook(input: {
  eventId: string;
  eventType: "credit_note.created" | "credit_note.updated" | "credit_note.voided";
  eventCreated: number;
  creditNoteId: string;
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
        id: input.creditNoteId,
        object: "credit_note",
        livemode: false,
        invoice: input.invoiceId,
        currency: "usd",
        total: input.amount,
        status: input.status,
      },
    },
  } as any);
}

async function dispatchReferralDisputeWebhook(input: {
  eventId: string;
  eventType: "charge.dispute.created" | "charge.dispute.closed";
  eventCreated: number;
  disputeId: string;
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
        id: input.disputeId,
        object: "dispute",
        livemode: false,
        invoice: input.invoiceId,
        charge: "ch_test_referral",
        currency: "usd",
        amount: input.amount,
        status: input.status,
      },
    },
  } as any);
}

function referralBillingInvoicePaidEvent(id: string, invoice: Record<string, unknown>): Stripe.Event {
  return {
    id,
    type: "invoice.paid",
    data: { object: invoice },
  } as unknown as Stripe.Event;
}

async function runBillingWebhookWithTrace(work: () => Promise<void>) {
  const tracer = new BasicTracer({
    sink: new MemoryTraceSink(),
    traceIdGenerator: () => "d".repeat(32),
    spanIdGenerator: () => "1".repeat(16),
  });
  const span = tracer.startSpan("server.http.request", { surface: "server", kind: "server" });
  try {
    await runWithTraceSpan(span, work, tracer);
  } finally {
    span.end();
  }
}

function referralBillingSubscription(input: {
  id: string;
  serverId: string;
  userId: string;
  redemptionId: string;
}): Stripe.Subscription {
  return {
    id: input.id,
    customer: "cus_referral_dispatch",
    status: "active",
    cancel_at_period_end: false,
    cancel_at: null,
    pending_update: null,
    schedule: null,
    trial_end: null,
    metadata: {
      pricingContract: "raft-pro-seat-v1",
      serverId: input.serverId,
      userId: input.userId,
      targetPlan: "pro",
      billingInterval: "monthly",
      seatQuantity: "1",
      humanSeatQuantity: "1",
      requestedAgentSeats: "0",
      agentSeatBlockQuantity: "0",
      proPackQuantity: "1",
      packQuantity: "1",
      stripeInitialPaidPackQuantity: "1",
      provisionedHumanSeats: "1",
      provisionedAgentSeats: "10",
      trialFreePackQuantity: "0",
      referralRedemptionId: input.redemptionId,
    },
    items: {
      data: [{
        id: "si_referral_dispatch",
        quantity: 1,
        current_period_start: 1_700_000_000,
        current_period_end: 1_702_592_000,
        price: { id: "price_pro", product: "prod_pro", recurring: { interval: "month" } },
      }],
    },
  } as unknown as Stripe.Subscription;
}

function immutableFinancialRow(row: typeof referralDiscountFinancialAdjustments.$inferSelect) {
  return {
    id: row.id,
    environment: row.environment,
    livemode: row.livemode,
    kind: row.kind,
    providerFactId: row.providerFactId,
    providerFactSequence: row.providerFactSequence,
    stripeEventId: row.stripeEventId,
    stripeInvoiceId: row.stripeInvoiceId,
    stripeRefundId: row.stripeRefundId,
    stripeCreditNoteId: row.stripeCreditNoteId,
    stripeDisputeId: row.stripeDisputeId,
    stripeChargeId: row.stripeChargeId,
    currency: row.currency,
    amount: row.amount,
    netRevenueDelta: row.netRevenueDelta,
    fullEconomicReversal: row.fullEconomicReversal,
    observedRedemptionId: row.observedRedemptionId,
    resolvedRedemptionId: row.resolvedRedemptionId,
    processingState: row.processingState,
    appliedAt: row.appliedAt?.toISOString() ?? null,
    sanitizedReason: row.sanitizedReason,
  };
}

test("billing_financial_refund_created_updated_updated_refolds_real_webhook_snapshots", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed });
  await qualifyFixture(fixture.redemption.id, "in_refund_webhook_delta", db);

  await dispatchReferralRefundWebhook({ eventId: "evt_refund_created_delta", eventType: "refund.created", eventCreated: 100, refundId: "re_webhook_delta", invoiceId: "in_refund_webhook_delta", amount: 250, status: "pending" });
  await dispatchReferralRefundWebhook({ eventId: "evt_refund_updated_delta", eventType: "refund.updated", eventCreated: 200, refundId: "re_webhook_delta", invoiceId: "in_refund_webhook_delta", amount: 275, status: "pending" });
  await dispatchReferralRefundWebhook({ eventId: "evt_refund_updated_terminal", eventType: "refund.updated", eventCreated: 300, refundId: "re_webhook_delta", invoiceId: "in_refund_webhook_delta", amount: 275, status: "succeeded" });

  const rows = await db.select().from(referralDiscountFinancialAdjustments)
    .where(eq(referralDiscountFinancialAdjustments.providerFactId, "re_webhook_delta"));
  assert.equal(rows.length, 3);
  assert.equal(rows.find((row) => row.stripeEventId === "evt_refund_created_delta")?.netRevenueDelta, -250);
  assert.equal(rows.find((row) => row.stripeEventId === "evt_refund_updated_delta")?.netRevenueDelta, -25);
  assert.equal(rows.find((row) => row.stripeEventId === "evt_refund_updated_terminal")?.netRevenueDelta, 0);
  assert.equal(rows.reduce((total, row) => total + row.netRevenueDelta, 0), -275);
});

test("billing_financial_refund_permutations_refold_to_same_terminal_failed_result", async ({ db, seed }) => {
  const outOfOrderFixture = await reserveFixture({ db, seed });
  await qualifyFixture(outOfOrderFixture.redemption.id, "in_refund_webhook_out_of_order", db);
  const inOrderFixture = await reserveFixture({ db, seed });
  await qualifyFixture(inOrderFixture.redemption.id, "in_refund_webhook_in_order", db);

  await dispatchReferralRefundWebhook({ eventId: "evt_refund_failed_early", eventType: "refund.updated", eventCreated: 200, refundId: "re_webhook_out_of_order", invoiceId: "in_refund_webhook_out_of_order", amount: 250, status: "failed" });
  const [failedEarlyBefore] = await db.select().from(referralDiscountFinancialAdjustments)
    .where(eq(referralDiscountFinancialAdjustments.stripeEventId, "evt_refund_failed_early"));
  assert.ok(failedEarlyBefore);
  await dispatchReferralRefundWebhook({ eventId: "evt_refund_created_late", eventType: "refund.created", eventCreated: 100, refundId: "re_webhook_out_of_order", invoiceId: "in_refund_webhook_out_of_order", amount: 250, status: "pending" });
  await dispatchReferralRefundWebhook({ eventId: "evt_refund_created_ordered", eventType: "refund.created", eventCreated: 100, refundId: "re_webhook_in_order", invoiceId: "in_refund_webhook_in_order", amount: 250, status: "pending" });
  await dispatchReferralRefundWebhook({ eventId: "evt_refund_failed_ordered", eventType: "refund.updated", eventCreated: 200, refundId: "re_webhook_in_order", invoiceId: "in_refund_webhook_in_order", amount: 250, status: "failed" });

  const [failedEarlyAfter] = await db.select().from(referralDiscountFinancialAdjustments)
    .where(eq(referralDiscountFinancialAdjustments.stripeEventId, "evt_refund_failed_early"));
  const outOfOrderRows = await db.select().from(referralDiscountFinancialAdjustments)
    .where(eq(referralDiscountFinancialAdjustments.providerFactId, "re_webhook_out_of_order"));
  const inOrderRows = await db.select().from(referralDiscountFinancialAdjustments)
    .where(eq(referralDiscountFinancialAdjustments.providerFactId, "re_webhook_in_order"));
  assert.ok(failedEarlyAfter);
  assert.deepEqual(immutableFinancialRow(failedEarlyAfter), immutableFinancialRow(failedEarlyBefore));
  assert.equal(outOfOrderRows.length, 3);
  assert.equal(inOrderRows.length, 2);
  assert.equal(outOfOrderRows.reduce((total, row) => total + row.netRevenueDelta, 0), 0);
  assert.equal(inOrderRows.reduce((total, row) => total + row.netRevenueDelta, 0), 0);
  assert.equal(outOfOrderRows.find((row) => row.stripeEventId === "evt_refund_created_late")?.netRevenueDelta, -250);
  assert.equal(outOfOrderRows.find((row) => row.stripeEventId === "evt_refund_failed_early")?.netRevenueDelta, 0);
  assert.equal(outOfOrderRows.find((row) => row.stripeEventId === "evt_refund_created_late:lineage_compensation")?.netRevenueDelta, 250);
});

test("billing_financial_refund_pending_to_succeeded_keeps_cumulative_effect", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed });
  await qualifyFixture(fixture.redemption.id, "in_refund_webhook_succeeded", db);

  await dispatchReferralRefundWebhook({ eventId: "evt_refund_pending_success_created", eventType: "refund.created", eventCreated: 100, refundId: "re_webhook_success", invoiceId: "in_refund_webhook_succeeded", amount: 250, status: "pending" });
  await dispatchReferralRefundWebhook({ eventId: "evt_refund_pending_success_updated", eventType: "refund.updated", eventCreated: 200, refundId: "re_webhook_success", invoiceId: "in_refund_webhook_succeeded", amount: 250, status: "succeeded" });

  const rows = await db.select().from(referralDiscountFinancialAdjustments)
    .where(eq(referralDiscountFinancialAdjustments.providerFactId, "re_webhook_success"));
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.stripeEventId === "evt_refund_pending_success_created")?.netRevenueDelta, -250);
  assert.equal(rows.find((row) => row.stripeEventId === "evt_refund_pending_success_updated")?.netRevenueDelta, 0);
  assert.equal(rows.reduce((total, row) => total + row.netRevenueDelta, 0), -250);
});

test("billing_financial_credit_note_updates_use_provider_lineage_delta", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed });
  await qualifyFixture(fixture.redemption.id, "in_credit_webhook_delta", db);

  await dispatchReferralCreditNoteWebhook({ eventId: "evt_credit_created_delta", eventType: "credit_note.created", eventCreated: 100, creditNoteId: "cn_webhook_delta", invoiceId: "in_credit_webhook_delta", amount: 400, status: "issued" });
  await dispatchReferralCreditNoteWebhook({ eventId: "evt_credit_updated_delta", eventType: "credit_note.updated", eventCreated: 200, creditNoteId: "cn_webhook_delta", invoiceId: "in_credit_webhook_delta", amount: 425, status: "issued" });

  const rows = await db.select().from(referralDiscountFinancialAdjustments)
    .where(eq(referralDiscountFinancialAdjustments.providerFactId, "cn_webhook_delta"));
  assert.equal(rows.length, 2);
  assert.equal(rows.reduce((total, row) => total + row.netRevenueDelta, 0), -425);
});

test("billing_financial_same_second_refund_amount_mismatch_parks_without_guessing", async ({ db, seed }) => {
  const firstOrderFixture = await reserveFixture({ db, seed });
  await qualifyFixture(firstOrderFixture.redemption.id, "in_refund_same_second_first", db);
  const reverseOrderFixture = await reserveFixture({ db, seed });
  await qualifyFixture(reverseOrderFixture.redemption.id, "in_refund_same_second_reverse", db);

  await dispatchReferralRefundWebhook({ eventId: "evt_same_second_a_created", eventType: "refund.created", eventCreated: 700, refundId: "re_same_second_a", invoiceId: "in_refund_same_second_first", amount: 250, status: "pending" });
  await dispatchReferralRefundWebhook({ eventId: "evt_same_second_a_updated", eventType: "refund.updated", eventCreated: 700, refundId: "re_same_second_a", invoiceId: "in_refund_same_second_first", amount: 275, status: "pending" });
  await dispatchReferralRefundWebhook({ eventId: "evt_same_second_a_compatible_after_conflict", eventType: "refund.updated", eventCreated: 700, refundId: "re_same_second_a", invoiceId: "in_refund_same_second_first", amount: 250, status: "pending" });
  await dispatchReferralRefundWebhook({ eventId: "evt_same_second_b_updated", eventType: "refund.updated", eventCreated: 700, refundId: "re_same_second_b", invoiceId: "in_refund_same_second_reverse", amount: 275, status: "pending" });
  await dispatchReferralRefundWebhook({ eventId: "evt_same_second_b_created", eventType: "refund.created", eventCreated: 700, refundId: "re_same_second_b", invoiceId: "in_refund_same_second_reverse", amount: 250, status: "pending" });
  await dispatchReferralRefundWebhook({ eventId: "evt_same_second_b_compatible_after_conflict", eventType: "refund.updated", eventCreated: 700, refundId: "re_same_second_b", invoiceId: "in_refund_same_second_reverse", amount: 275, status: "pending" });

  const [parkedA] = await db.select().from(referralDiscountProviderEvents)
    .where(eq(referralDiscountProviderEvents.stripeEventId, "evt_same_second_a_updated"));
  const [parkedACompatible] = await db.select().from(referralDiscountProviderEvents)
    .where(eq(referralDiscountProviderEvents.stripeEventId, "evt_same_second_a_compatible_after_conflict"));
  const [parkedB] = await db.select().from(referralDiscountProviderEvents)
    .where(eq(referralDiscountProviderEvents.stripeEventId, "evt_same_second_b_created"));
  const [parkedBCompatible] = await db.select().from(referralDiscountProviderEvents)
    .where(eq(referralDiscountProviderEvents.stripeEventId, "evt_same_second_b_compatible_after_conflict"));
  const firstOrderRows = await db.select().from(referralDiscountFinancialAdjustments)
    .where(eq(referralDiscountFinancialAdjustments.providerFactId, "re_same_second_a"));
  const reverseOrderRows = await db.select().from(referralDiscountFinancialAdjustments)
    .where(eq(referralDiscountFinancialAdjustments.providerFactId, "re_same_second_b"));
  const [firstOrderRedemption] = await db.select().from(referralDiscountRedemptions)
    .where(eq(referralDiscountRedemptions.id, firstOrderFixture.redemption.id));
  const [reverseOrderRedemption] = await db.select().from(referralDiscountRedemptions)
    .where(eq(referralDiscountRedemptions.id, reverseOrderFixture.redemption.id));
  assert.equal(parkedA.processingState, "parked");
  assert.equal(parkedACompatible.processingState, "parked");
  assert.equal(parkedB.processingState, "parked");
  assert.equal(parkedBCompatible.processingState, "parked");
  assert.equal(firstOrderRows.reduce((total, row) => total + row.netRevenueDelta, 0), 0);
  assert.equal(reverseOrderRows.reduce((total, row) => total + row.netRevenueDelta, 0), 0);
  assert.equal(firstOrderRedemption.qualificationDisposition, reverseOrderRedemption.qualificationDisposition);
  assert.equal(firstOrderRedemption.financialRisk, reverseOrderRedemption.financialRisk);
  assert.equal(firstOrderRedemption.qualificationDisposition, "qualified");
  assert.equal(firstOrderRedemption.financialRisk, "clear");
});

test("billing_financial_same_second_refund_conflicting_terminal_snapshots_park_without_guessing", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed });
  await qualifyFixture(fixture.redemption.id, "in_refund_same_second_conflict", db);
  const reverseFixture = await reserveFixture({ db, seed });
  await qualifyFixture(reverseFixture.redemption.id, "in_refund_same_second_conflict_reverse", db);

  await dispatchReferralRefundWebhook({ eventId: "evt_same_second_conflict_succeeded", eventType: "refund.updated", eventCreated: 800, refundId: "re_same_second_conflict", invoiceId: "in_refund_same_second_conflict", amount: 250, status: "succeeded" });
  await dispatchReferralRefundWebhook({ eventId: "evt_same_second_conflict_failed", eventType: "refund.updated", eventCreated: 800, refundId: "re_same_second_conflict", invoiceId: "in_refund_same_second_conflict", amount: 250, status: "failed" });
  await dispatchReferralRefundWebhook({ eventId: "evt_same_second_conflict_failed_after_conflict", eventType: "refund.updated", eventCreated: 800, refundId: "re_same_second_conflict", invoiceId: "in_refund_same_second_conflict", amount: 250, status: "failed" });
  await dispatchReferralRefundWebhook({ eventId: "evt_same_second_conflict_reverse_failed", eventType: "refund.updated", eventCreated: 800, refundId: "re_same_second_conflict_reverse", invoiceId: "in_refund_same_second_conflict_reverse", amount: 250, status: "failed" });
  await dispatchReferralRefundWebhook({ eventId: "evt_same_second_conflict_reverse_succeeded", eventType: "refund.updated", eventCreated: 800, refundId: "re_same_second_conflict_reverse", invoiceId: "in_refund_same_second_conflict_reverse", amount: 250, status: "succeeded" });
  await dispatchReferralRefundWebhook({ eventId: "evt_same_second_conflict_succeeded_after_conflict", eventType: "refund.updated", eventCreated: 800, refundId: "re_same_second_conflict_reverse", invoiceId: "in_refund_same_second_conflict_reverse", amount: 250, status: "succeeded" });
  await dispatchReferralRefundWebhook({ eventId: "evt_same_second_conflict_reverse_failed_after_conflict", eventType: "refund.updated", eventCreated: 800, refundId: "re_same_second_conflict_reverse", invoiceId: "in_refund_same_second_conflict_reverse", amount: 250, status: "failed" });

  const [parked] = await db.select().from(referralDiscountProviderEvents)
    .where(eq(referralDiscountProviderEvents.stripeEventId, "evt_same_second_conflict_failed"));
  const [parkedFailedAfterConflict] = await db.select().from(referralDiscountProviderEvents)
    .where(eq(referralDiscountProviderEvents.stripeEventId, "evt_same_second_conflict_failed_after_conflict"));
  const [parkedReverse] = await db.select().from(referralDiscountProviderEvents)
    .where(eq(referralDiscountProviderEvents.stripeEventId, "evt_same_second_conflict_reverse_succeeded"));
  const [parkedSucceededAfterConflict] = await db.select().from(referralDiscountProviderEvents)
    .where(eq(referralDiscountProviderEvents.stripeEventId, "evt_same_second_conflict_succeeded_after_conflict"));
  const [parkedReverseFailedAfterConflict] = await db.select().from(referralDiscountProviderEvents)
    .where(eq(referralDiscountProviderEvents.stripeEventId, "evt_same_second_conflict_reverse_failed_after_conflict"));
  const rows = await db.select().from(referralDiscountFinancialAdjustments)
    .where(eq(referralDiscountFinancialAdjustments.providerFactId, "re_same_second_conflict"));
  const reverseRows = await db.select().from(referralDiscountFinancialAdjustments)
    .where(eq(referralDiscountFinancialAdjustments.providerFactId, "re_same_second_conflict_reverse"));
  const [redemption] = await db.select().from(referralDiscountRedemptions)
    .where(eq(referralDiscountRedemptions.id, fixture.redemption.id));
  const [reverseRedemption] = await db.select().from(referralDiscountRedemptions)
    .where(eq(referralDiscountRedemptions.id, reverseFixture.redemption.id));
  assert.equal(parked.processingState, "parked");
  assert.equal(parkedFailedAfterConflict.processingState, "parked");
  assert.equal(parkedReverse.processingState, "parked");
  assert.equal(parkedSucceededAfterConflict.processingState, "parked");
  assert.equal(parkedReverseFailedAfterConflict.processingState, "parked");
  assert.equal(rows.reduce((total, row) => total + row.netRevenueDelta, 0), 0);
  assert.equal(reverseRows.reduce((total, row) => total + row.netRevenueDelta, 0), 0);
  assert.equal(redemption.qualificationDisposition, "qualified");
  assert.equal(redemption.financialRisk, "clear");
  assert.equal(reverseRedemption.qualificationDisposition, "qualified");
  assert.equal(reverseRedemption.financialRisk, "clear");
});

test("billing_financial_credit_note_voided_compensates_same_lineage_without_second_negative", async ({ db, seed }) => {
  const outOfOrderFixture = await reserveFixture({ db, seed });
  await qualifyFixture(outOfOrderFixture.redemption.id, "in_credit_void_out_of_order", db);
  await seedPaidInvoiceFact("in_credit_void_out_of_order", 400, db, {
    serverId: outOfOrderFixture.server.id,
    payerUserId: outOfOrderFixture.redeemer.id,
    ownerUserId: outOfOrderFixture.owner.id,
  });
  const inOrderFixture = await reserveFixture({ db, seed });
  await qualifyFixture(inOrderFixture.redemption.id, "in_credit_void_in_order", db);
  await seedPaidInvoiceFact("in_credit_void_in_order", 400, db, {
    serverId: inOrderFixture.server.id,
    payerUserId: inOrderFixture.redeemer.id,
    ownerUserId: inOrderFixture.owner.id,
  });

  await dispatchReferralCreditNoteWebhook({ eventId: "evt_credit_void_early", eventType: "credit_note.voided", eventCreated: 300, creditNoteId: "cn_void_out_of_order", invoiceId: "in_credit_void_out_of_order", amount: 400, status: "voided" });
  await dispatchReferralCreditNoteWebhook({ eventId: "evt_credit_created_late", eventType: "credit_note.created", eventCreated: 100, creditNoteId: "cn_void_out_of_order", invoiceId: "in_credit_void_out_of_order", amount: 400, status: "issued" });
  await dispatchReferralCreditNoteWebhook({ eventId: "evt_credit_created_ordered", eventType: "credit_note.created", eventCreated: 100, creditNoteId: "cn_void_in_order", invoiceId: "in_credit_void_in_order", amount: 400, status: "issued" });
  await dispatchReferralCreditNoteWebhook({ eventId: "evt_credit_void_ordered", eventType: "credit_note.voided", eventCreated: 300, creditNoteId: "cn_void_in_order", invoiceId: "in_credit_void_in_order", amount: 400, status: "voided" });

  const outOfOrderRows = await db.select().from(referralDiscountFinancialAdjustments)
    .where(eq(referralDiscountFinancialAdjustments.providerFactId, "cn_void_out_of_order"));
  const inOrderRows = await db.select().from(referralDiscountFinancialAdjustments)
    .where(eq(referralDiscountFinancialAdjustments.providerFactId, "cn_void_in_order"));
  assert.equal(outOfOrderRows.reduce((total, row) => total + row.netRevenueDelta, 0), 0);
  assert.equal(inOrderRows.reduce((total, row) => total + row.netRevenueDelta, 0), 0);
  assert.equal(outOfOrderRows.find((row) => row.stripeEventId === "evt_credit_void_early")?.netRevenueDelta, 0);
  assert.equal(outOfOrderRows.find((row) => row.stripeEventId === "evt_credit_created_late")?.netRevenueDelta, -400);
  assert.equal(outOfOrderRows.find((row) => row.stripeEventId === "evt_credit_created_late:lineage_compensation")?.netRevenueDelta, 400);
  const [outOfOrderRedemption] = await db.select().from(referralDiscountRedemptions)
    .where(eq(referralDiscountRedemptions.id, outOfOrderFixture.redemption.id));
  assert.equal(outOfOrderRedemption.qualificationDisposition, "qualified");
  assert.equal(outOfOrderRedemption.financialRisk, "clear");
});

test("billing_financial_refund_full_reversal_uses_first_paid_invoice_net_economics", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed });
  await qualifyFixture(fixture.redemption.id, "in_refund_net_economics", db);
  await seedPaidInvoiceFact("in_refund_net_economics", 1000, db, {
    serverId: fixture.server.id,
    payerUserId: fixture.redeemer.id,
    ownerUserId: fixture.owner.id,
  });

  await dispatchReferralRefundWebhook({ eventId: "evt_refund_partial_net", eventType: "refund.created", eventCreated: 100, refundId: "re_net_economics", invoiceId: "in_refund_net_economics", amount: 500, status: "succeeded" });
  const [partial] = await db.select().from(referralDiscountRedemptions)
    .where(eq(referralDiscountRedemptions.id, fixture.redemption.id));
  assert.equal(partial.qualificationDisposition, "qualified");

  await dispatchReferralRefundWebhook({ eventId: "evt_refund_full_net", eventType: "refund.updated", eventCreated: 200, refundId: "re_net_economics", invoiceId: "in_refund_net_economics", amount: 1000, status: "succeeded" });
  const [full] = await db.select().from(referralDiscountRedemptions)
    .where(eq(referralDiscountRedemptions.id, fixture.redemption.id));
  assert.equal(full.qualificationDisposition, "reversed");

  await dispatchReferralRefundWebhook({ eventId: "evt_refund_reduced_net", eventType: "refund.updated", eventCreated: 300, refundId: "re_net_economics", invoiceId: "in_refund_net_economics", amount: 500, status: "succeeded" });
  const [reduced] = await db.select().from(referralDiscountRedemptions)
    .where(eq(referralDiscountRedemptions.id, fixture.redemption.id));
  assert.equal(reduced.qualificationDisposition, "qualified");
  const rows = await db.select().from(referralDiscountFinancialAdjustments)
    .where(eq(referralDiscountFinancialAdjustments.providerFactId, "re_net_economics"));
  assert.equal(rows.reduce((total, row) => total + row.netRevenueDelta, 0), -500);
});

test("billing_financial_paid_identity_fold_requires_matching_livemode_and_resolved_identity", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed });
  await qualifyFixture(fixture.redemption.id, "in_paid_identity_collision", db);
  await seedPaidInvoiceFact("in_paid_identity_collision", 500, db, {
    serverId: fixture.server.id,
    payerUserId: fixture.redeemer.id,
    ownerUserId: fixture.owner.id,
    livemode: true,
  });
  await seedPaidInvoiceFact("in_paid_identity_collision", 1000, db, {
    serverId: fixture.server.id,
    payerUserId: fixture.redeemer.id,
    ownerUserId: fixture.owner.id,
  });

  await dispatchReferralRefundWebhook({ eventId: "evt_refund_collision_partial", eventType: "refund.created", eventCreated: 100, refundId: "re_paid_identity_collision", invoiceId: "in_paid_identity_collision", amount: 500, status: "succeeded" });
  const [partial] = await db.select().from(referralDiscountRedemptions)
    .where(eq(referralDiscountRedemptions.id, fixture.redemption.id));
  assert.equal(partial.qualificationDisposition, "qualified");

  await dispatchReferralRefundWebhook({ eventId: "evt_refund_collision_full", eventType: "refund.updated", eventCreated: 200, refundId: "re_paid_identity_collision", invoiceId: "in_paid_identity_collision", amount: 1000, status: "succeeded" });
  const [full] = await db.select().from(referralDiscountRedemptions)
    .where(eq(referralDiscountRedemptions.id, fixture.redemption.id));
  assert.equal(full.qualificationDisposition, "reversed");
});

test("billing_financial_fold_filters_applied_facts_by_authority_axis", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed });
  await qualifyFixture(fixture.redemption.id, "in_adjustment_axis_collision", db);
  await seedPaidInvoiceFact("in_adjustment_axis_collision", 1000, db, {
    serverId: fixture.server.id,
    payerUserId: fixture.redeemer.id,
    ownerUserId: fixture.owner.id,
  });
  await recordReferralFinancialAdjustment({
    redemptionId: fixture.redemption.id,
    environment: "stripe",
    livemode: true,
    kind: "refund",
    providerFactId: "re_axis_live",
    stripeEventId: "evt_axis_live",
    stripeInvoiceId: "in_adjustment_axis_collision",
    stripeRefundId: "re_axis_live",
    currency: "usd",
    amount: 1000,
    netRevenueDelta: -1000,
    fullEconomicReversal: true,
  }, db);

  await dispatchReferralRefundWebhook({ eventId: "evt_axis_test_partial", eventType: "refund.created", eventCreated: 100, refundId: "re_axis_test", invoiceId: "in_adjustment_axis_collision", amount: 250, status: "succeeded" });
  const [redemption] = await db.select().from(referralDiscountRedemptions)
    .where(eq(referralDiscountRedemptions.id, fixture.redemption.id));
  assert.equal(redemption.qualificationDisposition, "qualified");
});

test("billing_financial_refund_failed_update_before_created_compensates_and_refolds_disposition", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed });
  await qualifyFixture(fixture.redemption.id, "in_refund_failed_out_of_order", db);
  await seedPaidInvoiceFact("in_refund_failed_out_of_order", 400, db, {
    serverId: fixture.server.id,
    payerUserId: fixture.redeemer.id,
    ownerUserId: fixture.owner.id,
  });

  await dispatchReferralRefundWebhook({ eventId: "evt_refund_failed_early", eventType: "refund.updated", eventCreated: 300, refundId: "re_failed_out_of_order", invoiceId: "in_refund_failed_out_of_order", amount: 400, status: "failed" });
  await dispatchReferralRefundWebhook({ eventId: "evt_refund_created_late_after_failed", eventType: "refund.created", eventCreated: 100, refundId: "re_failed_out_of_order", invoiceId: "in_refund_failed_out_of_order", amount: 400, status: "pending" });

  const rows = await db.select().from(referralDiscountFinancialAdjustments)
    .where(eq(referralDiscountFinancialAdjustments.providerFactId, "re_failed_out_of_order"));
  const [redemption] = await db.select().from(referralDiscountRedemptions)
    .where(eq(referralDiscountRedemptions.id, fixture.redemption.id));
  assert.equal(rows.reduce((total, row) => total + row.netRevenueDelta, 0), 0);
  assert.equal(redemption.qualificationDisposition, "qualified");
  assert.equal(redemption.financialRisk, "clear");
});

test("billing_financial_dispute_close_before_open_converges_after_open_without_guessing", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed });
  await qualifyFixture(fixture.redemption.id, "in_dispute_out_of_order", db);

  await dispatchReferralDisputeWebhook({ eventId: "evt_dispute_lost_early", eventType: "charge.dispute.closed", eventCreated: 200, disputeId: "dp_out_of_order", invoiceId: "in_dispute_out_of_order", amount: 1000, status: "lost" });
  const [early] = await db.select().from(referralDiscountFinancialAdjustments)
    .where(eq(referralDiscountFinancialAdjustments.stripeEventId, "evt_dispute_lost_early"));
  assert.equal(early.processingState, "parked");

  await dispatchReferralDisputeWebhook({ eventId: "evt_dispute_open_late", eventType: "charge.dispute.created", eventCreated: 100, disputeId: "dp_out_of_order", invoiceId: "in_dispute_out_of_order", amount: 1000, status: "needs_response" });
  const [late] = await db.select().from(referralDiscountFinancialAdjustments)
    .where(eq(referralDiscountFinancialAdjustments.stripeEventId, "evt_dispute_lost_early"));
  const [redemption] = await db.select().from(referralDiscountRedemptions)
    .where(eq(referralDiscountRedemptions.id, fixture.redemption.id));
  assert.equal(late.processingState, "applied");
  assert.equal(redemption.qualificationDisposition, "reversed");
  assert.equal(redemption.financialRisk, "clear");
});

test("billing_financial_dispute_lost_then_won_restores_with_paid_fact", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed });
  await qualifyFixture(fixture.redemption.id, "in_dispute_lost_then_won", db);
  await seedPaidInvoiceFact("in_dispute_lost_then_won", 1000, db, {
    serverId: fixture.server.id,
    payerUserId: fixture.redeemer.id,
    ownerUserId: fixture.owner.id,
  });

  await dispatchReferralDisputeWebhook({ eventId: "evt_dispute_lost_won_open", eventType: "charge.dispute.created", eventCreated: 100, disputeId: "dp_lost_then_won", invoiceId: "in_dispute_lost_then_won", amount: 1000, status: "needs_response" });
  await dispatchReferralDisputeWebhook({ eventId: "evt_dispute_lost_won_lost", eventType: "charge.dispute.closed", eventCreated: 200, disputeId: "dp_lost_then_won", invoiceId: "in_dispute_lost_then_won", amount: 1000, status: "lost" });
  const [lost] = await db.select().from(referralDiscountRedemptions)
    .where(eq(referralDiscountRedemptions.id, fixture.redemption.id));
  assert.equal(lost.qualificationDisposition, "reversed");

  await dispatchReferralDisputeWebhook({ eventId: "evt_dispute_lost_won_won", eventType: "charge.dispute.closed", eventCreated: 300, disputeId: "dp_lost_then_won", invoiceId: "in_dispute_lost_then_won", amount: 1000, status: "won" });
  const [won] = await db.select().from(referralDiscountRedemptions)
    .where(eq(referralDiscountRedemptions.id, fixture.redemption.id));
  assert.equal(won.qualificationDisposition, "qualified");
  assert.equal(won.financialRisk, "clear");
});

test("billing_financial_dispute_latest_open_after_won_is_disputed_and_latest_lost_reverses", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed });
  await qualifyFixture(fixture.redemption.id, "in_dispute_permutations", db);

  await dispatchReferralDisputeWebhook({ eventId: "evt_dispute_permutation_open", eventType: "charge.dispute.created", eventCreated: 100, disputeId: "dp_permutation", invoiceId: "in_dispute_permutations", amount: 1000, status: "needs_response" });
  await dispatchReferralDisputeWebhook({ eventId: "evt_dispute_permutation_won", eventType: "charge.dispute.closed", eventCreated: 200, disputeId: "dp_permutation", invoiceId: "in_dispute_permutations", amount: 1000, status: "won" });
  await dispatchReferralDisputeWebhook({ eventId: "evt_dispute_permutation_reopen", eventType: "charge.dispute.created", eventCreated: 300, disputeId: "dp_permutation", invoiceId: "in_dispute_permutations", amount: 1000, status: "needs_response" });
  const [reopened] = await db.select().from(referralDiscountRedemptions)
    .where(eq(referralDiscountRedemptions.id, fixture.redemption.id));
  assert.equal(reopened.qualificationDisposition, "qualified");
  assert.equal(reopened.financialRisk, "disputed");

  await dispatchReferralDisputeWebhook({ eventId: "evt_dispute_permutation_lost", eventType: "charge.dispute.closed", eventCreated: 400, disputeId: "dp_permutation", invoiceId: "in_dispute_permutations", amount: 1000, status: "lost" });
  const [lost] = await db.select().from(referralDiscountRedemptions)
    .where(eq(referralDiscountRedemptions.id, fixture.redemption.id));
  assert.equal(lost.qualificationDisposition, "reversed");
  assert.equal(lost.financialRisk, "clear");
});

test("billing_financial_dispute_lost_is_not_undone_by_later_partial_refund", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed });
  await qualifyFixture(fixture.redemption.id, "in_dispute_lost_then_refund", db);
  await seedPaidInvoiceFact("in_dispute_lost_then_refund", 1000, db, {
    serverId: fixture.server.id,
    payerUserId: fixture.redeemer.id,
    ownerUserId: fixture.owner.id,
  });

  await dispatchReferralDisputeWebhook({ eventId: "evt_dispute_lost_refund_open", eventType: "charge.dispute.created", eventCreated: 100, disputeId: "dp_lost_then_refund", invoiceId: "in_dispute_lost_then_refund", amount: 1000, status: "needs_response" });
  await dispatchReferralDisputeWebhook({ eventId: "evt_dispute_lost_refund_lost", eventType: "charge.dispute.closed", eventCreated: 200, disputeId: "dp_lost_then_refund", invoiceId: "in_dispute_lost_then_refund", amount: 1000, status: "lost" });
  await dispatchReferralRefundWebhook({ eventId: "evt_dispute_lost_refund_partial", eventType: "refund.created", eventCreated: 300, refundId: "re_after_lost_dispute", invoiceId: "in_dispute_lost_then_refund", amount: 250, status: "succeeded" });

  const [redemption] = await db.select().from(referralDiscountRedemptions)
    .where(eq(referralDiscountRedemptions.id, fixture.redemption.id));
  assert.equal(redemption.qualificationDisposition, "reversed");
  assert.equal(redemption.financialRisk, "clear");
});

test("billing_financial_multiple_disputes_compose_reversal_and_open_risk", async ({ db, seed }) => {
  const lostFirstFixture = await reserveFixture({ db, seed });
  await qualifyFixture(lostFirstFixture.redemption.id, "in_dispute_lost_open_a", db);
  const openFirstFixture = await reserveFixture({ db, seed });
  await qualifyFixture(openFirstFixture.redemption.id, "in_dispute_lost_open_b", db);

  await dispatchReferralDisputeWebhook({ eventId: "evt_multi_a_open_lost", eventType: "charge.dispute.created", eventCreated: 100, disputeId: "dp_multi_a", invoiceId: "in_dispute_lost_open_a", amount: 1000, status: "needs_response" });
  await dispatchReferralDisputeWebhook({ eventId: "evt_multi_a_lost", eventType: "charge.dispute.closed", eventCreated: 200, disputeId: "dp_multi_a", invoiceId: "in_dispute_lost_open_a", amount: 1000, status: "lost" });
  await dispatchReferralDisputeWebhook({ eventId: "evt_multi_b_open_after_lost", eventType: "charge.dispute.created", eventCreated: 300, disputeId: "dp_multi_b", invoiceId: "in_dispute_lost_open_a", amount: 1000, status: "needs_response" });
  const [lostPlusOpen] = await db.select().from(referralDiscountRedemptions)
    .where(eq(referralDiscountRedemptions.id, lostFirstFixture.redemption.id));
  assert.equal(lostPlusOpen.qualificationDisposition, "reversed");
  assert.equal(lostPlusOpen.financialRisk, "disputed");

  await dispatchReferralDisputeWebhook({ eventId: "evt_multi_c_open_first", eventType: "charge.dispute.created", eventCreated: 100, disputeId: "dp_multi_c", invoiceId: "in_dispute_lost_open_b", amount: 1000, status: "needs_response" });
  await dispatchReferralDisputeWebhook({ eventId: "evt_multi_d_open_second", eventType: "charge.dispute.created", eventCreated: 200, disputeId: "dp_multi_d", invoiceId: "in_dispute_lost_open_b", amount: 1000, status: "needs_response" });
  await dispatchReferralDisputeWebhook({ eventId: "evt_multi_c_lost_after_open", eventType: "charge.dispute.closed", eventCreated: 300, disputeId: "dp_multi_c", invoiceId: "in_dispute_lost_open_b", amount: 1000, status: "lost" });
  const [openPlusLost] = await db.select().from(referralDiscountRedemptions)
    .where(eq(referralDiscountRedemptions.id, openFirstFixture.redemption.id));
  assert.equal(openPlusLost.qualificationDisposition, "reversed");
  assert.equal(openPlusLost.financialRisk, "disputed");

  await dispatchReferralDisputeWebhook({ eventId: "evt_multi_a_won_after_open", eventType: "charge.dispute.closed", eventCreated: 400, disputeId: "dp_multi_a", invoiceId: "in_dispute_lost_open_a", amount: 1000, status: "won" });
  const [wonPlusOpen] = await db.select().from(referralDiscountRedemptions)
    .where(eq(referralDiscountRedemptions.id, lostFirstFixture.redemption.id));
  assert.equal(wonPlusOpen.qualificationDisposition, "qualified");
  assert.equal(wonPlusOpen.financialRisk, "disputed");
});

test("billing_financial_dispute_unknown_close_status_parks_without_mutating_referral", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed });
  await qualifyFixture(fixture.redemption.id, "in_dispute_unknown", db);

  await dispatchReferralDisputeWebhook({ eventId: "evt_dispute_unknown", eventType: "charge.dispute.closed", eventCreated: 200, disputeId: "dp_unknown", invoiceId: "in_dispute_unknown", amount: 1000, status: "warning_closed" });
  const [event] = await db.select().from(referralDiscountProviderEvents)
    .where(eq(referralDiscountProviderEvents.stripeEventId, "evt_dispute_unknown"));
  const [redemption] = await db.select().from(referralDiscountRedemptions)
    .where(eq(referralDiscountRedemptions.id, fixture.redemption.id));
  assert.equal(event.processingState, "parked");
  assert.equal(redemption.qualificationDisposition, "qualified");
  assert.equal(redemption.financialRisk, "clear");
});

test("billing_webhook_dispatch_referral_failure_does_not_rollback_subscription_projection", async ({ db, seed }) => {
  const previousEnv = {
    STRIPE_PRO_SEAT_MONTHLY_PRICE_ID: process.env.STRIPE_PRO_SEAT_MONTHLY_PRICE_ID,
    STRIPE_PRO_SEAT_ANNUAL_PRICE_ID: process.env.STRIPE_PRO_SEAT_ANNUAL_PRICE_ID,
  };
  process.env.STRIPE_PRO_SEAT_MONTHLY_PRICE_ID = "price_pro";
  process.env.STRIPE_PRO_SEAT_ANNUAL_PRICE_ID = "price_pro_annual";
  const fixture = await reserveFixture({ db, seed });
  await completeCheckout(fixture.redemption.id, db);
  const subscription = referralBillingSubscription({
    id: "sub_referral_dispatch",
    serverId: fixture.server.id,
    userId: fixture.owner.id,
    redemptionId: fixture.redemption.id,
  });
  __setStripeForTests({
    subscriptions: { retrieve: async () => subscription },
  } as unknown as Stripe);
  __setReferralStripeForTests({
    invoices: {
      retrieve: async () => {
        throw new Error("synthetic referral invoice retrieve failure");
      },
    },
  } as unknown as Stripe);
  try {
    await runBillingWebhookWithTrace(() => handleWebhookEvent(referralBillingInvoicePaidEvent("evt_referral_dispatch_invoice_paid", {
      id: "in_referral_dispatch",
      livemode: false,
      customer: "cus_referral_dispatch",
      currency: "usd",
      amount_paid: 1000,
      lines: { data: [] },
      parent: { subscription_details: { subscription: "sub_referral_dispatch" } },
    })));
    await runBillingWebhookWithTrace(() => handleWebhookEvent(referralBillingInvoicePaidEvent("evt_referral_dispatch_invoice_paid", {
      id: "in_referral_dispatch",
      livemode: false,
      customer: "cus_referral_dispatch",
      currency: "usd",
      amount_paid: 1000,
      lines: { data: [] },
      parent: { subscription_details: { subscription: "sub_referral_dispatch" } },
    })));

    const [projection] = await db.select().from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, "sub_referral_dispatch"));
    const [event] = await db.select().from(referralDiscountProviderEvents)
      .where(eq(referralDiscountProviderEvents.stripeEventId, "evt_referral_dispatch_invoice_paid"));
    assert.equal(projection.status, "active");
    assert.equal(projection.lastProviderEventId, "evt_referral_dispatch_invoice_paid");
    assert.equal(projection.provisionedHumanSeats, 1);
    assert.equal(event.processingState, "parked");
    assert.equal(event.sanitizedErrorCode, "provider_retrieve_failed");
  } finally {
    __resetStripeForTests();
    if (previousEnv.STRIPE_PRO_SEAT_MONTHLY_PRICE_ID == null) {
      delete process.env.STRIPE_PRO_SEAT_MONTHLY_PRICE_ID;
    } else {
      process.env.STRIPE_PRO_SEAT_MONTHLY_PRICE_ID = previousEnv.STRIPE_PRO_SEAT_MONTHLY_PRICE_ID;
    }
    if (previousEnv.STRIPE_PRO_SEAT_ANNUAL_PRICE_ID == null) {
      delete process.env.STRIPE_PRO_SEAT_ANNUAL_PRICE_ID;
    } else {
      process.env.STRIPE_PRO_SEAT_ANNUAL_PRICE_ID = previousEnv.STRIPE_PRO_SEAT_ANNUAL_PRICE_ID;
    }
  }
});

test("financial_adjustment_full_refund_reverses_attribution", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed });
  await qualifyFixture(fixture.redemption.id, "in_full_refund", db);

  const folded = await recordReferralFinancialAdjustment({
    redemptionId: fixture.redemption.id,
    environment: "stripe",
    livemode: true,
    kind: "refund",
    providerFactId: "re_full_1",
    stripeEventId: "evt_re_full_1",
    stripeInvoiceId: "in_full_refund",
    stripeRefundId: "re_2",
    currency: "usd",
    amount: 1000,
    netRevenueDelta: -1000,
    fullEconomicReversal: true,
  }, db);

  assert.equal(folded.redemption?.qualificationDisposition, "reversed");
  const [campaign] = await db.select().from(referralDiscountCampaigns);
  assert.equal(campaign.qualifiedCount, 1, "refund reversal must not reopen lifetime cap capacity");
});

test("financial_adjustment_dispute_won_keeps_or_restores_qualified", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed });
  await qualifyFixture(fixture.redemption.id, "in_dispute_won", db);
  await recordReferralFinancialAdjustment({
    redemptionId: fixture.redemption.id,
    environment: "stripe",
    livemode: true,
    kind: "dispute_opened",
    providerFactId: "dp_open_2",
    stripeEventId: "evt_dp_open_2",
    stripeInvoiceId: "in_dispute_won",
    stripeDisputeId: "dp_2",
    currency: "usd",
    amount: 1000,
    netRevenueDelta: 0,
  }, db);

  const folded = await recordReferralFinancialAdjustment({
    redemptionId: fixture.redemption.id,
    environment: "stripe",
    livemode: true,
    kind: "dispute_won",
    providerFactId: "dp_won_2",
    stripeEventId: "evt_dp_won_2",
    stripeInvoiceId: "in_dispute_won",
    stripeDisputeId: "dp_2",
    currency: "usd",
    amount: 1000,
    netRevenueDelta: 0,
  }, db);

  assert.equal(folded.status, "recorded");
  assert.equal(folded.redemption?.qualificationDisposition, "qualified");
  assert.equal(folded.redemption?.financialRisk, "clear");
});

test("financial_adjustment_wrong_invoice_parks_without_mutating_referral", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed });
  await qualifyFixture(fixture.redemption.id, "in_right_invoice", db);

  const folded = await recordReferralFinancialAdjustment({
    redemptionId: fixture.redemption.id,
    environment: "stripe",
    livemode: true,
    kind: "refund",
    providerFactId: "re_wrong_invoice",
    stripeEventId: "evt_re_wrong_invoice",
    stripeInvoiceId: "in_wrong_invoice",
    stripeRefundId: "re_wrong",
    currency: "usd",
    amount: 1000,
    netRevenueDelta: -1000,
    fullEconomicReversal: true,
  }, db);

  assert.equal(folded.status, "parked");
  const [redemption] = await db.select().from(referralDiscountRedemptions);
  assert.equal(redemption.qualificationDisposition, "qualified");
  const [adjustment] = await db.select().from(referralDiscountFinancialAdjustments);
  assert.equal(adjustment.processingState, "parked");
  assert.equal(adjustment.observedRedemptionId, fixture.redemption.id);
  assert.equal(adjustment.resolvedRedemptionId, null);
});

test("financial_adjustment_can_park_without_any_redemption_locator", async ({ db }) => {
  const folded = await recordReferralFinancialAdjustment({
    environment: "stripe",
    livemode: true,
    kind: "refund",
    providerFactId: "re_unjoined",
    stripeEventId: "evt_re_unjoined",
    stripeInvoiceId: "in_unjoined",
    stripeRefundId: "re_unjoined",
    currency: "usd",
    amount: 1000,
    netRevenueDelta: -1000,
    fullEconomicReversal: true,
  }, db);

  assert.equal(folded.status, "parked");
  assert.equal(folded.redemption, null);
  const [adjustment] = await db.select().from(referralDiscountFinancialAdjustments);
  assert.equal(adjustment.observedRedemptionId, null);
  assert.equal(adjustment.resolvedRedemptionId, null);
  assert.equal(adjustment.processingState, "parked");
});

test("financial_adjustment_dispute_lost_without_open_parks_without_reversing", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed });
  await qualifyFixture(fixture.redemption.id, "in_dispute_lost_without_open", db);

  const folded = await recordReferralFinancialAdjustment({
    redemptionId: fixture.redemption.id,
    environment: "stripe",
    livemode: true,
    kind: "dispute_lost",
    providerFactId: "dp_lost_without_open",
    stripeEventId: "evt_dp_lost_without_open",
    stripeInvoiceId: "in_dispute_lost_without_open",
    stripeDisputeId: "dp_without_open",
    currency: "usd",
    amount: 1000,
    netRevenueDelta: -1000,
  }, db);

  assert.equal(folded.status, "parked");
  const [redemption] = await db.select().from(referralDiscountRedemptions);
  assert.equal(redemption.qualificationDisposition, "qualified");
});

test("financial_adjustment_parked_fact_can_replay_after_reconciliation", async ({ db, seed }) => {
  const wrong = await reserveFixture({ db, seed });
  await qualifyFixture(wrong.redemption.id, "in_wrong_redemption", db);
  const correct = await reserveFixture({ db, seed });
  await qualifyFixture(correct.redemption.id, "in_correct_redemption", db);

  const first = await recordReferralFinancialAdjustment({
    redemptionId: wrong.redemption.id,
    environment: "stripe",
    livemode: true,
    kind: "refund",
    providerFactId: "re_replayed",
    stripeEventId: "evt_re_replayed",
    stripeInvoiceId: "in_correct_redemption",
    stripeRefundId: "re_replayed",
    currency: "usd",
    amount: 1000,
    netRevenueDelta: -1000,
    fullEconomicReversal: true,
  }, db);
  assert.equal(first.status, "parked");

  const replay = await recordReferralFinancialAdjustment({
    redemptionId: correct.redemption.id,
    environment: "stripe",
    livemode: true,
    kind: "refund",
    providerFactId: "re_replayed",
    stripeEventId: "evt_re_replayed",
    stripeInvoiceId: "in_correct_redemption",
    stripeRefundId: "re_replayed",
    currency: "usd",
    amount: 1000,
    netRevenueDelta: -1000,
    fullEconomicReversal: true,
  }, db);

  assert.equal(replay.status, "recorded");
  assert.equal(replay.redemption?.id, correct.redemption.id);
  assert.equal(replay.redemption?.qualificationDisposition, "reversed");
  const [adjustment] = await db.select().from(referralDiscountFinancialAdjustments);
  assert.equal(adjustment.observedRedemptionId, wrong.redemption.id);
  assert.equal(adjustment.resolvedRedemptionId, correct.redemption.id);
  assert.equal(adjustment.processingState, "applied");
  const [resolution] = await db.select().from(referralDiscountFinancialAdjustmentResolutions);
  assert.equal(resolution.redemptionId, correct.redemption.id);
});

test("financial_adjustment_conflicting_resolution_fails_closed", async ({ db, seed }) => {
  const first = await reserveFixture({ db, seed });
  await qualifyFixture(first.redemption.id, "in_conflict_resolution", db);
  const second = await reserveFixture({ db, seed });
  await qualifyFixture(second.redemption.id, "in_conflict_resolution_other", db);
  await recordReferralFinancialAdjustment({
    redemptionId: first.redemption.id,
    environment: "stripe",
    livemode: true,
    kind: "refund",
    providerFactId: "re_resolution_conflict",
    stripeEventId: "evt_re_resolution_conflict",
    stripeInvoiceId: "in_conflict_resolution",
    stripeRefundId: "re_resolution_conflict",
    currency: "usd",
    amount: 1000,
    netRevenueDelta: -1000,
    fullEconomicReversal: true,
  }, db);

  await assert.rejects(
    () => recordReferralFinancialAdjustment({
      redemptionId: second.redemption.id,
      environment: "stripe",
      livemode: true,
      kind: "refund",
      providerFactId: "re_resolution_conflict",
      stripeEventId: "evt_re_resolution_conflict",
      stripeInvoiceId: "in_conflict_resolution",
      stripeRefundId: "re_resolution_conflict",
      currency: "usd",
      amount: 1000,
      netRevenueDelta: -1000,
      fullEconomicReversal: true,
    }, db),
    (error) => {
      assertReferralError(error, "financial_adjustment_resolution_conflict");
      return true;
    },
  );
});

test("financial_adjustment_delete_retains_append_only_audit_rows", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed });
  await qualifyFixture(fixture.redemption.id, "in_delete_retention", db);
  await recordReferralFinancialAdjustment({
    redemptionId: fixture.redemption.id,
    environment: "stripe",
    livemode: true,
    kind: "refund",
    providerFactId: "re_delete_retention",
    stripeEventId: "evt_re_delete_retention",
    stripeInvoiceId: "in_delete_retention",
    stripeRefundId: "re_delete_retention",
    currency: "usd",
    amount: 100,
    netRevenueDelta: -100,
  }, db);

  await assert.rejects(
    () => db.delete(referralDiscountRedemptions),
  );
});

test("financial_adjustment_kinds_exclude_manual_adjustment", async ({ db }) => {
  await assert.rejects(
    () => db.execute(sql`
      INSERT INTO referral_discount_financial_adjustments
        (environment, livemode, kind, provider_fact_id, stripe_event_id, stripe_invoice_id, currency, amount, net_revenue_delta)
      VALUES
        ('stripe', true, 'manual_adjustment', 'manual-1', 'evt_manual', 'in_manual', 'usd', 1, 0)
    `),
  );
});

test("reservation_void_releases_reserved_slot", async ({ db, seed }) => {
  const fixture = await reserveFixture({ db, seed }, { cap: 1 });
  await voidReferralReservation(fixture.redemption.id, "provider create failed", db);

  const [campaign] = await db.select().from(referralDiscountCampaigns);
  const [redemption] = await db.select().from(referralDiscountRedemptions);
  assert.equal(campaign.liveReservedCount, 0);
  assert.equal(redemption.acquisitionState, "void");
  assert.equal(redemption.capSlotState, "released");
});
