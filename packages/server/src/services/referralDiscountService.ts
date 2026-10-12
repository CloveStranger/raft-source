import { and, eq, or, sql } from "drizzle-orm";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { getDb, type DatabaseExecutor } from "../db/index";
import {
  billingPaidHistoryCoverage,
  billingPaidIdentityEvents,
  billingPaidIdentityResolutions,
  referralDiscountCampaigns,
  referralDiscountCodes,
  referralDiscountFinancialAdjustmentResolutions,
  referralDiscountFinancialAdjustments,
  referralDiscountProviderEvents,
  referralDiscountProviderOperations,
  referralDiscountRedemptions,
} from "../db/schema";

export type ReferralDiscountErrorCode =
  | "paid_history_incomplete"
  | "self_referral"
  | "prior_paid_user"
  | "prior_paid_server"
  | "prior_paid_customer"
  | "campaign_not_redeemable"
  | "code_not_redeemable"
  | "cap_exhausted"
  | "active_claim_exists"
  | "cap_slot_not_held"
  | "campaign_economics_locked"
  | "financial_adjustment_unjoinable"
  | "financial_adjustment_before_qualification"
  | "paid_fact_replay_mismatch"
  | "acquisition_replay_mismatch"
  | "identity_resolution_conflict"
  | "financial_adjustment_resolution_conflict"
  | "provider_operation_replay_mismatch"
  | "provider_event_replay_mismatch"
  | "referral_metadata_mismatch"
  | "referral_scope_mismatch"
  | "invalid_transition"
  | "invalid_reservation_window";

export class ReferralDiscountError extends Error {
  readonly code: ReferralDiscountErrorCode;

  constructor(code: ReferralDiscountErrorCode, message: string) {
    super(message);
    this.name = "ReferralDiscountError";
    this.code = code;
  }
}

export type ReferralEligibilityDecision =
  | { eligible: true }
  | { eligible: false; reason: Exclude<ReferralDiscountErrorCode,
    | "campaign_not_redeemable"
    | "code_not_redeemable"
    | "cap_exhausted"
    | "active_claim_exists"
    | "cap_slot_not_held"
    | "campaign_economics_locked"
    | "financial_adjustment_unjoinable"
    | "financial_adjustment_before_qualification"
    | "paid_fact_replay_mismatch"
    | "acquisition_replay_mismatch"
    | "identity_resolution_conflict"
    | "financial_adjustment_resolution_conflict"
    | "provider_operation_replay_mismatch"
    | "provider_event_replay_mismatch"
    | "referral_metadata_mismatch"
    | "referral_scope_mismatch"
    | "invalid_transition"
    | "invalid_reservation_window"
  > };

export interface PaidHistoryCoverageInput {
  environment: string;
  livemode: boolean;
  coverageOriginAt: Date;
  coverageWatermarkAt: Date;
  completedAt: Date | null;
  source: string;
  auditActor?: string | null;
  auditReason: string;
  unresolvedIdentityCount?: number;
}

export interface NormalizedPaidIdentityFactInput {
  environment: string;
  livemode: boolean;
  stripeEventId: string;
  stripeInvoiceId: string;
  stripeSubscriptionId?: string | null;
  stripeCustomerId?: string | null;
  stripeProductId: string;
  stripePriceId: string;
  serverId?: string | null;
  payerUserId?: string | null;
  ownerUserId?: string | null;
  paidAt: Date;
  currency: string;
  invoiceSubtotal: number;
  invoiceTotal: number;
  amountPaid: number;
  observedAt?: Date;
  source: string;
}

export interface ResolvePaidIdentityFactInput {
  environment: string;
  livemode: boolean;
  stripeEventId: string;
  serverId: string;
  payerUserId: string;
  ownerUserId: string;
  source: string;
  auditActor?: string | null;
  auditReason: string;
}

export interface ReferralEligibilityInput {
  environment: string;
  livemode: boolean;
  historyOriginAt: Date;
  decisionAt: Date;
  referrerUserId?: string | null;
  redeemingUserId: string;
  referredServerId: string;
  stripeCustomerId?: string | null;
}

export interface CreateReferralReservationInput extends ReferralEligibilityInput {
  campaignId: string;
  codeId: string;
  targetProductScope?: "pro";
  targetBillingInterval?: "monthly" | "annual";
  reservationExpiresAt: Date;
  referralCheckoutIdempotencyKey?: string | null;
}

export interface ReferralCodeReservationInput extends ReferralEligibilityInput {
  normalizedCode: string;
  targetProductScope?: "pro";
  targetBillingInterval?: "monthly" | "annual";
  reservationExpiresAt: Date;
  referralCheckoutIdempotencyKey?: string | null;
}

export interface MarkReferralCheckoutCreatedInput {
  decisionAt: Date;
  stripeCheckoutSessionId: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  reservationExpiresAt: Date;
}

export interface MarkReferralCheckoutCompletedInput {
  stripeCheckoutSessionId: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
}

export interface QualifyReferralRedemptionInput {
  firstPaidInvoiceId: string;
  stripeSubscriptionId: string | null;
  stripeCustomerId: string | null;
}

export interface QualifyReferralInvoicePaymentInput extends QualifyReferralRedemptionInput {
  redemptionId: string;
  stripePromotionCodeId: string;
  stripeCouponId: string;
  stripePriceId: string;
  billingInterval: "monthly" | "annual";
  expectedPriceIds: string[];
}

export interface CampaignEconomicsPatch {
  percentOff?: number;
  durationMonths?: number;
  currency?: string;
  productScope?: "pro";
  billingIntervalScope?: "monthly" | "annual" | "both";
  maxPaidRedemptions?: number | null;
  providerStrategy?: string;
  mutationReason: string;
}

export interface FinancialAdjustmentInput {
  redemptionId?: string | null;
  environment: string;
  livemode: boolean;
  kind: "refund" | "credit_note" | "dispute_opened" | "dispute_won" | "dispute_lost";
  providerFactId: string;
  providerFactSequence?: number;
  stripeEventId: string;
  stripeInvoiceId: string;
  stripeRefundId?: string | null;
  stripeCreditNoteId?: string | null;
  stripeDisputeId?: string | null;
  stripeChargeId?: string | null;
  currency: string;
  amount: number;
  netRevenueDelta: number;
  fullEconomicReversal?: boolean;
  observedAt?: Date;
  sanitizedReason?: string | null;
  resolutionSource?: string;
  resolutionAuditActor?: string | null;
  resolutionAuditReason?: string;
}

export interface ProviderOperationInput {
  environment: string;
  livemode: boolean;
  operationType: "campaign_coupon_create" | "code_promotion_create" | "checkout_session_create";
  localTargetId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  requestPayload: Record<string, unknown>;
}

export interface ProviderEventInput {
  environment: string;
  livemode: boolean;
  stripeEventId: string;
  stripeEventType: string;
  providerObjectId?: string | null;
  sourceApiVersion?: string | null;
  payloadHash: string;
  normalizedPayload?: Record<string, unknown>;
  processingState?: "parked" | "applied";
  sanitizedErrorCode?: string | null;
  sanitizedErrorMessage?: string | null;
}

export type ReferralProviderApply = (tx: DatabaseExecutor, event: ProviderEventRow) => Promise<void>;

export interface ReferralCheckoutMetadataInput {
  redemptionId: string;
  codeId: string;
  campaignId: string;
  referrerUserId: string;
  providerStrategy: string;
}

export interface ReferralPreviewInput extends ReferralEligibilityInput {
  normalizedCode: string;
  targetProductScope?: "pro";
  targetBillingInterval?: "monthly" | "annual";
}

export interface ReferralPreviewResult {
  percentOff: number;
  durationMonths: number;
  billingIntervalScope: "monthly" | "annual" | "both";
  expiresAt: Date | null;
}

type CampaignRow = typeof referralDiscountCampaigns.$inferSelect;
type CodeRow = typeof referralDiscountCodes.$inferSelect;
type RedemptionRow = typeof referralDiscountRedemptions.$inferSelect;
type FinancialAdjustmentRow = typeof referralDiscountFinancialAdjustments.$inferSelect;
type PaidIdentityResolutionRow = typeof billingPaidIdentityResolutions.$inferSelect;
type ProviderOperationRow = typeof referralDiscountProviderOperations.$inferSelect;
type ProviderEventRow = typeof referralDiscountProviderEvents.$inferSelect;

export function normalizeReferralCode(code: string): string {
  return code.trim().toLowerCase();
}

export function referralDiagnosticToken(rawCode: string, key = process.env.REFERRAL_DISCOUNT_DIAGNOSTIC_KEY): string {
  if (!key || key.length < 16) {
    throw new Error("REFERRAL_DISCOUNT_DIAGNOSTIC_KEY must be configured before logging referral code diagnostics.");
  }
  return createHmac("sha256", key).update(normalizeReferralCode(rawCode)).digest("base64url");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

export function fingerprintReferralProviderRequest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function hashReferralProviderPayload(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function buildReferralCheckoutMetadata(input: ReferralCheckoutMetadataInput): Record<string, string> {
  return {
    referralRedemptionId: input.redemptionId,
    referralCodeId: input.codeId,
    referralCampaignId: input.campaignId,
    referralReferrerUserId: input.referrerUserId,
    referralProviderStrategy: input.providerStrategy,
  };
}

function assertNonempty(value: string, label: string) {
  if (!value.trim()) throw new Error(`${label} must be non-empty`);
}

function assertResolvedFact(input: NormalizedPaidIdentityFactInput): "resolved" | "parked" {
  return input.serverId && input.payerUserId && input.ownerUserId ? "resolved" : "parked";
}

function sameOptionalString(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

function sameInstant(a: Date | string, b: Date): boolean {
  return new Date(a).getTime() === b.getTime();
}

function assertHasCanonicalField(input: object, field: string) {
  if (!Object.prototype.hasOwnProperty.call(input, field) || (input as Record<string, unknown>)[field] === undefined) {
    throw new ReferralDiscountError("acquisition_replay_mismatch", `Canonical acquisition field ${field} is required.`);
  }
}

function assertCanonicalCreatedInput(input: MarkReferralCheckoutCreatedInput) {
  assertHasCanonicalField(input, "decisionAt");
  assertHasCanonicalField(input, "stripeCustomerId");
  assertHasCanonicalField(input, "stripeSubscriptionId");
  assertHasCanonicalField(input, "reservationExpiresAt");
}

function assertCanonicalCompletedInput(input: MarkReferralCheckoutCompletedInput) {
  assertHasCanonicalField(input, "stripeCheckoutSessionId");
  assertHasCanonicalField(input, "stripeCustomerId");
  assertHasCanonicalField(input, "stripeSubscriptionId");
}

function assertCanonicalQualifiedInput(input: QualifyReferralRedemptionInput) {
  assertHasCanonicalField(input, "stripeSubscriptionId");
  assertHasCanonicalField(input, "stripeCustomerId");
}

function assertSamePaidFactReplay(row: typeof billingPaidIdentityEvents.$inferSelect, input: NormalizedPaidIdentityFactInput) {
  const mismatch = [
    row.environment !== input.environment,
    row.livemode !== input.livemode,
    row.stripeEventId !== input.stripeEventId,
    row.stripeInvoiceId !== input.stripeInvoiceId,
    !sameOptionalString(row.stripeSubscriptionId, input.stripeSubscriptionId),
    !sameOptionalString(row.stripeCustomerId, input.stripeCustomerId),
    row.stripeProductId !== input.stripeProductId,
    row.stripePriceId !== input.stripePriceId,
    !sameOptionalString(row.serverId, input.serverId),
    !sameOptionalString(row.payerUserId, input.payerUserId),
    !sameOptionalString(row.ownerUserId, input.ownerUserId),
    row.identityResolutionState !== assertResolvedFact(input),
    !sameInstant(row.paidAt, input.paidAt),
    row.currency !== input.currency.toLowerCase(),
    row.invoiceSubtotal !== input.invoiceSubtotal,
    row.invoiceTotal !== input.invoiceTotal,
    row.amountPaid !== input.amountPaid,
  ].some(Boolean);
  if (mismatch) {
    throw new ReferralDiscountError("paid_fact_replay_mismatch", "Paid identity fact replay does not match the canonical payload.");
  }
}

function assertSameFinancialAdjustmentReplay(row: FinancialAdjustmentRow, input: FinancialAdjustmentInput) {
  const mismatch = [
    row.environment !== input.environment,
    row.livemode !== input.livemode,
    row.kind !== input.kind,
    row.providerFactId !== input.providerFactId,
    row.providerFactSequence !== (input.providerFactSequence ?? 0),
    row.stripeEventId !== input.stripeEventId,
    row.stripeInvoiceId !== input.stripeInvoiceId,
    !sameOptionalString(row.stripeRefundId, input.stripeRefundId),
    !sameOptionalString(row.stripeCreditNoteId, input.stripeCreditNoteId),
    !sameOptionalString(row.stripeDisputeId, input.stripeDisputeId),
    !sameOptionalString(row.stripeChargeId, input.stripeChargeId),
    row.currency !== input.currency.toLowerCase(),
    row.amount !== input.amount,
    row.netRevenueDelta !== input.netRevenueDelta,
    row.fullEconomicReversal !== (input.fullEconomicReversal ?? false),
  ].some(Boolean);
  if (mismatch) {
    throw new ReferralDiscountError("financial_adjustment_unjoinable", "Referral financial adjustment replay does not match the canonical provider fact.");
  }
}

function assertSameProviderOperationReplay(row: ProviderOperationRow, input: ProviderOperationInput) {
  const mismatch = [
    row.environment !== input.environment,
    row.livemode !== input.livemode,
    row.operationType !== input.operationType,
    row.localTargetId !== input.localTargetId,
    row.idempotencyKey !== input.idempotencyKey,
    row.requestFingerprint !== input.requestFingerprint,
    stableJson(row.requestPayload) !== stableJson(input.requestPayload),
  ].some(Boolean);
  if (mismatch) {
    throw new ReferralDiscountError("provider_operation_replay_mismatch", "Referral provider operation replay does not match the canonical request.");
  }
}

function assertSameProviderOperationTerminal(
  row: ProviderOperationRow,
  fields: { providerObjectId: string; providerRequestId?: string | null },
) {
  const mismatch = [
    row.providerObjectId !== fields.providerObjectId,
    !sameOptionalString(row.providerRequestId, fields.providerRequestId),
  ].some(Boolean);
  if (mismatch) {
    throw new ReferralDiscountError("provider_operation_replay_mismatch", "Referral provider operation terminal replay does not match the canonical provider object.");
  }
}

function assertSameProviderEventReplay(row: ProviderEventRow, input: ProviderEventInput) {
  const mismatch = [
    row.environment !== input.environment,
    row.livemode !== input.livemode,
    row.stripeEventId !== input.stripeEventId,
    row.stripeEventType !== input.stripeEventType,
    !sameOptionalString(row.providerObjectId, input.providerObjectId),
    !sameOptionalString(row.sourceApiVersion, input.sourceApiVersion),
    row.payloadHash !== input.payloadHash,
  ].some(Boolean);
  if (mismatch) {
    throw new ReferralDiscountError("provider_event_replay_mismatch", "Referral provider event replay does not match the canonical payload.");
  }
}

const SAFE_PROVIDER_ERROR_CODES = new Set([
  "provider_retrieve_failed",
  "provider_shape_mismatch",
  "provider_live_mode",
  "provider_metadata_mismatch",
  "provider_lineage_mismatch",
  "provider_discount_mismatch",
  "provider_operation_ambiguous",
  "provider_operation_terminal",
  "provider_preinvoke_failed",
  "provider_unavailable",
]);

function normalizeProductScope(scope: "pro" | undefined): "pro" {
  return scope ?? "pro";
}

function normalizeBillingInterval(interval: "monthly" | "annual" | undefined): "monthly" | "annual" {
  return interval ?? "monthly";
}

function campaignSupportsFrozenScope(
  campaign: CampaignRow,
  productScope: "pro",
  billingInterval: "monthly" | "annual",
): boolean {
  return campaign.productScope === productScope
    && (campaign.billingIntervalScope === "both" || campaign.billingIntervalScope === billingInterval);
}

function sanitizeProviderError(error: { code: string; message?: string | null }): { code: string; message: string } {
  const code = SAFE_PROVIDER_ERROR_CODES.has(error.code) ? error.code : "provider_unavailable";
  const message = (error.message ?? code)
    .replace(/sk_(test|live)_[A-Za-z0-9_]+/g, "[redacted-stripe-key]")
    .replace(/[A-Za-z0-9][A-Za-z0-9_-]{5,}/g, (token) => {
      if (/^(cs|sub|cus|in|evt|pi|ch|re|cn|du|promo|coupon|price|prod)_/.test(token)) return token;
      return token.length > 24 ? "[redacted-token]" : token;
    })
    .slice(0, 240);
  return { code, message };
}

function metadataValue(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function assertReferralCheckoutMetadataPair(
  sessionMetadata: Record<string, unknown> | null | undefined,
  subscriptionMetadata: Record<string, unknown> | null | undefined,
) {
  const required = [
    "referralRedemptionId",
    "referralCodeId",
    "referralCampaignId",
    "referralReferrerUserId",
    "referralProviderStrategy",
  ];
  const tuple: Record<string, string> = {};
  for (const key of required) {
    const sessionValue = metadataValue(sessionMetadata, key);
    const subscriptionValue = metadataValue(subscriptionMetadata, key);
    if (!sessionValue || !subscriptionValue || sessionValue !== subscriptionValue) {
      throw new ReferralDiscountError("referral_metadata_mismatch", "Referral checkout metadata is missing or inconsistent between session and subscription.");
    }
    tuple[key] = sessionValue;
  }
  return {
    redemptionId: tuple.referralRedemptionId,
    codeId: tuple.referralCodeId,
    campaignId: tuple.referralCampaignId,
    referrerUserId: tuple.referralReferrerUserId,
    providerStrategy: tuple.referralProviderStrategy,
  };
}

async function refreshPaidHistoryCoverageUnresolvedCount(
  tx: DatabaseExecutor,
  input: { environment: string; livemode: boolean },
) {
  await tx.execute(sql`
    UPDATE billing_paid_history_coverage coverage
       SET unresolved_identity_count = (
         SELECT count(*)::int
           FROM billing_paid_identity_events event
          WHERE event.environment = coverage.environment
            AND event.livemode = coverage.livemode
            AND event.identity_resolution_state = 'parked'
            AND event.paid_at >= coverage.coverage_origin_at
            AND event.paid_at <= coverage.coverage_watermark_at
            AND NOT EXISTS (
              SELECT 1
                FROM billing_paid_identity_resolutions resolution
               WHERE resolution.paid_identity_event_id = event.id
            )
       ),
       updated_at = now()
     WHERE coverage.environment = ${input.environment}
       AND coverage.livemode = ${input.livemode}
  `);
}

async function txFor<T>(executor: DatabaseExecutor, fn: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
  return executor.transaction((tx) => fn(tx));
}

export async function upsertPaidHistoryCoverage(
  input: PaidHistoryCoverageInput,
  executor: DatabaseExecutor = getDb(),
) {
  return txFor(executor, async (tx) => {
    const [existing] = await tx.select().from(billingPaidHistoryCoverage)
      .where(and(
        eq(billingPaidHistoryCoverage.environment, input.environment),
        eq(billingPaidHistoryCoverage.livemode, input.livemode),
      ))
      .for("update")
      .limit(1);
    const coverageOriginAt = existing && existing.coverageOriginAt < input.coverageOriginAt ? existing.coverageOriginAt : input.coverageOriginAt;
    const coverageWatermarkAt = existing && existing.coverageWatermarkAt > input.coverageWatermarkAt ? existing.coverageWatermarkAt : input.coverageWatermarkAt;
    const completedAt = input.completedAt && input.completedAt >= coverageWatermarkAt ? input.completedAt : existing?.completedAt ?? null;

    const unresolvedRows = await tx.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count
        FROM billing_paid_identity_events
       WHERE environment = ${input.environment}
         AND livemode = ${input.livemode}
         AND identity_resolution_state = 'parked'
         AND paid_at >= ${coverageOriginAt}
         AND paid_at <= ${coverageWatermarkAt}
         AND NOT EXISTS (
           SELECT 1
             FROM billing_paid_identity_resolutions resolution
            WHERE resolution.paid_identity_event_id = billing_paid_identity_events.id
         )
    `);
    const unresolvedIdentityCount = Number(unresolvedRows.rows[0]?.count ?? 0);

    const [row] = await tx.insert(billingPaidHistoryCoverage).values({
      environment: input.environment,
      livemode: input.livemode,
      coverageOriginAt,
      coverageWatermarkAt,
      completedAt,
      source: input.source,
      auditActor: input.auditActor ?? null,
      auditReason: input.auditReason,
      unresolvedIdentityCount,
    }).onConflictDoUpdate({
      target: [billingPaidHistoryCoverage.environment, billingPaidHistoryCoverage.livemode],
      set: {
        coverageOriginAt,
        coverageWatermarkAt,
        completedAt,
        source: input.source,
        auditActor: input.auditActor ?? null,
        auditReason: input.auditReason,
        unresolvedIdentityCount,
        updatedAt: new Date(),
      },
    }).returning();
    return row;
  });
}

export async function ingestNormalizedPaidIdentityFact(
  input: NormalizedPaidIdentityFactInput,
  executor: DatabaseExecutor = getDb(),
) {
  assertNonempty(input.stripeEventId, "stripeEventId");
  assertNonempty(input.stripeInvoiceId, "stripeInvoiceId");
  assertNonempty(input.stripeProductId, "stripeProductId");
  assertNonempty(input.stripePriceId, "stripePriceId");

  return txFor(executor, async (tx) => {
    const state = assertResolvedFact(input);
    const [inserted] = await tx.insert(billingPaidIdentityEvents).values({
      environment: input.environment,
      livemode: input.livemode,
      stripeEventId: input.stripeEventId,
      stripeInvoiceId: input.stripeInvoiceId,
      stripeSubscriptionId: input.stripeSubscriptionId ?? null,
      stripeCustomerId: input.stripeCustomerId ?? null,
      paidFactKind: "pro_invoice_paid",
      stripeProductId: input.stripeProductId,
      stripePriceId: input.stripePriceId,
      serverId: input.serverId ?? null,
      payerUserId: input.payerUserId ?? null,
      ownerUserId: input.ownerUserId ?? null,
      identityResolutionState: state,
      paidAt: input.paidAt,
      currency: input.currency.toLowerCase(),
      invoiceSubtotal: input.invoiceSubtotal,
      invoiceTotal: input.invoiceTotal,
      amountPaid: input.amountPaid,
      observedAt: input.observedAt ?? new Date(),
      source: input.source,
    }).onConflictDoNothing({
      target: [billingPaidIdentityEvents.environment, billingPaidIdentityEvents.livemode, billingPaidIdentityEvents.stripeEventId],
    }).returning();

    const [row] = inserted
      ? [inserted]
      : await tx.select().from(billingPaidIdentityEvents)
        .where(and(
          eq(billingPaidIdentityEvents.environment, input.environment),
          eq(billingPaidIdentityEvents.livemode, input.livemode),
          eq(billingPaidIdentityEvents.stripeEventId, input.stripeEventId),
        ))
        .limit(1);
    if (!inserted) {
      assertSamePaidFactReplay(row, input);
    }

    if (inserted && state === "parked") {
      await refreshPaidHistoryCoverageUnresolvedCount(tx, input);
    }
    return row;
  });
}

function assertSamePaidResolutionReplay(row: PaidIdentityResolutionRow, input: ResolvePaidIdentityFactInput) {
  const mismatch = [
    row.serverId !== input.serverId,
    row.payerUserId !== input.payerUserId,
    row.ownerUserId !== input.ownerUserId,
  ].some(Boolean);
  if (mismatch) {
    throw new ReferralDiscountError("identity_resolution_conflict", "Paid identity resolver conflicts with the canonical resolution.");
  }
}

export async function resolvePaidIdentityFact(
  input: ResolvePaidIdentityFactInput,
  executor: DatabaseExecutor = getDb(),
): Promise<PaidIdentityResolutionRow | null> {
  assertNonempty(input.stripeEventId, "stripeEventId");
  return txFor(executor, async (tx) => {
    const [event] = await tx.select().from(billingPaidIdentityEvents)
      .where(and(
        eq(billingPaidIdentityEvents.environment, input.environment),
        eq(billingPaidIdentityEvents.livemode, input.livemode),
        eq(billingPaidIdentityEvents.stripeEventId, input.stripeEventId),
      ))
      .for("update")
      .limit(1);
    if (!event) throw new Error(`Paid identity fact not found: ${input.stripeEventId}`);
    if (event.identityResolutionState === "resolved") {
      const mismatch = [
        event.serverId !== input.serverId,
        event.payerUserId !== input.payerUserId,
        event.ownerUserId !== input.ownerUserId,
      ].some(Boolean);
      if (mismatch) {
        throw new ReferralDiscountError("identity_resolution_conflict", "Resolved paid identity fact conflicts with resolver.");
      }
      return null;
    }

    const [existing] = await tx.select().from(billingPaidIdentityResolutions)
      .where(eq(billingPaidIdentityResolutions.paidIdentityEventId, event.id))
      .for("update")
      .limit(1);
    if (existing) {
      assertSamePaidResolutionReplay(existing, input);
      return existing;
    }

    const [resolution] = await tx.insert(billingPaidIdentityResolutions).values({
      paidIdentityEventId: event.id,
      serverId: input.serverId,
      payerUserId: input.payerUserId,
      ownerUserId: input.ownerUserId,
      source: input.source,
      auditActor: input.auditActor ?? null,
      auditReason: input.auditReason,
    }).returning();
    await refreshPaidHistoryCoverageUnresolvedCount(tx, input);
    return resolution;
  });
}

export async function evaluateReferralEligibility(
  input: ReferralEligibilityInput,
  executor: DatabaseExecutor = getDb(),
): Promise<ReferralEligibilityDecision> {
  return txFor(executor, async (tx) => {
    if (input.referrerUserId && input.referrerUserId === input.redeemingUserId) {
      return { eligible: false, reason: "self_referral" };
    }

    const coverageRows = await tx.execute(sql`
      SELECT environment
        FROM billing_paid_history_coverage
       WHERE environment = ${input.environment}
         AND livemode = ${input.livemode}
         AND completed_at IS NOT NULL
         AND coverage_origin_at <= ${input.historyOriginAt}
         AND coverage_watermark_at >= ${input.decisionAt}
         AND unresolved_identity_count = 0
       FOR UPDATE
    `);
    if (coverageRows.rows.length !== 1) {
      return { eligible: false, reason: "paid_history_incomplete" };
    }

    const priorUser = await tx.execute(sql`
      SELECT event.id
        FROM billing_paid_identity_events event
        LEFT JOIN billing_paid_identity_resolutions resolution
          ON resolution.paid_identity_event_id = event.id
       WHERE event.environment = ${input.environment}
         AND event.livemode = ${input.livemode}
         AND event.paid_fact_kind = 'pro_invoice_paid'
         AND (event.identity_resolution_state = 'resolved' OR resolution.id IS NOT NULL)
         AND (
           COALESCE(event.payer_user_id, resolution.payer_user_id) = ${input.redeemingUserId}
           OR COALESCE(event.owner_user_id, resolution.owner_user_id) = ${input.redeemingUserId}
         )
       LIMIT 1
    `);
    if (priorUser.rows.length > 0) return { eligible: false, reason: "prior_paid_user" };

    const priorServer = await tx.execute(sql`
      SELECT event.id
        FROM billing_paid_identity_events event
        LEFT JOIN billing_paid_identity_resolutions resolution
          ON resolution.paid_identity_event_id = event.id
       WHERE event.environment = ${input.environment}
         AND event.livemode = ${input.livemode}
         AND event.paid_fact_kind = 'pro_invoice_paid'
         AND (event.identity_resolution_state = 'resolved' OR resolution.id IS NOT NULL)
         AND COALESCE(event.server_id, resolution.server_id) = ${input.referredServerId}
       LIMIT 1
    `);
    if (priorServer.rows.length > 0) return { eligible: false, reason: "prior_paid_server" };

    if (input.stripeCustomerId) {
      const priorCustomer = await tx.execute(sql`
        SELECT event.id
          FROM billing_paid_identity_events event
          LEFT JOIN billing_paid_identity_resolutions resolution
            ON resolution.paid_identity_event_id = event.id
         WHERE event.environment = ${input.environment}
           AND event.livemode = ${input.livemode}
           AND event.paid_fact_kind = 'pro_invoice_paid'
           AND (event.identity_resolution_state = 'resolved' OR resolution.id IS NOT NULL)
           AND event.stripe_customer_id = ${input.stripeCustomerId}
         LIMIT 1
      `);
      if (priorCustomer.rows.length > 0) return { eligible: false, reason: "prior_paid_customer" };
    }

    return { eligible: true };
  });
}

async function readCampaignForUpdate(tx: DatabaseExecutor, campaignId: string): Promise<CampaignRow | null> {
  const [row] = await tx.select().from(referralDiscountCampaigns)
    .where(eq(referralDiscountCampaigns.id, campaignId))
    .for("update")
    .limit(1);
  return row ?? null;
}

async function readCodeForUpdate(tx: DatabaseExecutor, codeId: string): Promise<CodeRow | null> {
  const [row] = await tx.select().from(referralDiscountCodes)
    .where(eq(referralDiscountCodes.id, codeId))
    .for("update")
    .limit(1);
  return row ?? null;
}

function hasCapacity(row: { maxPaidRedemptions: number | null; liveReservedCount: number; qualifiedCount: number }) {
  return row.maxPaidRedemptions === null || row.liveReservedCount + row.qualifiedCount < row.maxPaidRedemptions;
}

function mapUniqueClaimError(error: unknown): never {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
  if (code === "23505") {
    throw new ReferralDiscountError("active_claim_exists", "A referral redemption claim already exists for this buyer identity.");
  }
  throw error;
}

export async function createReferralReservation(
  input: CreateReferralReservationInput,
  executor: DatabaseExecutor = getDb(),
): Promise<RedemptionRow> {
  return txFor(executor, async (tx) => {
    const targetProductScope = normalizeProductScope(input.targetProductScope);
    const targetBillingInterval = normalizeBillingInterval(input.targetBillingInterval);
    if (input.reservationExpiresAt <= input.decisionAt) {
      throw new ReferralDiscountError("invalid_reservation_window", "Referral reservation expiry must be in the future.");
    }
    const eligibility = await evaluateReferralEligibility(input, tx);
    if (!eligibility.eligible) {
      throw new ReferralDiscountError(eligibility.reason, `Referral eligibility denied: ${eligibility.reason}`);
    }

    const campaign = await readCampaignForUpdate(tx, input.campaignId);
    const campaignInWindow = campaign
      && (campaign.startsAt === null || campaign.startsAt <= input.decisionAt)
      && (campaign.expiresAt === null || campaign.expiresAt > input.decisionAt);
    if (!campaign || campaign.status !== "active" || campaign.providerState !== "ready" || !campaignInWindow || !hasCapacity(campaign)) {
      throw new ReferralDiscountError(
        campaign && !hasCapacity(campaign) ? "cap_exhausted" : "campaign_not_redeemable",
        "Referral campaign is not redeemable.",
      );
    }
    if (!campaignSupportsFrozenScope(campaign, targetProductScope, targetBillingInterval)) {
      throw new ReferralDiscountError("referral_scope_mismatch", "Referral campaign does not apply to the requested product and billing interval.");
    }
    const code = await readCodeForUpdate(tx, input.codeId);
    if (
      !code
      || code.campaignId !== campaign.id
      || code.referrerUserId !== input.referrerUserId
      || code.status !== "active"
      || code.providerState !== "ready"
      || (code.expiresAt !== null && code.expiresAt <= input.decisionAt)
      || !hasCapacity(code)
    ) {
      throw new ReferralDiscountError(code && !hasCapacity(code) ? "cap_exhausted" : "code_not_redeemable", "Referral code is not redeemable.");
    }

    await tx.update(referralDiscountCampaigns).set({
      liveReservedCount: sql`${referralDiscountCampaigns.liveReservedCount} + 1`,
      updatedAt: new Date(),
    }).where(eq(referralDiscountCampaigns.id, campaign.id));
    await tx.update(referralDiscountCodes).set({
      liveReservedCount: sql`${referralDiscountCodes.liveReservedCount} + 1`,
      updatedAt: new Date(),
    }).where(eq(referralDiscountCodes.id, code.id));

    try {
      const [redemption] = await tx.insert(referralDiscountRedemptions).values({
        campaignId: campaign.id,
        codeId: code.id,
        referrerUserId: code.referrerUserId,
        referredServerId: input.referredServerId,
        redeemingUserId: input.redeemingUserId,
        stripeCustomerId: input.stripeCustomerId ?? null,
        targetProductScope,
        targetBillingInterval,
        reservationExpiresAt: input.reservationExpiresAt,
        referralCheckoutIdempotencyKey: input.referralCheckoutIdempotencyKey ?? `referral-checkout:${randomUUID()}`,
      }).returning();
      return redemption;
    } catch (error) {
      mapUniqueClaimError(error);
    }
  });
}

export async function createReferralReservationForCode(
  input: ReferralCodeReservationInput,
  executor: DatabaseExecutor = getDb(),
): Promise<RedemptionRow & { code: CodeRow; campaign: CampaignRow }> {
  return txFor(executor, async (tx) => {
    const [code] = await tx.select().from(referralDiscountCodes)
      .where(eq(referralDiscountCodes.normalizedCode, input.normalizedCode))
      .for("update")
      .limit(1);
    if (!code) {
      throw new ReferralDiscountError("code_not_redeemable", "Referral code is not redeemable.");
    }
    const campaign = await readCampaignForUpdate(tx, code.campaignId);
    if (!campaign) {
      throw new ReferralDiscountError("campaign_not_redeemable", "Referral campaign is not redeemable.");
    }
    const redemption = await createReferralReservation({
      environment: input.environment,
      livemode: input.livemode,
      historyOriginAt: input.historyOriginAt,
      decisionAt: input.decisionAt,
      campaignId: campaign.id,
      codeId: code.id,
      referrerUserId: code.referrerUserId,
      redeemingUserId: input.redeemingUserId,
      referredServerId: input.referredServerId,
      stripeCustomerId: input.stripeCustomerId ?? null,
      targetProductScope: input.targetProductScope,
      targetBillingInterval: input.targetBillingInterval,
      reservationExpiresAt: input.reservationExpiresAt,
      referralCheckoutIdempotencyKey: input.referralCheckoutIdempotencyKey ?? null,
    }, tx);
    return { ...redemption, code, campaign };
  });
}

export async function readActiveReferralReservationForCode(
  input: ReferralCodeReservationInput,
  executor: DatabaseExecutor = getDb(),
): Promise<(RedemptionRow & { code: CodeRow; campaign: CampaignRow }) | null> {
  const targetProductScope = normalizeProductScope(input.targetProductScope);
  const targetBillingInterval = normalizeBillingInterval(input.targetBillingInterval);
  return txFor(executor, async (tx) => {
    const [row] = await tx.select({
      redemption: referralDiscountRedemptions,
      code: referralDiscountCodes,
      campaign: referralDiscountCampaigns,
    })
      .from(referralDiscountRedemptions)
      .innerJoin(referralDiscountCodes, eq(referralDiscountCodes.id, referralDiscountRedemptions.codeId))
      .innerJoin(referralDiscountCampaigns, eq(referralDiscountCampaigns.id, referralDiscountRedemptions.campaignId))
      .where(and(
        eq(referralDiscountCodes.normalizedCode, input.normalizedCode),
        eq(referralDiscountRedemptions.redeemingUserId, input.redeemingUserId),
        eq(referralDiscountRedemptions.referredServerId, input.referredServerId),
        eq(referralDiscountRedemptions.targetProductScope, targetProductScope),
        eq(referralDiscountRedemptions.targetBillingInterval, targetBillingInterval),
        sql`${referralDiscountRedemptions.acquisitionState} IN ('reserved', 'checkout_created', 'checkout_completed')`,
      ))
      .for("update")
      .limit(1);
    if (!row) return null;
    if (row.redemption.stripeCustomerId !== null && input.stripeCustomerId !== null && row.redemption.stripeCustomerId !== input.stripeCustomerId) {
      throw new ReferralDiscountError("acquisition_replay_mismatch", "Existing referral reservation has a different Stripe customer identity.");
    }
    if (row.redemption.reservationExpiresAt <= input.decisionAt) {
      if (row.redemption.acquisitionState === "reserved") {
        await transitionHeldReservation(row.redemption.id, "void", tx, { internalReason: "reservation_expired_before_resume" });
        return null;
      }
      if (row.redemption.acquisitionState === "checkout_created") {
        await transitionHeldReservation(row.redemption.id, "checkout_expired", tx);
        return null;
      }
      throw new ReferralDiscountError("invalid_reservation_window", "Existing referral reservation is expired and cannot be resumed.");
    }
    if (!campaignSupportsFrozenScope(row.campaign, targetProductScope, targetBillingInterval)) {
      throw new ReferralDiscountError("referral_scope_mismatch", "Existing referral reservation scope no longer matches campaign scope.");
    }
    return { ...row.redemption, code: row.code, campaign: row.campaign };
  });
}

export async function previewReferralCode(
  input: ReferralPreviewInput,
  executor: DatabaseExecutor = getDb(),
): Promise<ReferralPreviewResult> {
  return txFor(executor, async (tx) => {
    const targetProductScope = normalizeProductScope(input.targetProductScope);
    const targetBillingInterval = normalizeBillingInterval(input.targetBillingInterval);
    const [code] = await tx.select().from(referralDiscountCodes)
      .where(eq(referralDiscountCodes.normalizedCode, input.normalizedCode))
      .limit(1);
    if (!code) throw new ReferralDiscountError("code_not_redeemable", "Referral code is not redeemable.");
    const [campaign] = await tx.select().from(referralDiscountCampaigns)
      .where(eq(referralDiscountCampaigns.id, code.campaignId))
      .limit(1);
    const campaignInWindow = campaign
      && (campaign.startsAt === null || campaign.startsAt <= input.decisionAt)
      && (campaign.expiresAt === null || campaign.expiresAt > input.decisionAt);
    if (
      !campaign
      || campaign.status !== "active"
      || campaign.providerState !== "ready"
      || !campaignSupportsFrozenScope(campaign, targetProductScope, targetBillingInterval)
      || !campaignInWindow
      || code.status !== "active"
      || code.providerState !== "ready"
      || (code.expiresAt !== null && code.expiresAt <= input.decisionAt)
    ) {
      throw new ReferralDiscountError("code_not_redeemable", "Referral code is not redeemable.");
    }
    const eligibility = await evaluateReferralEligibility({
      environment: input.environment,
      livemode: input.livemode,
      historyOriginAt: input.historyOriginAt,
      decisionAt: input.decisionAt,
      referrerUserId: code.referrerUserId,
      redeemingUserId: input.redeemingUserId,
      referredServerId: input.referredServerId,
      stripeCustomerId: input.stripeCustomerId ?? null,
    }, tx);
    if (!eligibility.eligible) {
      throw new ReferralDiscountError(eligibility.reason, `Referral eligibility denied: ${eligibility.reason}`);
    }
    return {
      percentOff: campaign.percentOff,
      durationMonths: campaign.durationMonths,
      billingIntervalScope: campaign.billingIntervalScope,
      expiresAt: code.expiresAt ?? campaign.expiresAt ?? null,
    };
  });
}

export async function beginReferralProviderOperation(
  input: ProviderOperationInput,
  executor: DatabaseExecutor = getDb(),
): Promise<ProviderOperationRow> {
  assertNonempty(input.idempotencyKey, "idempotencyKey");
  assertNonempty(input.requestFingerprint, "requestFingerprint");
  return txFor(executor, async (tx) => {
    const [inserted] = await tx.insert(referralDiscountProviderOperations).values({
      environment: input.environment,
      livemode: input.livemode,
      operationType: input.operationType,
      localTargetId: input.localTargetId,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      requestPayload: input.requestPayload,
      state: "intent",
    }).onConflictDoNothing({
      target: [
        referralDiscountProviderOperations.environment,
        referralDiscountProviderOperations.livemode,
        referralDiscountProviderOperations.operationType,
        referralDiscountProviderOperations.localTargetId,
      ],
    }).returning();
    const [row] = inserted
      ? [inserted]
      : await tx.select().from(referralDiscountProviderOperations)
        .where(and(
          eq(referralDiscountProviderOperations.environment, input.environment),
          eq(referralDiscountProviderOperations.livemode, input.livemode),
          eq(referralDiscountProviderOperations.operationType, input.operationType),
          eq(referralDiscountProviderOperations.localTargetId, input.localTargetId),
        ))
        .for("update")
        .limit(1);
    assertSameProviderOperationReplay(row, input);
    return row;
  });
}

export async function markReferralProviderOperationStarted(
  operationId: string,
  fields: { providerRequestId?: string | null } = {},
  executor: DatabaseExecutor = getDb(),
): Promise<ProviderOperationRow> {
  const [current] = await executor.select().from(referralDiscountProviderOperations)
    .where(eq(referralDiscountProviderOperations.id, operationId))
    .limit(1);
  if (!current) throw new Error(`Referral provider operation not found: ${operationId}`);
  if (current.state === "confirmed") return current;
  const [row] = await executor.update(referralDiscountProviderOperations).set({
    state: "provider_started",
    providerRequestId: fields.providerRequestId ?? current.providerRequestId ?? null,
    attemptCount: sql`${referralDiscountProviderOperations.attemptCount} + 1`,
    updatedAt: new Date(),
  }).where(and(
    eq(referralDiscountProviderOperations.id, operationId),
    or(
      eq(referralDiscountProviderOperations.state, "intent"),
      eq(referralDiscountProviderOperations.state, "provider_started"),
      eq(referralDiscountProviderOperations.state, "parked"),
    ),
  )).returning();
  if (!row) {
    throw new ReferralDiscountError("provider_operation_replay_mismatch", "Referral provider operation cannot be restarted from its current state.");
  }
  return row;
}

export async function confirmReferralProviderOperation(
  operationId: string,
  fields: { providerObjectId: string; providerRequestId?: string | null },
  executor: DatabaseExecutor = getDb(),
): Promise<ProviderOperationRow> {
  assertNonempty(fields.providerObjectId, "providerObjectId");
  const [current] = await executor.select().from(referralDiscountProviderOperations)
    .where(eq(referralDiscountProviderOperations.id, operationId))
    .limit(1);
  if (!current) throw new Error(`Referral provider operation not found: ${operationId}`);
  if (current.state === "confirmed") {
    assertSameProviderOperationTerminal(current, fields);
    return current;
  }
  const [row] = await executor.update(referralDiscountProviderOperations).set({
    state: "confirmed",
    providerObjectId: fields.providerObjectId,
    providerRequestId: fields.providerRequestId ?? undefined,
    sanitizedErrorCode: null,
    sanitizedErrorMessage: null,
    updatedAt: new Date(),
  }).where(and(
    eq(referralDiscountProviderOperations.id, operationId),
    or(
      eq(referralDiscountProviderOperations.state, "provider_started"),
      eq(referralDiscountProviderOperations.state, "parked"),
    ),
  )).returning();
  if (!row) {
    throw new ReferralDiscountError("provider_operation_replay_mismatch", "Referral provider operation cannot be confirmed from its current state.");
  }
  return row;
}

export async function parkReferralProviderOperation(
  operationId: string,
  error: { code: string; message: string },
  executor: DatabaseExecutor = getDb(),
): Promise<ProviderOperationRow> {
  const [current] = await executor.select().from(referralDiscountProviderOperations)
    .where(eq(referralDiscountProviderOperations.id, operationId))
    .limit(1);
  if (!current) throw new Error(`Referral provider operation not found: ${operationId}`);
  if (current.state === "confirmed") {
    throw new ReferralDiscountError("provider_operation_replay_mismatch", "Confirmed referral provider operation cannot be parked.");
  }
  const sanitized = sanitizeProviderError(error);
  const [row] = await executor.update(referralDiscountProviderOperations).set({
    state: "parked",
    sanitizedErrorCode: sanitized.code,
    sanitizedErrorMessage: sanitized.message,
    updatedAt: new Date(),
  }).where(and(
    eq(referralDiscountProviderOperations.id, operationId),
    or(
      eq(referralDiscountProviderOperations.state, "intent"),
      eq(referralDiscountProviderOperations.state, "provider_started"),
      eq(referralDiscountProviderOperations.state, "parked"),
    ),
  )).returning();
  if (!row) {
    throw new ReferralDiscountError("provider_operation_replay_mismatch", "Referral provider operation cannot be parked from its current state.");
  }
  return row;
}

export async function ingestReferralProviderEvent(
  input: ProviderEventInput,
  executor: DatabaseExecutor = getDb(),
): Promise<ProviderEventRow> {
  assertNonempty(input.stripeEventId, "stripeEventId");
  assertNonempty(input.stripeEventType, "stripeEventType");
  assertNonempty(input.payloadHash, "payloadHash");
  return txFor(executor, async (tx) => {
    const [inserted] = await tx.insert(referralDiscountProviderEvents).values({
      environment: input.environment,
      livemode: input.livemode,
      stripeEventId: input.stripeEventId,
      stripeEventType: input.stripeEventType,
      providerObjectId: input.providerObjectId ?? null,
      sourceApiVersion: input.sourceApiVersion ?? null,
      payloadHash: input.payloadHash,
      normalizedPayload: input.normalizedPayload ?? {},
      processingState: input.processingState ?? "parked",
      sanitizedErrorCode: input.sanitizedErrorCode ?? null,
      sanitizedErrorMessage: input.sanitizedErrorMessage ? sanitizeProviderError({
        code: input.sanitizedErrorCode ?? "provider_unavailable",
        message: input.sanitizedErrorMessage,
      }).message : null,
    }).onConflictDoNothing({
      target: [
        referralDiscountProviderEvents.environment,
        referralDiscountProviderEvents.livemode,
        referralDiscountProviderEvents.stripeEventId,
      ],
    }).returning();
    const [row] = inserted
      ? [inserted]
      : await tx.select().from(referralDiscountProviderEvents)
        .where(and(
          eq(referralDiscountProviderEvents.environment, input.environment),
          eq(referralDiscountProviderEvents.livemode, input.livemode),
          eq(referralDiscountProviderEvents.stripeEventId, input.stripeEventId),
        ))
        .limit(1);
    if (!inserted) assertSameProviderEventReplay(row, input);
    return row;
  });
}

export async function applyReferralProviderEvent(
  input: ProviderEventInput,
  apply: ReferralProviderApply,
  executor: DatabaseExecutor = getDb(),
): Promise<ProviderEventRow> {
  const parkedInput = { ...input, processingState: "parked" as const };
  const durable = await ingestReferralProviderEvent(parkedInput, executor);
  if (durable.processingState === "applied") return durable;
  return txFor(executor, async (tx) => {
    const [event] = await tx.select().from(referralDiscountProviderEvents)
      .where(eq(referralDiscountProviderEvents.id, durable.id))
      .for("update")
      .limit(1);
    if (!event) throw new Error(`Referral provider event not found: ${durable.id}`);
    if (event.processingState === "applied") return event;
    await apply(tx, event);
    const [updated] = await tx.update(referralDiscountProviderEvents).set({
      processingState: "applied",
      sanitizedErrorCode: null,
      sanitizedErrorMessage: null,
      updatedAt: new Date(),
    }).where(and(
      eq(referralDiscountProviderEvents.id, event.id),
      eq(referralDiscountProviderEvents.processingState, "parked"),
    )).returning();
    if (!updated) throw new ReferralDiscountError("provider_event_replay_mismatch", "Referral provider event could not be marked applied atomically.");
    return updated;
  });
}

async function transitionHeldReservation(
  redemptionId: string,
  transition: "void" | "checkout_expired" | "qualified",
  tx: DatabaseExecutor,
  fields: Partial<typeof referralDiscountRedemptions.$inferInsert> = {},
): Promise<RedemptionRow> {
  const [row] = await tx.select().from(referralDiscountRedemptions)
    .where(eq(referralDiscountRedemptions.id, redemptionId))
    .for("update")
    .limit(1);
  if (!row) throw new Error(`Referral redemption not found: ${redemptionId}`);

  if (transition === "qualified" && row.capSlotState === "consumed") {
    if (
      row.firstPaidInvoiceId !== fields.firstPaidInvoiceId
      || row.stripeSubscriptionId !== fields.stripeSubscriptionId
      || row.stripeCustomerId !== fields.stripeCustomerId
    ) {
      throw new ReferralDiscountError("acquisition_replay_mismatch", "Qualified referral replay does not match the canonical payload.");
    }
    return row;
  }
  if ((transition === "void" || transition === "checkout_expired") && row.capSlotState === "released") {
    if (row.acquisitionState !== transition) {
      throw new ReferralDiscountError("invalid_transition", "Referral terminal replay does not match the canonical terminal state.");
    }
    return row;
  }
  if (transition === "qualified" && row.acquisitionState !== "checkout_completed") {
    throw new ReferralDiscountError("invalid_transition", "Referral redemption must be checkout_completed before qualification.");
  }
  if (transition === "checkout_expired" && row.acquisitionState !== "checkout_created") {
    throw new ReferralDiscountError("invalid_transition", "Referral redemption must be checkout_created before checkout_expired.");
  }
  if (transition === "void" && row.acquisitionState !== "reserved") {
    throw new ReferralDiscountError("invalid_transition", "Referral redemption must be reserved before provider void.");
  }
  if (row.capSlotState !== "held") {
    throw new ReferralDiscountError("cap_slot_not_held", "Referral redemption cap slot is not held.");
  }

  await readCampaignForUpdate(tx, row.campaignId);
  await readCodeForUpdate(tx, row.codeId);

  const now = new Date();
  if (transition === "qualified") {
    const [updated] = await tx.update(referralDiscountRedemptions).set({
      ...fields,
      acquisitionState: "qualified",
      qualificationDisposition: "qualified",
      financialRisk: "clear",
      capSlotState: "consumed",
      qualifiedAt: now,
      updatedAt: now,
    }).where(eq(referralDiscountRedemptions.id, redemptionId)).returning();
    await tx.update(referralDiscountCampaigns).set({
      liveReservedCount: sql`${referralDiscountCampaigns.liveReservedCount} - 1`,
      qualifiedCount: sql`${referralDiscountCampaigns.qualifiedCount} + 1`,
      updatedAt: now,
    }).where(eq(referralDiscountCampaigns.id, row.campaignId));
    await tx.update(referralDiscountCodes).set({
      liveReservedCount: sql`${referralDiscountCodes.liveReservedCount} - 1`,
      qualifiedCount: sql`${referralDiscountCodes.qualifiedCount} + 1`,
      updatedAt: now,
    }).where(eq(referralDiscountCodes.id, row.codeId));
    return updated;
  }

  const [updated] = await tx.update(referralDiscountRedemptions).set({
    ...fields,
    acquisitionState: transition,
    capSlotState: "released",
    terminalAt: now,
    updatedAt: now,
  }).where(eq(referralDiscountRedemptions.id, redemptionId)).returning();
  await tx.update(referralDiscountCampaigns).set({
    liveReservedCount: sql`${referralDiscountCampaigns.liveReservedCount} - 1`,
    updatedAt: now,
  }).where(eq(referralDiscountCampaigns.id, row.campaignId));
  await tx.update(referralDiscountCodes).set({
    liveReservedCount: sql`${referralDiscountCodes.liveReservedCount} - 1`,
    updatedAt: now,
  }).where(eq(referralDiscountCodes.id, row.codeId));
  return updated;
}

export function voidReferralReservation(redemptionId: string, reason: string, executor: DatabaseExecutor = getDb()) {
  return txFor(executor, (tx) => transitionHeldReservation(redemptionId, "void", tx, { internalReason: reason }));
}

export function expireReferralReservation(redemptionId: string, executor: DatabaseExecutor = getDb()) {
  return txFor(executor, (tx) => transitionHeldReservation(redemptionId, "checkout_expired", tx));
}

export function expireReferralCheckoutSession(
  redemptionId: string,
  stripeCheckoutSessionId: string,
  executor: DatabaseExecutor = getDb(),
) {
  return txFor(executor, async (tx) => {
    const [row] = await tx.select().from(referralDiscountRedemptions)
      .where(eq(referralDiscountRedemptions.id, redemptionId))
      .for("update")
      .limit(1);
    if (!row) throw new Error(`Referral redemption not found: ${redemptionId}`);
    if (row.stripeCheckoutSessionId !== stripeCheckoutSessionId) {
      throw new ReferralDiscountError("acquisition_replay_mismatch", "Checkout-expired session does not match the canonical checkout session.");
    }
    return transitionHeldReservation(redemptionId, "checkout_expired", tx);
  });
}

export async function markReferralCheckoutCreated(
  redemptionId: string,
  input: MarkReferralCheckoutCreatedInput,
  executor: DatabaseExecutor = getDb(),
): Promise<RedemptionRow> {
  return txFor(executor, async (tx) => {
    assertCanonicalCreatedInput(input);
    const [row] = await tx.select().from(referralDiscountRedemptions)
      .where(eq(referralDiscountRedemptions.id, redemptionId))
      .for("update")
      .limit(1);
    if (!row) throw new Error(`Referral redemption not found: ${redemptionId}`);
    if (input.decisionAt < row.reservedAt) {
      throw new ReferralDiscountError("invalid_reservation_window", "Checkout decision time must not precede the original reservation time.");
    }
    if (input.reservationExpiresAt <= input.decisionAt) {
      throw new ReferralDiscountError("invalid_reservation_window", "Checkout reservation expiry must remain after the checkout decision time.");
    }
    if (row.acquisitionState === "checkout_created") {
      const mismatch = [
        row.stripeCheckoutSessionId !== input.stripeCheckoutSessionId,
        row.stripeCustomerId !== input.stripeCustomerId,
        row.stripeSubscriptionId !== input.stripeSubscriptionId,
        !sameInstant(row.reservationExpiresAt, input.reservationExpiresAt),
      ].some(Boolean);
      if (mismatch) {
        throw new ReferralDiscountError("acquisition_replay_mismatch", "Checkout-created replay does not match the canonical payload.");
      }
      return row;
    }
    if (row.acquisitionState !== "reserved") {
      throw new ReferralDiscountError("invalid_transition", "Referral redemption must be reserved before checkout_created.");
    }
    if (row.stripeCustomerId !== null && row.stripeCustomerId !== input.stripeCustomerId) {
      throw new ReferralDiscountError("acquisition_replay_mismatch", "Checkout-created customer must preserve the reservation customer identity.");
    }
    if (row.stripeSubscriptionId !== null && row.stripeSubscriptionId !== input.stripeSubscriptionId) {
      throw new ReferralDiscountError("acquisition_replay_mismatch", "Checkout-created subscription must preserve the reservation subscription identity.");
    }
    const [updated] = await tx.update(referralDiscountRedemptions).set({
      acquisitionState: "checkout_created",
      stripeCheckoutSessionId: input.stripeCheckoutSessionId,
      stripeCustomerId: input.stripeCustomerId,
      stripeSubscriptionId: input.stripeSubscriptionId,
      reservationExpiresAt: input.reservationExpiresAt,
      checkoutCreatedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(referralDiscountRedemptions.id, redemptionId)).returning();
    return updated;
  });
}

export async function markReferralCheckoutCompleted(
  redemptionId: string,
  input: MarkReferralCheckoutCompletedInput,
  executor: DatabaseExecutor = getDb(),
): Promise<RedemptionRow> {
  return txFor(executor, async (tx) => {
    assertCanonicalCompletedInput(input);
    const [row] = await tx.select().from(referralDiscountRedemptions)
      .where(eq(referralDiscountRedemptions.id, redemptionId))
      .for("update")
      .limit(1);
    if (!row) throw new Error(`Referral redemption not found: ${redemptionId}`);
    if (row.acquisitionState === "checkout_completed") {
      const mismatch = [
        row.stripeCheckoutSessionId !== input.stripeCheckoutSessionId,
        row.stripeCustomerId !== input.stripeCustomerId,
        row.stripeSubscriptionId !== input.stripeSubscriptionId,
      ].some(Boolean);
      if (mismatch) {
        throw new ReferralDiscountError("acquisition_replay_mismatch", "Checkout-completed replay does not match the canonical payload.");
      }
      return row;
    }
    if (row.acquisitionState !== "checkout_created") {
      throw new ReferralDiscountError("invalid_transition", "Referral redemption must be checkout_created before checkout_completed.");
    }
    if (row.stripeCheckoutSessionId !== input.stripeCheckoutSessionId) {
      throw new ReferralDiscountError("acquisition_replay_mismatch", "Checkout-completed session does not match the checkout-created session.");
    }
    if (row.stripeCustomerId !== null && row.stripeCustomerId !== input.stripeCustomerId) {
      throw new ReferralDiscountError("acquisition_replay_mismatch", "Checkout-completed customer does not match the checkout-created customer.");
    }
    if (row.stripeSubscriptionId !== null && row.stripeSubscriptionId !== input.stripeSubscriptionId) {
      throw new ReferralDiscountError("acquisition_replay_mismatch", "Checkout-completed subscription does not match the checkout-created subscription.");
    }
    const [updated] = await tx.update(referralDiscountRedemptions).set({
      acquisitionState: "checkout_completed",
      stripeCustomerId: input.stripeCustomerId,
      stripeSubscriptionId: input.stripeSubscriptionId,
      checkoutCompletedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(referralDiscountRedemptions.id, redemptionId)).returning();
    return updated;
  });
}

export async function readReferralRedemptionBySubscription(
  stripeSubscriptionId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<RedemptionRow | null> {
  const [row] = await executor.select().from(referralDiscountRedemptions)
    .where(eq(referralDiscountRedemptions.stripeSubscriptionId, stripeSubscriptionId))
    .limit(1);
  return row ?? null;
}

export async function readQualifiedReferralRedemptionByInvoice(
  firstPaidInvoiceId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<RedemptionRow | null> {
  const [row] = await executor.select().from(referralDiscountRedemptions)
    .where(and(
      eq(referralDiscountRedemptions.firstPaidInvoiceId, firstPaidInvoiceId),
      eq(referralDiscountRedemptions.acquisitionState, "qualified"),
    ))
    .limit(1);
  return row ?? null;
}

export async function qualifyReferralRedemption(
  redemptionId: string,
  input: QualifyReferralRedemptionInput,
  executor: DatabaseExecutor = getDb(),
) {
  assertCanonicalQualifiedInput(input);
  return txFor(executor, (tx) => transitionHeldReservation(redemptionId, "qualified", tx, {
    firstPaidInvoiceId: input.firstPaidInvoiceId,
    stripeSubscriptionId: input.stripeSubscriptionId,
    stripeCustomerId: input.stripeCustomerId,
  }));
}

export async function qualifyReferralInvoicePayment(
  input: QualifyReferralInvoicePaymentInput,
  executor: DatabaseExecutor = getDb(),
) {
  assertCanonicalQualifiedInput(input);
  return txFor(executor, async (tx) => {
    const [row] = await tx.select({
      redemption: referralDiscountRedemptions,
      code: referralDiscountCodes,
      campaign: referralDiscountCampaigns,
    })
      .from(referralDiscountRedemptions)
      .innerJoin(referralDiscountCodes, eq(referralDiscountCodes.id, referralDiscountRedemptions.codeId))
      .innerJoin(referralDiscountCampaigns, eq(referralDiscountCampaigns.id, referralDiscountRedemptions.campaignId))
      .where(eq(referralDiscountRedemptions.id, input.redemptionId))
      .for("update")
      .limit(1);
    if (!row) throw new Error(`Referral redemption not found: ${input.redemptionId}`);
    if (!input.expectedPriceIds.includes(input.stripePriceId)) {
      throw new ReferralDiscountError("financial_adjustment_unjoinable", "Referral invoice line is not an expected Pro price.");
    }
    if (
      row.redemption.targetProductScope !== "pro"
      || row.redemption.targetBillingInterval !== input.billingInterval
      || !campaignSupportsFrozenScope(row.campaign, "pro", input.billingInterval)
    ) {
      throw new ReferralDiscountError("referral_scope_mismatch", "Referral invoice product or billing interval does not match the frozen reservation scope.");
    }
    if (
      row.code.stripePromotionCodeId !== input.stripePromotionCodeId
      || row.campaign.stripeCouponId !== input.stripeCouponId
    ) {
      throw new ReferralDiscountError("financial_adjustment_unjoinable", "Referral invoice discount does not match the canonical promotion/coupon.");
    }
    return transitionHeldReservation(input.redemptionId, "qualified", tx, {
      firstPaidInvoiceId: input.firstPaidInvoiceId,
      stripeSubscriptionId: input.stripeSubscriptionId,
      stripeCustomerId: input.stripeCustomerId,
    });
  });
}

export async function markCampaignProviderProvisioningStarted(
  campaignId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<CampaignRow> {
  const [row] = await executor.update(referralDiscountCampaigns).set({
    providerProvisioningStartedAt: sql`COALESCE(${referralDiscountCampaigns.providerProvisioningStartedAt}, now())`,
    providerState: "pending",
    updatedAt: new Date(),
  }).where(eq(referralDiscountCampaigns.id, campaignId)).returning();
  if (!row) throw new Error(`Referral campaign not found: ${campaignId}`);
  return row;
}

export async function updateCampaignEconomics(
  campaignId: string,
  patch: CampaignEconomicsPatch,
  executor: DatabaseExecutor = getDb(),
): Promise<CampaignRow> {
  const [updated] = await executor.update(referralDiscountCampaigns).set({
    ...(patch.percentOff !== undefined ? { percentOff: patch.percentOff } : {}),
    ...(patch.durationMonths !== undefined ? { durationMonths: patch.durationMonths } : {}),
    ...(patch.currency !== undefined ? { currency: patch.currency.toLowerCase() } : {}),
    ...(patch.productScope !== undefined ? { productScope: patch.productScope } : {}),
    ...(patch.billingIntervalScope !== undefined ? { billingIntervalScope: patch.billingIntervalScope } : {}),
    ...(patch.maxPaidRedemptions !== undefined ? { maxPaidRedemptions: patch.maxPaidRedemptions } : {}),
    ...(patch.providerStrategy !== undefined ? { providerStrategy: patch.providerStrategy } : {}),
    mutationReason: patch.mutationReason,
    updatedAt: new Date(),
  }).where(and(
    eq(referralDiscountCampaigns.id, campaignId),
    sql`${referralDiscountCampaigns.providerProvisioningStartedAt} IS NULL`,
  )).returning();
  if (!updated) {
    const [current] = await executor.select().from(referralDiscountCampaigns)
      .where(eq(referralDiscountCampaigns.id, campaignId))
      .limit(1);
    if (!current) throw new Error(`Referral campaign not found: ${campaignId}`);
    throw new ReferralDiscountError("campaign_economics_locked", "Referral campaign economics are locked after provider provisioning starts.");
  }
  return updated;
}

export async function recordReferralFinancialAdjustment(
  input: FinancialAdjustmentInput,
  executor: DatabaseExecutor = getDb(),
): Promise<{ status: "recorded" | "duplicate" | "parked"; redemption: RedemptionRow | null }> {
  return txFor(executor, async (tx) => {
    const [inserted] = await tx.insert(referralDiscountFinancialAdjustments).values({
      environment: input.environment,
      livemode: input.livemode,
      kind: input.kind,
      providerFactId: input.providerFactId,
      providerFactSequence: input.providerFactSequence ?? 0,
      stripeEventId: input.stripeEventId,
      stripeInvoiceId: input.stripeInvoiceId,
      stripeRefundId: input.stripeRefundId ?? null,
      stripeCreditNoteId: input.stripeCreditNoteId ?? null,
      stripeDisputeId: input.stripeDisputeId ?? null,
      stripeChargeId: input.stripeChargeId ?? null,
      currency: input.currency.toLowerCase(),
      amount: input.amount,
      netRevenueDelta: input.netRevenueDelta,
      fullEconomicReversal: input.fullEconomicReversal ?? false,
      observedAt: input.observedAt ?? new Date(),
      sanitizedReason: input.sanitizedReason ?? null,
      observedRedemptionId: input.redemptionId ?? null,
      processingState: "parked",
    }).onConflictDoNothing({
      target: [
        referralDiscountFinancialAdjustments.environment,
        referralDiscountFinancialAdjustments.livemode,
        referralDiscountFinancialAdjustments.kind,
        referralDiscountFinancialAdjustments.providerFactId,
        referralDiscountFinancialAdjustments.stripeEventId,
      ],
    }).returning();

    const adjustment = inserted ?? (await tx.select().from(referralDiscountFinancialAdjustments)
      .where(and(
        eq(referralDiscountFinancialAdjustments.environment, input.environment),
        eq(referralDiscountFinancialAdjustments.livemode, input.livemode),
        eq(referralDiscountFinancialAdjustments.kind, input.kind),
        eq(referralDiscountFinancialAdjustments.providerFactId, input.providerFactId),
        eq(referralDiscountFinancialAdjustments.stripeEventId, input.stripeEventId),
      ))
      .for("update")
      .limit(1))[0];
    if (!adjustment) throw new Error("Referral financial adjustment upsert did not return a row.");
    assertSameFinancialAdjustmentReplay(adjustment, input);
    if (adjustment.processingState === "applied") {
      if (input.redemptionId && adjustment.resolvedRedemptionId !== input.redemptionId) {
        throw new ReferralDiscountError("financial_adjustment_resolution_conflict", "Referral financial adjustment is already resolved to a different redemption.");
      }
      return { status: "duplicate" as const, redemption: null };
    }

    if (!input.redemptionId) {
      return { status: "parked" as const, redemption: null };
    }

    const [row] = await tx.select().from(referralDiscountRedemptions)
      .where(eq(referralDiscountRedemptions.id, input.redemptionId))
      .for("update")
      .limit(1);
    if (!row) throw new Error(`Referral redemption not found: ${input.redemptionId}`);
    if (row.acquisitionState !== "qualified") {
      throw new ReferralDiscountError("financial_adjustment_before_qualification", "Referral financial adjustment requires a qualified redemption.");
    }
    if (row.firstPaidInvoiceId !== input.stripeInvoiceId) {
      return { status: "parked" as const, redemption: row };
    }

    if (input.kind === "dispute_won" || input.kind === "dispute_lost") {
      if (!input.stripeDisputeId) {
        return { status: "parked" as const, redemption: row };
      }
      const lineage = await tx.select({ id: referralDiscountFinancialAdjustments.id })
        .from(referralDiscountFinancialAdjustments)
        .where(and(
          eq(referralDiscountFinancialAdjustments.resolvedRedemptionId, input.redemptionId),
          eq(referralDiscountFinancialAdjustments.environment, input.environment),
          eq(referralDiscountFinancialAdjustments.livemode, input.livemode),
          eq(referralDiscountFinancialAdjustments.processingState, "applied"),
          eq(referralDiscountFinancialAdjustments.stripeDisputeId, input.stripeDisputeId),
          input.kind === "dispute_lost"
            ? eq(referralDiscountFinancialAdjustments.kind, "dispute_opened")
            : or(
              eq(referralDiscountFinancialAdjustments.kind, "dispute_opened"),
              eq(referralDiscountFinancialAdjustments.kind, "dispute_lost"),
            ),
        ))
        .limit(1);
      if (lineage.length === 0) return { status: "parked" as const, redemption: row };
    }

    const [existingResolution] = await tx.select().from(referralDiscountFinancialAdjustmentResolutions)
      .where(eq(referralDiscountFinancialAdjustmentResolutions.financialAdjustmentId, adjustment.id))
      .for("update")
      .limit(1);
    if (existingResolution) {
      if (existingResolution.redemptionId !== input.redemptionId) {
        throw new ReferralDiscountError("financial_adjustment_resolution_conflict", "Referral financial adjustment resolution conflicts with the canonical resolution.");
      }
    } else {
      await tx.insert(referralDiscountFinancialAdjustmentResolutions).values({
        financialAdjustmentId: adjustment.id,
        redemptionId: input.redemptionId,
        source: input.resolutionSource ?? "referral-financial-fold",
        auditActor: input.resolutionAuditActor ?? null,
        auditReason: input.resolutionAuditReason ?? "matched provider fact to qualified referral redemption",
      });
    }

    const now = new Date();
    await tx.update(referralDiscountFinancialAdjustments).set({
      resolvedRedemptionId: input.redemptionId,
      processingState: "applied",
      appliedAt: now,
    }).where(eq(referralDiscountFinancialAdjustments.id, adjustment.id));

    const folded = await foldReferralFinancialDisposition(input.redemptionId, row, tx, {
      environment: input.environment,
      livemode: input.livemode,
      kind: input.kind,
      stripeDisputeId: input.stripeDisputeId ?? null,
      fullEconomicReversal: input.fullEconomicReversal ?? false,
    });
    const [updated] = await tx.update(referralDiscountRedemptions).set({
      qualificationDisposition: folded.qualificationDisposition,
      financialRisk: folded.financialRisk,
      updatedAt: now,
    }).where(eq(referralDiscountRedemptions.id, input.redemptionId)).returning();
    if (input.kind === "dispute_opened" && input.stripeDisputeId) {
      await applyParkedDisputeTerminalAdjustments({
        redemptionId: input.redemptionId,
        environment: input.environment,
        livemode: input.livemode,
        stripeDisputeId: input.stripeDisputeId,
      }, tx);
      const [refolded] = await tx.select().from(referralDiscountRedemptions)
        .where(eq(referralDiscountRedemptions.id, input.redemptionId))
        .limit(1);
      return { status: "recorded" as const, redemption: refolded ?? updated };
    }
    return { status: "recorded" as const, redemption: updated };
  });
}

async function foldReferralFinancialDisposition(
  redemptionId: string,
  row: RedemptionRow,
  tx: DatabaseExecutor,
  latest: {
    environment: string;
    livemode: boolean;
    kind: FinancialAdjustmentInput["kind"];
    stripeDisputeId: string | null;
    fullEconomicReversal: boolean;
  },
): Promise<{ qualificationDisposition: "qualified" | "reversed"; financialRisk: "clear" | "disputed" }> {
  let qualificationDisposition: "qualified" | "reversed" = "qualified";
  let financialRisk: "clear" | "disputed" = "clear";

  if (!row.firstPaidInvoiceId) {
    return { qualificationDisposition, financialRisk };
  }

  const appliedFacts = await tx.select({
    kind: referralDiscountFinancialAdjustments.kind,
    stripeDisputeId: referralDiscountFinancialAdjustments.stripeDisputeId,
    providerFactSequence: referralDiscountFinancialAdjustments.providerFactSequence,
    stripeEventId: referralDiscountFinancialAdjustments.stripeEventId,
    netRevenueDelta: referralDiscountFinancialAdjustments.netRevenueDelta,
  })
    .from(referralDiscountFinancialAdjustments)
    .where(and(
      eq(referralDiscountFinancialAdjustments.resolvedRedemptionId, redemptionId),
      eq(referralDiscountFinancialAdjustments.environment, latest.environment),
      eq(referralDiscountFinancialAdjustments.livemode, latest.livemode),
      eq(referralDiscountFinancialAdjustments.processingState, "applied"),
      eq(referralDiscountFinancialAdjustments.stripeInvoiceId, row.firstPaidInvoiceId),
    ));

  const disputes = new Map<string, Array<{ kind: FinancialAdjustmentInput["kind"]; sequence: number; eventId: string }>>();
  for (const fact of appliedFacts) {
    if (!fact.stripeDisputeId) continue;
    if (fact.kind !== "dispute_opened" && fact.kind !== "dispute_won" && fact.kind !== "dispute_lost") continue;
    const group = disputes.get(fact.stripeDisputeId) ?? [];
    group.push({
      kind: fact.kind,
      sequence: fact.providerFactSequence,
      eventId: fact.stripeEventId,
    });
    disputes.set(fact.stripeDisputeId, group);
  }
  const disputeStates = [...disputes.values()].map((facts) => {
    const maxSequence = Math.max(...facts.map((fact) => fact.sequence));
    const currentFacts = facts.filter((fact) => fact.sequence === maxSequence);
    const hasLost = currentFacts.some((fact) => fact.kind === "dispute_lost");
    const hasWon = currentFacts.some((fact) => fact.kind === "dispute_won");
    if (hasLost && hasWon) {
      throw new ReferralDiscountError("financial_adjustment_unjoinable", "Referral dispute same-second terminal facts conflict for this lineage.");
    }
    if (hasLost) return { kind: "dispute_lost" as const };
    if (hasWon) return { kind: "dispute_won" as const };
    return { kind: "dispute_opened" as const };
  });
  const hasOpenDispute = disputeStates.some((state) => state.kind === "dispute_opened");
  if (disputeStates.some((state) => state.kind === "dispute_lost")) {
    qualificationDisposition = "reversed";
  } else if (disputeStates.some((state) => state.kind === "dispute_won")) {
    qualificationDisposition = "qualified";
  }
  if (hasOpenDispute) {
    financialRisk = "disputed";
  } else if (disputeStates.some((state) => state.kind === "dispute_won" || state.kind === "dispute_lost")) {
    financialRisk = "clear";
  }

  const [paidFact] = await tx.select({ amountPaid: billingPaidIdentityEvents.amountPaid })
    .from(billingPaidIdentityEvents)
    .innerJoin(
      billingPaidIdentityResolutions,
      eq(billingPaidIdentityResolutions.paidIdentityEventId, billingPaidIdentityEvents.id),
    )
    .where(and(
      eq(billingPaidIdentityEvents.environment, latest.environment),
      eq(billingPaidIdentityEvents.livemode, latest.livemode),
      eq(billingPaidIdentityEvents.stripeInvoiceId, row.firstPaidInvoiceId),
      eq(billingPaidIdentityEvents.paidFactKind, "pro_invoice_paid"),
      eq(billingPaidIdentityResolutions.serverId, row.referredServerId),
      eq(billingPaidIdentityResolutions.payerUserId, row.redeemingUserId),
    ))
    .limit(1);
  if (paidFact) {
    const netAdjustment = appliedFacts
      .filter((fact) => fact.kind === "refund" || fact.kind === "credit_note")
      .reduce((total, adjustment) => total + adjustment.netRevenueDelta, 0);
    if (paidFact.amountPaid + netAdjustment <= 0) {
      qualificationDisposition = "reversed";
      if (!hasOpenDispute) financialRisk = "clear";
    } else if (
      !disputeStates.some((state) => state.kind === "dispute_lost")
      && (latest.kind === "refund" || latest.kind === "credit_note")
    ) {
      qualificationDisposition = "qualified";
    }
  } else if (latest.fullEconomicReversal) {
    qualificationDisposition = "reversed";
    if (!hasOpenDispute) financialRisk = "clear";
  }

  return { qualificationDisposition, financialRisk };
}

async function applyParkedDisputeTerminalAdjustments(
  input: {
    redemptionId: string;
    environment: string;
    livemode: boolean;
    stripeDisputeId: string;
  },
  tx: DatabaseExecutor,
): Promise<void> {
  const parkedTerminals = await tx.select().from(referralDiscountFinancialAdjustments)
    .where(and(
      eq(referralDiscountFinancialAdjustments.observedRedemptionId, input.redemptionId),
      eq(referralDiscountFinancialAdjustments.environment, input.environment),
      eq(referralDiscountFinancialAdjustments.livemode, input.livemode),
      eq(referralDiscountFinancialAdjustments.processingState, "parked"),
      eq(referralDiscountFinancialAdjustments.stripeDisputeId, input.stripeDisputeId),
      or(
        eq(referralDiscountFinancialAdjustments.kind, "dispute_won"),
        eq(referralDiscountFinancialAdjustments.kind, "dispute_lost"),
      ),
    ));
  for (const terminal of parkedTerminals) {
    await recordReferralFinancialAdjustment({
      redemptionId: input.redemptionId,
      environment: terminal.environment,
      livemode: terminal.livemode,
      kind: terminal.kind,
      providerFactId: terminal.providerFactId,
      providerFactSequence: terminal.providerFactSequence,
      stripeEventId: terminal.stripeEventId,
      stripeInvoiceId: terminal.stripeInvoiceId,
      stripeRefundId: terminal.stripeRefundId,
      stripeCreditNoteId: terminal.stripeCreditNoteId,
      stripeDisputeId: terminal.stripeDisputeId,
      stripeChargeId: terminal.stripeChargeId,
      currency: terminal.currency,
      amount: terminal.amount,
      netRevenueDelta: terminal.netRevenueDelta,
      fullEconomicReversal: terminal.fullEconomicReversal,
      observedAt: terminal.observedAt,
      sanitizedReason: terminal.sanitizedReason,
    }, tx);
  }
}
