import Stripe from "stripe";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "../db/index";
import type { DatabaseExecutor } from "../db/index";
import {
  referralDiscountCampaigns,
  referralDiscountCodes,
  referralDiscountFinancialAdjustments,
  referralDiscountProviderEvents,
  referralDiscountProviderOperations,
  subscriptions,
  servers,
  webhookEvents,
} from "../db/schema";
import type { Server as SocketIOServer } from "socket.io";
import {
  PRO_AGENT_SEAT_BLOCK_SIZE,
  PLAN_CONFIG,
  DEFAULT_BILLING_INTERVAL,
  calculateAgentSeatBlockQuantity,
  calculateProPrice,
  calculateProPackQuantity,
  calculateProSeatPrice,
  currentTimeMs,
  normalizeBillingInterval,
  type BillingInterval,
  type BillingPriceSummary,
  type ServerPlan,
} from "@botiverse/raft-shared";
import { getServerBillingEntitlement, getServerBillingUsage } from "./planService";
import { getWebFrameAncestorOrigins } from "../config/appUrl";
import { addTraceEvent, traceAttrs } from "../tracing/semanticTrace";
import {
  assertReferralCheckoutMetadataPair,
  applyReferralProviderEvent,
  beginReferralProviderOperation,
  buildReferralCheckoutMetadata,
  confirmReferralProviderOperation,
  createReferralReservationForCode,
  expireReferralCheckoutSession,
  fingerprintReferralProviderRequest,
  hashReferralProviderPayload,
  ingestReferralProviderEvent,
  markReferralCheckoutCompleted,
  markReferralCheckoutCreated,
  markReferralProviderOperationStarted,
  normalizeReferralCode,
  parkReferralProviderOperation,
  previewReferralCode,
  qualifyReferralInvoicePayment,
  readQualifiedReferralRedemptionByInvoice,
  readActiveReferralReservationForCode,
  readReferralRedemptionBySubscription,
  recordReferralFinancialAdjustment,
  voidReferralReservation,
} from "./referralDiscountService";

// ── Socket.io reference for broadcasting plan changes ──

let _io: SocketIOServer | null = null;

export function setIO(io: SocketIOServer) {
  _io = io;
}

function broadcastPlanChange(serverId: string, plan: string) {
  if (_io) {
    _io.to(`server:${serverId}`).emit("server:plan-updated", { serverId, plan });
  }
}

function traceBillingEvent(name: string, attrs?: Record<string, unknown>): void {
  addTraceEvent(name, attrs);
}

function traceStripeBillingState(): Record<string, unknown> {
  return {
    stripe_billing_flag_enabled: isStripeBillingFlagEnabled(),
    stripe_configured: isStripeConfigured(),
  };
}

function traceRequestedSeatQuantity(request: BillingPackQuantityRequest): number | string | null {
  const value = request.seatQuantity ?? request.packQuantity ?? request.proPackQuantity;
  if (value == null || value === "") return null;
  if (typeof value === "number" || typeof value === "string") return value;
  return "invalid";
}

// ── Stripe Client (lazy init — only created when env vars are present) ──

let _stripe: Stripe | null = null;
let _referralStripe: Stripe | null = null;

export const REFERRAL_STRIPE_API_VERSION = "2026-02-25.clover";
const REFERRAL_PROVIDER_STRATEGY = `stripe_coupon_repeating_v1@${REFERRAL_STRIPE_API_VERSION}`;
const REFERRAL_DISCOUNT_UNAVAILABLE = "Referral discount unavailable";
const REFERRAL_PROVIDER_USE = "referral_discount_checkout";
const REFERRAL_ACCEPTANCE_NOT_RUN = "NOT_RUN_UNAUTHORIZED";

function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("Stripe is not configured (STRIPE_SECRET_KEY missing)");
    _stripe = new Stripe(key);
  }
  return _stripe;
}

function getReferralStripe(): Stripe {
  if (!_referralStripe) {
    const key = process.env.REFERRAL_DISCOUNT_STRIPE_SECRET_KEY?.trim();
    if (!key) throw new Error("Referral discount Stripe sandbox is not configured");
    if (!key.startsWith("sk_test_")) {
      throw new Error("Referral discount Stripe sandbox key must be test-mode scoped");
    }
    _referralStripe = new Stripe(key, { apiVersion: REFERRAL_STRIPE_API_VERSION });
    (_referralStripe as ReferralProviderStripe).__referralProfile = process.env.REFERRAL_DISCOUNT_STRIPE_PROFILE?.trim();
  }
  return _referralStripe;
}

export function __setStripeForTests(stripe: Stripe | null): void {
  _stripe = stripe;
}

export function __setReferralStripeForTests(stripe: Stripe | null): void {
  _referralStripe = stripe;
}

export function __resetStripeForTests(): void {
  _stripe = null;
  _referralStripe = null;
}

const REQUIRED_STRIPE_BILLING_ENV = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRO_SEAT_MONTHLY_PRICE_ID",
  "STRIPE_PRO_SEAT_ANNUAL_PRICE_ID",
] as const;

function isStripeBillingFlagEnabled(): boolean {
  return process.env.STRIPE_BILLING_ENABLED?.trim().toLowerCase() === "true";
}

/** Returns true if Stripe billing is explicitly enabled and all required env vars are set. */
export function isStripeConfigured(): boolean {
  return isStripeBillingFlagEnabled() && REQUIRED_STRIPE_BILLING_ENV.every((key) => !!process.env[key]?.trim());
}

const PASSIVE_SUBSCRIPTION_REFRESH_MS = 6 * 60 * 60 * 1000;

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

type PaidBillingPlan = "pro";

interface StripePriceIds {
  proSeatMonthly: string;
  proSeatAnnual: string;
}

function getStripePriceIds(): StripePriceIds {
  return {
    proSeatMonthly: getRequiredEnv("STRIPE_PRO_SEAT_MONTHLY_PRICE_ID"),
    proSeatAnnual: getRequiredEnv("STRIPE_PRO_SEAT_ANNUAL_PRICE_ID"),
  };
}

// ── Billing Summary ──

function priceForSummary(plan: string, seatQuantity: number, billingInterval: BillingInterval): BillingPriceSummary | null {
  if (plan === "pro") return calculateProPrice(seatQuantity, billingInterval);
  return null;
}

export async function getBillingSummary(serverId: string) {
  traceBillingEvent("billing.summary.requested", {
    server_id: serverId,
    ...traceStripeBillingState(),
  });
  const db = getDb();
  await refreshSubscriptionForServer(serverId);
  const { getFileUploadQuotaSummary } = await import("./fileUploadQuotaService");
  const [server] = await db
    .select({ plan: servers.plan })
    .from(servers)
    .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)));
  const entitlement = await getServerBillingEntitlement(db, serverId);
  const usage = await getServerBillingUsage(db, serverId);
  const fileUploadQuota = await getFileUploadQuotaSummary(serverId);
  const sub = await getSubscription(serverId);
  const billingInterval = normalizeBillingInterval(entitlement.billingInterval ?? sub?.billingInterval ?? DEFAULT_BILLING_INTERVAL);
  const provisionedHumans = entitlement.provisionedHumanSeats ?? (entitlement.plan === "pro" ? entitlement.capacity.maxHumans : usage.humans);
  const provisionedAgents = entitlement.provisionedAgentSeats ?? (entitlement.plan === "pro" ? entitlement.capacity.maxAgents : usage.agents);
  const isInternalUnlimitedPlan = entitlement.plan === "founder" || entitlement.plan === "partner";

  const summary = {
    plan: entitlement.plan,
    displayName: PLAN_CONFIG[entitlement.plan].displayName,
    serverPlan: server?.plan ?? "free",
    source: entitlement.source,
    capacity: entitlement.capacity,
    usage,
    fileUploadQuota,
    provisioned: {
      humans: provisionedHumans,
      agents: provisionedAgents,
      proPackQuantity: entitlement.proPackQuantity ?? 0,
      trialFreePackQuantity: entitlement.trialFreePackQuantity ?? 0,
      firstPackTrialEndsAt: entitlement.firstPackTrialEndsAt ?? null,
    },
    price: priceForSummary(entitlement.plan, entitlement.proPackQuantity ?? 0, billingInterval),
    subscription: sub && !isInternalUnlimitedPlan
      ? {
          status: sub.status,
          billingInterval: sub.billingInterval,
          currentPeriodStart: sub.currentPeriodStart,
          currentPeriodEnd: sub.currentPeriodEnd,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        }
      : null,
    stripeConfigured: isStripeConfigured(),
  };
  traceBillingEvent("billing.summary.ready", {
    server_id: serverId,
    plan: summary.plan,
    server_plan: summary.serverPlan,
    entitlement_source: summary.source,
    stripe_configured: summary.stripeConfigured,
    subscription_status: summary.subscription?.status ?? "none",
    billing_interval: billingInterval,
    seat_quantity: summary.provisioned.proPackQuantity,
    provisioned_human_seats: summary.provisioned.humans,
    provisioned_agent_seats: summary.provisioned.agents,
  });
  return summary;
}

// ── Redirect URL Validation ──

/** Get allowed origins from CORS_ORIGIN env (for redirect URL validation). */
function getAllowedOrigins(): string[] {
  return getWebFrameAncestorOrigins();
}

/** Validate that a redirect URL's origin is in our CORS allowlist. */
export function validateRedirectUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return getAllowedOrigins().includes(parsed.origin);
  } catch {
    return false;
  }
}

// ── Checkout ──

export interface BillingCheckoutRequest {
  targetPlan?: unknown;
  billingTraceId?: unknown;
  billingInterval?: unknown;
  interval?: unknown;
  seatQuantity?: unknown;
  packQuantity?: unknown;
  proPackQuantity?: unknown;
  humanSeatQuantity?: unknown;
  agentSeatQuantity?: unknown;
  humanSeats?: unknown;
  agentSeats?: unknown;
  provisionedAgentSeats?: unknown;
  provisionedHumanSeats?: unknown;
  referralCode?: unknown;
}

export interface BillingPackQuantityRequest {
  seatQuantity?: unknown;
  packQuantity?: unknown;
  proPackQuantity?: unknown;
  humanSeatQuantity?: unknown;
  agentSeatQuantity?: unknown;
  humanSeats?: unknown;
  agentSeats?: unknown;
  provisionedHumanSeats?: unknown;
  provisionedAgentSeats?: unknown;
  promotionCode?: unknown;
  previewToken?: unknown;
}

export interface BillingPackQuantityUpdateResult {
  status: "unchanged" | "updated" | "reactivated" | "pending_payment" | "pending_webhook" | "scheduled_period_end";
  currentPackQuantity: number;
  requestedPackQuantity: number;
  effectiveAt: "current" | "after_payment" | "period_end";
  currentPeriodEnd: Date | null;
}

export interface BillingPackQuantityPreviewResult {
  status: "preview";
  currentPackQuantity: number;
  requestedPackQuantity: number;
  currency: string;
  prorationAmount: number;
  recurringAmount: number;
  discountAmount: number;
  promotion: {
    code: string;
    name: string | null;
    percentOff: number | null;
    amountOff: number | null;
    currency: string | null;
  } | null;
  previewToken: string;
  expiresAt: string;
}

interface CheckoutContract {
  lineItems: Array<{ price: string; quantity: number }>;
  metadata: Record<string, string>;
  subscriptionData: Stripe.Checkout.SessionCreateParams.SubscriptionData;
}

interface ReferralCheckoutContext {
  promotionCodeId: string;
  redemptionId: string;
  operationId: string;
  operationState: string;
  providerObjectId: string | null;
  idempotencyKey: string;
  requestPayload: Record<string, unknown>;
  metadata: Record<string, string>;
}

interface ReferralCheckoutProviderRequest extends Record<string, unknown> {
  apiVersion: typeof REFERRAL_STRIPE_API_VERSION;
  mode: "subscription";
  successUrl: string;
  cancelUrl: string;
  clientReferenceId: string;
  customer: string | null;
  discounts: Array<{ promotion_code: string }>;
  lineItems: Array<{ price: string; quantity: number }>;
  metadata: Record<string, string>;
  subscriptionData: Stripe.Checkout.SessionCreateParams.SubscriptionData;
  reservationExpiresAt: string;
}

interface ReferralCouponProviderRequest extends Record<string, unknown> {
  apiVersion: typeof REFERRAL_STRIPE_API_VERSION;
  providerStrategy: typeof REFERRAL_PROVIDER_STRATEGY;
  campaignId: string;
  couponId: string;
  percentOff: number;
  duration: "repeating";
  durationMonths: number;
  currency: string;
  productScope: "pro";
  billingIntervalScope: "monthly" | "annual" | "both";
  maxRedemptions: number | null;
  redeemBy: number | null;
  metadata: Record<string, string>;
}

interface ReferralPromotionProviderRequest extends Record<string, unknown> {
  apiVersion: typeof REFERRAL_STRIPE_API_VERSION;
  providerStrategy: typeof REFERRAL_PROVIDER_STRATEGY;
  codeId: string;
  campaignId: string;
  referrerUserId: string;
  couponId: string;
  providerPromotionCode: string;
  maxRedemptions: number | null;
  expiresAt: number | null;
  metadata: Record<string, string>;
}

type ReferralProviderStripe = Pick<Stripe, "accounts" | "balance" | "coupons" | "promotionCodes"> & {
  __referralProfile?: string;
};
type ReferralProviderStripeFactory = (env: NodeJS.ProcessEnv, authorization: ReferralProviderAuthorizationReceipt) => ReferralProviderStripe;

const referralProviderAuthorizationBrand: unique symbol = Symbol("referralProviderAuthorization");

export interface ReferralProviderAuthorizationReceipt {
  readonly [referralProviderAuthorizationBrand]: true;
  expectedAccountId: string;
  profile: string;
  authorizedAt: string;
}

const RAFT_PRO_SEAT_PRICING_CONTRACT = "raft-pro-seat-v1";

function toNonNegativeInteger(value: unknown, label: string): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function toPositiveInteger(value: unknown, label: string): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function toBillingInterval(value: unknown): BillingInterval {
  if (value == null || value === "") return DEFAULT_BILLING_INTERVAL;
  if (value === "monthly" || value === "annual") return value;
  throw new Error("billingInterval must be monthly or annual");
}

function toBillingTraceId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(trimmed)) return null;
  return trimmed;
}

function proSeatPriceIdForInterval(priceIds: StripePriceIds | Partial<StripePriceIds>, billingInterval: BillingInterval): string | undefined {
  return billingInterval === "annual" ? priceIds.proSeatAnnual : priceIds.proSeatMonthly;
}

function buildCheckoutContract(input: BillingCheckoutRequest, userId: string, serverId: string): CheckoutContract {
  const plan = input.targetPlan;
  if (plan !== "pro") {
    throw new Error("targetPlan must be pro");
  }

  const priceIds = getStripePriceIds();
  const billingInterval = toBillingInterval(input.billingInterval ?? input.interval);
  const explicitSeats = toPositiveInteger(input.seatQuantity ?? input.packQuantity ?? input.proPackQuantity, "seatQuantity");
  const requestedHumans = toPositiveInteger(
    input.humanSeatQuantity ?? input.humanSeats ?? input.provisionedHumanSeats,
    "humanSeatQuantity",
  ) ?? 1;
  const requestedAgents = toNonNegativeInteger(
    input.agentSeatQuantity ?? input.agentSeats ?? input.provisionedAgentSeats,
    "agentSeatQuantity",
  ) ?? 0;
  const seatQuantity = explicitSeats ?? calculateProPackQuantity(requestedHumans, requestedAgents);
  const provisionedAgentSeats = seatQuantity * PRO_AGENT_SEAT_BLOCK_SIZE;
  const billingTraceId = toBillingTraceId(input.billingTraceId);
  const metadata = {
    pricingContract: RAFT_PRO_SEAT_PRICING_CONTRACT,
    serverId,
    userId,
    targetPlan: "pro",
    billingInterval,
    seatQuantity: String(seatQuantity),
    humanSeatQuantity: String(requestedHumans),
    requestedAgentSeats: String(requestedAgents),
    agentSeatBlockQuantity: String(calculateAgentSeatBlockQuantity(requestedAgents)),
    proPackQuantity: String(seatQuantity),
    packQuantity: String(seatQuantity),
    stripeInitialPaidPackQuantity: String(seatQuantity),
    provisionedHumanSeats: String(seatQuantity),
    provisionedAgentSeats: String(provisionedAgentSeats),
    trialFreePackQuantity: "0",
    ...(billingTraceId ? { billingTraceId } : {}),
  };
  const subscriptionData: Stripe.Checkout.SessionCreateParams.SubscriptionData = {
    metadata,
  };
  const lineItems = [{ price: proSeatPriceIdForInterval(priceIds, billingInterval)!, quantity: seatQuantity }];
  return {
    lineItems,
    metadata,
    subscriptionData,
  };
}

function referralCheckoutMode(): "disabled" | "sandbox" {
  return process.env.REFERRAL_DISCOUNT_CHECKOUT_MODE === "sandbox" ? "sandbox" : "disabled";
}

function referralHistoryOriginAt(): Date {
  const configured = process.env.REFERRAL_DISCOUNT_HISTORY_ORIGIN_AT?.trim();
  if (!configured) throw new Error(REFERRAL_DISCOUNT_UNAVAILABLE);
  const parsed = new Date(configured);
  if (Number.isNaN(parsed.getTime())) throw new Error(REFERRAL_DISCOUNT_UNAVAILABLE);
  return parsed;
}

function getReferralCodeInput(request: BillingCheckoutRequest): string | null {
  if (request.referralCode == null || request.referralCode === "") return null;
  if (typeof request.referralCode !== "string") throw new Error(REFERRAL_DISCOUNT_UNAVAILABLE);
  const normalized = normalizeReferralCode(request.referralCode);
  if (!normalized) throw new Error(REFERRAL_DISCOUNT_UNAVAILABLE);
  return normalized;
}

function assertTestModeProviderObject(object: { livemode?: boolean }, label: string): void {
  if (object.livemode !== false) {
    throw new Error(`Referral discount ${label} must be a Stripe test-mode object`);
  }
}

function objectId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value && typeof (value as { id?: unknown }).id === "string") {
    return (value as { id: string }).id;
  }
  return null;
}

type StripeDiscountCompatibility = {
  coupon?: unknown;
  promotion_code?: unknown;
  promotionCode?: unknown;
};

type StripeInvoiceLineCompatibility = {
  discount?: unknown;
  discounts?: unknown[];
  price?: unknown;
};

type StripeInvoiceCompatibility = {
  discount?: unknown;
  discounts?: unknown[];
};

type StripePromotionCodeCompatibility = {
  promotion?: { coupon?: unknown } | string | null;
  coupon?: unknown;
};

type StripeFinancialObjectCompatibility = {
  livemode?: boolean;
  charge?: unknown;
  invoice?: unknown;
};

function collectInvoiceDiscountIds(invoice: Stripe.Invoice): { promotionCodeId: string | null; couponId: string | null } {
  const candidates: unknown[] = [];
  const compatibleInvoice = invoice as unknown as StripeInvoiceCompatibility;
  if (compatibleInvoice.discount) candidates.push(compatibleInvoice.discount);
  if (Array.isArray(compatibleInvoice.discounts)) candidates.push(...compatibleInvoice.discounts);
  for (const line of invoice.lines?.data ?? []) {
    const compatibleLine = line as unknown as StripeInvoiceLineCompatibility;
    if (Array.isArray(compatibleLine.discounts)) candidates.push(...compatibleLine.discounts);
    if (compatibleLine.discount) candidates.push(compatibleLine.discount);
  }
  let promotionCodeId: string | null = null;
  let couponId: string | null = null;
  for (const discount of candidates) {
    const compatibleDiscount = discount as StripeDiscountCompatibility | null | undefined;
    const promotion = compatibleDiscount?.promotion_code ?? compatibleDiscount?.promotionCode ?? null;
    const promotionCoupon = typeof promotion === "object" && promotion !== null && "coupon" in promotion
      ? (promotion as { coupon?: unknown }).coupon
      : null;
    const coupon = compatibleDiscount?.coupon ?? promotionCoupon ?? null;
    const promoId = objectId(promotion);
    const candidateCouponId = objectId(coupon);
    if (promoId) promotionCodeId = promotionCodeId && promotionCodeId !== promoId ? "__mixed__" : promoId;
    if (candidateCouponId) couponId = couponId && couponId !== candidateCouponId ? "__mixed__" : candidateCouponId;
  }
  return { promotionCodeId, couponId };
}

function assertReferralProviderRequestPayload(value: Record<string, unknown>): ReferralCheckoutProviderRequest {
  const payload = value as Partial<ReferralCheckoutProviderRequest>;
  if (
    payload.apiVersion !== REFERRAL_STRIPE_API_VERSION
    || payload.mode !== "subscription"
    || typeof payload.successUrl !== "string"
    || typeof payload.cancelUrl !== "string"
    || typeof payload.clientReferenceId !== "string"
    || !(payload.customer === null || typeof payload.customer === "string")
    || !Array.isArray(payload.discounts)
    || !Array.isArray(payload.lineItems)
    || !payload.metadata
    || typeof payload.metadata !== "object"
    || !payload.subscriptionData
    || typeof payload.subscriptionData !== "object"
    || typeof payload.reservationExpiresAt !== "string"
  ) {
    throw new Error(REFERRAL_DISCOUNT_UNAVAILABLE);
  }
  return payload as ReferralCheckoutProviderRequest;
}

function stripeCheckoutCreateParamsFromReferralRequest(
  payload: Record<string, unknown>,
): Stripe.Checkout.SessionCreateParams {
  const request = assertReferralProviderRequestPayload(payload);
  return {
    mode: request.mode,
    success_url: request.successUrl,
    cancel_url: request.cancelUrl,
    client_reference_id: request.clientReferenceId,
    customer: request.customer ?? undefined,
    discounts: request.discounts,
    line_items: request.lineItems,
    metadata: request.metadata,
    subscription_data: request.subscriptionData,
  };
}

function providerLastResponse(object: unknown): { apiVersion?: string; requestId?: string } {
  const lastResponse = (object as { lastResponse?: { apiVersion?: string; requestId?: string } })?.lastResponse;
  return lastResponse ?? {};
}

function assertReferralProviderApiVersion(object: unknown, label: string): void {
  if (providerLastResponse(object).apiVersion !== REFERRAL_STRIPE_API_VERSION) {
    throw new Error(`Referral provider ${label} API version mismatch.`);
  }
}

function assertReferralProviderTestMode(object: unknown, label: string): void {
  if ((object as { livemode?: boolean }).livemode !== false) {
    throw new Error(`Referral provider ${label} is not test mode.`);
  }
}

function providerRequestId(object: unknown): string | null {
  return providerLastResponse(object).requestId ?? null;
}

function isStripeNotFound(error: unknown): boolean {
  const candidate = error as { statusCode?: number; code?: string };
  return candidate?.statusCode === 404 || candidate?.code === "resource_missing";
}

function secondsOrNull(date: Date | string | null): number | null {
  if (!date) return null;
  return Math.floor(new Date(date).getTime() / 1000);
}

function deterministicReferralCouponId(campaignId: string): string {
  return `raft_ref_coupon_${campaignId.replace(/-/g, "")}`;
}

function deterministicReferralPromotionCode(codeId: string): string {
  return `RAFTREF${codeId.replace(/-/g, "").slice(0, 24).toUpperCase()}`;
}

function couponCreateParamsFromReferralRequest(request: ReferralCouponProviderRequest): Stripe.CouponCreateParams {
  return {
    id: request.couponId,
    percent_off: request.percentOff,
    duration: request.duration,
    duration_in_months: request.durationMonths,
    max_redemptions: request.maxRedemptions ?? undefined,
    redeem_by: request.redeemBy ?? undefined,
    metadata: request.metadata,
  };
}

function promotionCodeCreateParamsFromReferralRequest(request: ReferralPromotionProviderRequest): Stripe.PromotionCodeCreateParams {
  return {
    code: request.providerPromotionCode,
    promotion: {
      type: "coupon",
      coupon: request.couponId,
    },
    active: true,
    max_redemptions: request.maxRedemptions ?? undefined,
    expires_at: request.expiresAt ?? undefined,
    metadata: request.metadata,
  } as Stripe.PromotionCodeCreateParams;
}

function assertReferralCouponReadback(coupon: Stripe.Coupon, request: ReferralCouponProviderRequest): void {
  assertReferralProviderApiVersion(coupon, "coupon");
  assertReferralProviderTestMode(coupon, "coupon");
  if (
    coupon.id !== request.couponId
    || coupon.percent_off !== request.percentOff
    || coupon.duration !== request.duration
    || coupon.duration_in_months !== request.durationMonths
    || (coupon.max_redemptions ?? null) !== request.maxRedemptions
    || (coupon.redeem_by ?? null) !== request.redeemBy
    || coupon.metadata?.raft_use !== REFERRAL_PROVIDER_USE
    || coupon.metadata?.referral_campaign_id !== request.campaignId
    || coupon.metadata?.provider_strategy !== request.providerStrategy
  ) {
    throw new Error("Referral coupon provider readback mismatch.");
  }
}

function promotionCouponId(promotionCode: Stripe.PromotionCode): string | null {
  const compatiblePromotionCode = promotionCode as unknown as StripePromotionCodeCompatibility;
  const promotion = compatiblePromotionCode.promotion;
  const promotionCoupon = typeof promotion === "object" && promotion !== null ? promotion.coupon : null;
  const coupon = promotionCoupon ?? compatiblePromotionCode.coupon;
  return objectId(coupon);
}

function assertReferralPromotionReadback(promotionCode: Stripe.PromotionCode, request: ReferralPromotionProviderRequest): void {
  assertReferralProviderApiVersion(promotionCode, "promotion code");
  assertReferralProviderTestMode(promotionCode, "promotion code");
  if (
    promotionCode.code !== request.providerPromotionCode
    || promotionCode.active !== true
    || promotionCouponId(promotionCode) !== request.couponId
    || (promotionCode.max_redemptions ?? null) !== request.maxRedemptions
    || (promotionCode.expires_at ?? null) !== request.expiresAt
    || promotionCode.metadata?.raft_use !== REFERRAL_PROVIDER_USE
    || promotionCode.metadata?.referral_campaign_id !== request.campaignId
    || promotionCode.metadata?.referral_code_id !== request.codeId
    || promotionCode.metadata?.referral_referrer_user_id !== request.referrerUserId
    || promotionCode.metadata?.provider_strategy !== request.providerStrategy
  ) {
    throw new Error("Referral promotion-code provider readback mismatch.");
  }
}

async function rememberReferralProviderOperationObject(
  operationId: string,
  providerObjectId: string,
  providerRequestId: string | null,
  executor: DatabaseExecutor,
) {
  const [current] = await executor.select().from(referralDiscountProviderOperations)
    .where(eq(referralDiscountProviderOperations.id, operationId))
    .limit(1);
  if (!current) throw new Error(`Referral provider operation not found: ${operationId}`);
  if (current.providerObjectId && current.providerObjectId !== providerObjectId) {
    throw new Error("Referral provider operation returned a different provider object.");
  }
  await executor.update(referralDiscountProviderOperations).set({
    providerObjectId,
    providerRequestId: providerRequestId ?? current.providerRequestId,
    updatedAt: new Date(),
  }).where(eq(referralDiscountProviderOperations.id, operationId));
}

export function referralStripeAcceptanceAuthorizationFromEnv(env: NodeJS.ProcessEnv = process.env):
  | { status: "not_run"; reason: typeof REFERRAL_ACCEPTANCE_NOT_RUN }
  | ReferralProviderAuthorizationReceipt {
  const expectedAccountId = env.REFERRAL_DISCOUNT_STRIPE_EXPECTED_ACCOUNT_ID?.trim();
  const profile = env.REFERRAL_DISCOUNT_STRIPE_PROFILE?.trim();
  const key = env.REFERRAL_DISCOUNT_STRIPE_SECRET_KEY?.trim();
  if (env.REFERRAL_DISCOUNT_STRIPE_ACCEPTANCE !== "1" || !expectedAccountId || !profile || !key) {
    return { status: "not_run", reason: REFERRAL_ACCEPTANCE_NOT_RUN };
  }
  if (!key.startsWith("sk_test_")) {
    return { status: "not_run", reason: REFERRAL_ACCEPTANCE_NOT_RUN };
  }
  return {
    [referralProviderAuthorizationBrand]: true,
    expectedAccountId,
    profile,
    authorizedAt: new Date(currentTimeMs()).toISOString(),
  } as ReferralProviderAuthorizationReceipt;
}

function createReferralStripeFromAuthorizationEnv(env: NodeJS.ProcessEnv, authorization: ReferralProviderAuthorizationReceipt): ReferralProviderStripe {
  const key = env.REFERRAL_DISCOUNT_STRIPE_SECRET_KEY?.trim();
  if (!key || !key.startsWith("sk_test_")) {
    throw new Error("Referral provider authorization key is not available.");
  }
  const stripe = new Stripe(key, { apiVersion: REFERRAL_STRIPE_API_VERSION }) as ReferralProviderStripe;
  stripe.__referralProfile = authorization.profile;
  return stripe;
}

function referralAcceptanceDiagnosticLocator(couponId: string, env: NodeJS.ProcessEnv): string {
  const key = env.REFERRAL_DISCOUNT_DIAGNOSTIC_KEY?.trim() || env.REFERRAL_DISCOUNT_STRIPE_SECRET_KEY?.trim();
  if (!key) {
    throw new Error("Referral duration acceptance diagnostic key is not available.");
  }
  const digest = createHmac("sha256", key)
    .update(`referral-duration-acceptance-diagnostic:${couponId}`)
    .digest("base64url")
    .slice(0, 16);
  return `coupon:raft_ref_accept_[redacted]:${digest}`;
}

function isReferralProviderNotFound(error: unknown): boolean {
  const candidate = error as { statusCode?: unknown; code?: unknown };
  return candidate?.statusCode === 404 || candidate?.code === "resource_missing";
}

const REFERRAL_ACCEPTANCE_ERROR_BOUND = 320;
const REFERRAL_ACCEPTANCE_CONTEXT_BOUND = 96;

function sanitizeReferralAcceptanceErrorMessage(error: unknown, couponId: string, locator: string): string {
  const raw = error instanceof Error ? error.message : "unknown provider failure";
  return raw
    .replaceAll(couponId, locator)
    .replace(/raft_ref_accept_[A-Za-z0-9_-]+/g, locator)
    .replace(/sk_(test|live)_[A-Za-z0-9_]+/g, "[redacted-stripe-key]")
    .replace(/[A-Za-z0-9][A-Za-z0-9_-]{24,}/g, "[redacted-token]")
    .slice(0, REFERRAL_ACCEPTANCE_CONTEXT_BOUND);
}

function referralDurationAcceptanceError(primary: unknown, contexts: string[], couponId: string, env: NodeJS.ProcessEnv): Error {
  const locator = referralAcceptanceDiagnosticLocator(couponId, env);
  const message = [
    sanitizeReferralAcceptanceErrorMessage(primary, couponId, locator),
    ...contexts.map((context) => context.slice(0, REFERRAL_ACCEPTANCE_CONTEXT_BOUND)),
  ].filter(Boolean).join("; ").slice(0, REFERRAL_ACCEPTANCE_ERROR_BOUND);
  return new Error(message);
}

export async function proveReferralStripeAccountForTests(
  stripe: Pick<ReferralProviderStripe, "accounts" | "balance">,
  expectedAccountId: string,
): Promise<{ status: "ok"; accountId: string; livemode: false; apiVersion: typeof REFERRAL_STRIPE_API_VERSION }> {
  const account = await stripe.accounts.retrieve();
  assertReferralProviderApiVersion(account, "account");
  if (account.id !== expectedAccountId) {
    throw new Error("Referral provider account id mismatch.");
  }
  const balance = await stripe.balance.retrieve();
  assertReferralProviderApiVersion(balance, "balance");
  assertReferralProviderTestMode(balance, "balance");
  return { status: "ok", accountId: account.id, livemode: false, apiVersion: REFERRAL_STRIPE_API_VERSION };
}

async function proveReferralProviderWriteAuthorizationForTests(
  stripe: Pick<ReferralProviderStripe, "accounts" | "balance"> & { __referralProfile?: string },
  authorization: ReferralProviderAuthorizationReceipt,
) {
  if (!(referralProviderAuthorizationBrand in authorization)) {
    throw new Error("Referral provider authorization receipt is required.");
  }
  if (!authorization.profile.trim()) throw new Error("Referral provider profile is required.");
  if (stripe.__referralProfile !== authorization.profile) {
    throw new Error("Referral provider profile does not match the selected client.");
  }
  return proveReferralStripeAccountForTests(stripe, authorization.expectedAccountId);
}

export async function runReferralStripeAccountAcceptanceForTests(
  stripe: Pick<ReferralProviderStripe, "accounts" | "balance"> & { __referralProfile?: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ status: "not_run"; reason: typeof REFERRAL_ACCEPTANCE_NOT_RUN } | Awaited<ReturnType<typeof proveReferralStripeAccountForTests>>> {
  const authorization = referralStripeAcceptanceAuthorizationFromEnv(env);
  if ("status" in authorization) return authorization;
  return proveReferralProviderWriteAuthorizationForTests(stripe, authorization);
}

export async function runReferralProviderProvisioningReadinessForTests(
  env: NodeJS.ProcessEnv = process.env,
  stripeFactory: ReferralProviderStripeFactory = createReferralStripeFromAuthorizationEnv,
): Promise<{ status: "not_run"; reason: typeof REFERRAL_ACCEPTANCE_NOT_RUN } | ReferralProviderAuthorizationReceipt> {
  const authorization = referralStripeAcceptanceAuthorizationFromEnv(env);
  if ("status" in authorization) return authorization;
  const stripe = stripeFactory(env, authorization);
  await proveReferralProviderWriteAuthorizationForTests(stripe, authorization);
  return authorization;
}

export async function runReferralDurationAcceptanceForTests(
  env: NodeJS.ProcessEnv = process.env,
  stripeFactory: ReferralProviderStripeFactory = createReferralStripeFromAuthorizationEnv,
): Promise<
  | { status: "not_run"; reason: typeof REFERRAL_ACCEPTANCE_NOT_RUN }
  | { status: "ok"; couponId: string; cleanup: "confirmed"; apiVersion: typeof REFERRAL_STRIPE_API_VERSION }
> {
  const authorization = referralStripeAcceptanceAuthorizationFromEnv(env);
  if ("status" in authorization) return authorization;
  const stripe = stripeFactory(env, authorization);
  await proveReferralProviderWriteAuthorizationForTests(stripe, authorization);
  const suffix = randomUUID().replace(/-/g, "");
  const couponId = `raft_ref_accept_${suffix}`;
  const request: ReferralCouponProviderRequest = {
    apiVersion: REFERRAL_STRIPE_API_VERSION,
    providerStrategy: REFERRAL_PROVIDER_STRATEGY,
    campaignId: `acceptance-${suffix}`,
    couponId,
    percentOff: 1,
    duration: "repeating",
    durationMonths: 1,
    currency: "usd",
    productScope: "pro",
    billingIntervalScope: "both",
    maxRedemptions: 1,
    redeemBy: null,
    metadata: {
      raft_use: REFERRAL_PROVIDER_USE,
      referral_campaign_id: `acceptance-${suffix}`,
      provider_strategy: REFERRAL_PROVIDER_STRATEGY,
      product_scope: "pro",
      billing_interval_scope: "both",
    },
  };
  let cleanupRequired = false;
  let primaryError: unknown = null;
  const errorContexts: string[] = [];
  try {
    try {
      const created = await stripe.coupons.create(couponCreateParamsFromReferralRequest(request), {
        idempotencyKey: `referral-duration-acceptance:${couponId}`,
      });
      cleanupRequired = true;
      assertReferralCouponReadback(created, request);
    } catch (error) {
      primaryError = error;
      try {
        const existing = await stripe.coupons.retrieve(couponId);
        cleanupRequired = true;
        assertReferralCouponReadback(existing, request);
      } catch (retrieveError) {
        if (isReferralProviderNotFound(retrieveError)) {
          throw referralDurationAcceptanceError(primaryError, errorContexts, couponId, env);
        }
        const locator = referralAcceptanceDiagnosticLocator(couponId, env);
        errorContexts.push(`reconciliation unconfirmed: ${sanitizeReferralAcceptanceErrorMessage(retrieveError, couponId, locator)}`);
      }
      throw referralDurationAcceptanceError(primaryError, errorContexts, couponId, env);
    }
    try {
      const readback = await stripe.coupons.retrieve(couponId);
      cleanupRequired = true;
      assertReferralCouponReadback(readback, request);
    } catch (error) {
      primaryError = error;
      throw referralDurationAcceptanceError(primaryError, errorContexts, couponId, env);
    }
    return { status: "ok", couponId, cleanup: "confirmed", apiVersion: REFERRAL_STRIPE_API_VERSION };
  } finally {
    if (cleanupRequired) {
      try {
        const deleted = await stripe.coupons.del(couponId);
        assertReferralProviderApiVersion(deleted, "deleted coupon");
        if (deleted.id !== couponId || deleted.deleted !== true) {
          throw new Error("Referral duration acceptance cleanup mismatch.");
        }
      } catch (cleanupError) {
        const locator = referralAcceptanceDiagnosticLocator(couponId, env);
        const cleanupContext = `cleanup unconfirmed for ${locator}`;
        if (primaryError) {
          throw referralDurationAcceptanceError(primaryError, [...errorContexts, cleanupContext], couponId, env);
        }
        throw new Error(`Referral duration acceptance ${cleanupContext}`);
      }
    }
  }
}

export async function provisionReferralCampaignCouponForTests(
  campaignId: string,
  stripe: Pick<ReferralProviderStripe, "accounts" | "balance" | "coupons"> & { __referralProfile?: string },
  authorization: ReferralProviderAuthorizationReceipt,
  executor: DatabaseExecutor = getDb(),
) {
  await proveReferralProviderWriteAuthorizationForTests(stripe, authorization);
  const { operation } = await executor.transaction(async (tx) => {
    const [campaign] = await tx.select().from(referralDiscountCampaigns)
      .where(eq(referralDiscountCampaigns.id, campaignId))
      .for("update")
      .limit(1);
    if (!campaign) throw new Error(`Referral campaign not found: ${campaignId}`);
    if (campaign.providerStrategy !== REFERRAL_PROVIDER_STRATEGY) {
      throw new Error("Referral campaign provider strategy mismatch.");
    }
    const couponId = deterministicReferralCouponId(campaign.id);
    const request: ReferralCouponProviderRequest = {
      apiVersion: REFERRAL_STRIPE_API_VERSION,
      providerStrategy: REFERRAL_PROVIDER_STRATEGY,
      campaignId: campaign.id,
      couponId,
      percentOff: campaign.percentOff,
      duration: "repeating",
      durationMonths: campaign.durationMonths,
      currency: campaign.currency,
      productScope: campaign.productScope,
      billingIntervalScope: campaign.billingIntervalScope,
      maxRedemptions: campaign.maxPaidRedemptions,
      redeemBy: secondsOrNull(campaign.expiresAt),
      metadata: {
        raft_use: REFERRAL_PROVIDER_USE,
        referral_campaign_id: campaign.id,
        provider_strategy: REFERRAL_PROVIDER_STRATEGY,
        product_scope: campaign.productScope,
        billing_interval_scope: campaign.billingIntervalScope,
      },
    };
    const operation = await beginReferralProviderOperation({
      environment: "stripe",
      livemode: false,
      operationType: "campaign_coupon_create",
      localTargetId: campaign.id,
      idempotencyKey: `referral-coupon:${campaign.id}:${REFERRAL_STRIPE_API_VERSION}`,
      requestFingerprint: fingerprintReferralProviderRequest(request),
      requestPayload: request,
    }, tx);
    await tx.update(referralDiscountCampaigns).set({
      providerState: "pending",
      providerProvisioningStartedAt: sql`COALESCE(${referralDiscountCampaigns.providerProvisioningStartedAt}, now())`,
      providerErrorCode: null,
      providerErrorMessage: null,
      updatedAt: new Date(),
    }).where(eq(referralDiscountCampaigns.id, campaign.id));
    return { operation };
  });
  const request = operation.requestPayload as ReferralCouponProviderRequest;

  try {
    let providerObjectId = operation.providerObjectId;
    if (!providerObjectId) {
      if (operation.state !== "intent") {
        try {
          const existing = await stripe.coupons.retrieve(request.couponId);
          assertReferralCouponReadback(existing, request);
          providerObjectId = existing.id;
          await rememberReferralProviderOperationObject(operation.id, providerObjectId, providerRequestId(existing), executor);
        } catch (error) {
          if (!isStripeNotFound(error)) throw error;
        }
      }
      if (!providerObjectId) {
        await markReferralProviderOperationStarted(operation.id, {}, executor);
        const created = await stripe.coupons.create(couponCreateParamsFromReferralRequest(request), { idempotencyKey: operation.idempotencyKey });
        providerObjectId = created.id;
        await rememberReferralProviderOperationObject(operation.id, providerObjectId, providerRequestId(created), executor);
      }
    }
    const readback = await stripe.coupons.retrieve(providerObjectId);
    assertReferralCouponReadback(readback, request);
    await executor.transaction(async (tx) => {
      await confirmReferralProviderOperation(operation.id, {
        providerObjectId: readback.id,
        providerRequestId: providerRequestId(readback),
      }, tx);
      await tx.update(referralDiscountCampaigns).set({
        providerState: "ready",
        stripeCouponId: readback.id,
        providerSyncedAt: new Date(),
        providerErrorCode: null,
        providerErrorMessage: null,
        updatedAt: new Date(),
      }).where(eq(referralDiscountCampaigns.id, campaignId));
    });
    return readback;
  } catch (error) {
    await parkReferralProviderOperation(operation.id, {
      code: "provider_operation_ambiguous",
      message: error instanceof Error ? error.message : "Referral coupon provider operation requires same-key replay.",
    }, executor).catch(() => undefined);
    throw error;
  }
}

export async function provisionReferralCodePromotionForTests(
  codeId: string,
  stripe: Pick<ReferralProviderStripe, "accounts" | "balance" | "promotionCodes"> & { __referralProfile?: string },
  authorization: ReferralProviderAuthorizationReceipt,
  executor: DatabaseExecutor = getDb(),
) {
  await proveReferralProviderWriteAuthorizationForTests(stripe, authorization);
  const { operation } = await executor.transaction(async (tx) => {
    const [row] = await tx.select({
      code: referralDiscountCodes,
      campaign: referralDiscountCampaigns,
    })
      .from(referralDiscountCodes)
      .innerJoin(referralDiscountCampaigns, eq(referralDiscountCampaigns.id, referralDiscountCodes.campaignId))
      .where(eq(referralDiscountCodes.id, codeId))
      .for("update")
      .limit(1);
    if (!row) throw new Error(`Referral code not found: ${codeId}`);
    if (row.campaign.providerState !== "ready" || !row.campaign.stripeCouponId) {
      throw new Error("Referral campaign coupon is not provider-ready.");
    }
    if (row.campaign.providerStrategy !== REFERRAL_PROVIDER_STRATEGY) {
      throw new Error("Referral campaign provider strategy mismatch.");
    }
    const request: ReferralPromotionProviderRequest = {
      apiVersion: REFERRAL_STRIPE_API_VERSION,
      providerStrategy: REFERRAL_PROVIDER_STRATEGY,
      codeId: row.code.id,
      campaignId: row.campaign.id,
      referrerUserId: row.code.referrerUserId,
      couponId: row.campaign.stripeCouponId,
      providerPromotionCode: deterministicReferralPromotionCode(row.code.id),
      maxRedemptions: row.code.maxPaidRedemptions,
      expiresAt: secondsOrNull(row.code.expiresAt),
      metadata: {
        raft_use: REFERRAL_PROVIDER_USE,
        referral_campaign_id: row.campaign.id,
        referral_code_id: row.code.id,
        referral_referrer_user_id: row.code.referrerUserId,
        provider_strategy: REFERRAL_PROVIDER_STRATEGY,
      },
    };
    const operation = await beginReferralProviderOperation({
      environment: "stripe",
      livemode: false,
      operationType: "code_promotion_create",
      localTargetId: row.code.id,
      idempotencyKey: `referral-promotion:${row.code.id}:${REFERRAL_STRIPE_API_VERSION}`,
      requestFingerprint: fingerprintReferralProviderRequest(request),
      requestPayload: request,
    }, tx);
    await tx.update(referralDiscountCodes).set({
      providerState: "pending",
      providerProvisioningStartedAt: sql`COALESCE(${referralDiscountCodes.providerProvisioningStartedAt}, now())`,
      providerErrorCode: null,
      providerErrorMessage: null,
      updatedAt: new Date(),
    }).where(eq(referralDiscountCodes.id, row.code.id));
    return { operation };
  });
  const request = operation.requestPayload as ReferralPromotionProviderRequest;

  try {
    let providerObjectId = operation.providerObjectId;
    if (!providerObjectId) {
      await markReferralProviderOperationStarted(operation.id, {}, executor);
      const created = await stripe.promotionCodes.create(promotionCodeCreateParamsFromReferralRequest(request), { idempotencyKey: operation.idempotencyKey });
      providerObjectId = created.id;
      await rememberReferralProviderOperationObject(operation.id, providerObjectId, providerRequestId(created), executor);
    }
    const readback = await stripe.promotionCodes.retrieve(providerObjectId, { expand: ["promotion.coupon"] });
    assertReferralPromotionReadback(readback, request);
    await executor.transaction(async (tx) => {
      await confirmReferralProviderOperation(operation.id, {
        providerObjectId: readback.id,
        providerRequestId: providerRequestId(readback),
      }, tx);
      await tx.update(referralDiscountCodes).set({
        providerState: "ready",
        stripePromotionCodeId: readback.id,
        providerSyncedAt: new Date(),
        providerErrorCode: null,
        providerErrorMessage: null,
        updatedAt: new Date(),
      }).where(eq(referralDiscountCodes.id, codeId));
    });
    return readback;
  } catch (error) {
    await parkReferralProviderOperation(operation.id, {
      code: "provider_operation_ambiguous",
      message: error instanceof Error ? error.message : "Referral promotion provider operation requires same-key replay.",
    }, executor).catch(() => undefined);
    throw error;
  }
}

export async function __invokeReferralCheckoutProviderForTests(
  stripe: Pick<Stripe, "checkout">,
  referral: Pick<ReferralCheckoutContext, "operationState" | "providerObjectId" | "idempotencyKey" | "requestPayload">,
): Promise<Stripe.Checkout.Session> {
  if (referral.operationState === "confirmed") {
    if (!referral.providerObjectId) {
      throw new Error("Confirmed referral checkout operation is missing its provider object.");
    }
    return stripe.checkout.sessions.retrieve(referral.providerObjectId);
  }
  return stripe.checkout.sessions.create(
    stripeCheckoutCreateParamsFromReferralRequest(referral.requestPayload),
    { idempotencyKey: referral.idempotencyKey },
  );
}

function invoiceLinePriceIdsWithDiscount(invoice: Stripe.Invoice, expectedPromotionCodeId: string, expectedCouponId: string): string[] {
  return (invoice.lines?.data ?? [])
    .filter((line) => {
      const ids = collectInvoiceDiscountIds({ ...invoice, lines: { ...invoice.lines, data: [line] } } as Stripe.Invoice);
      return ids.promotionCodeId === expectedPromotionCodeId && ids.couponId === expectedCouponId;
    })
    .map((line) => objectId((line as unknown as StripeInvoiceLineCompatibility).price))
    .filter((id): id is string => Boolean(id));
}

async function prepareReferralCheckoutContext(
  serverId: string,
  userId: string,
  successUrl: string,
  cancelUrl: string,
  request: BillingCheckoutRequest,
  contract: CheckoutContract,
  existingCustomerId: string | null,
): Promise<ReferralCheckoutContext | null> {
  const normalizedCode = getReferralCodeInput(request);
  if (!normalizedCode) return null;
  if (referralCheckoutMode() !== "sandbox") {
    throw new Error(REFERRAL_DISCOUNT_UNAVAILABLE);
  }

  const decisionAt = new Date(currentTimeMs());
  const reservationExpiresAt = new Date(decisionAt.getTime() + 30 * 60 * 1000);
  const idempotencyKey = `referral-checkout:${randomUUID()}`;
  const reservationInput = {
    environment: "stripe",
    livemode: false,
    historyOriginAt: referralHistoryOriginAt(),
    decisionAt,
    normalizedCode,
    targetProductScope: "pro" as const,
    targetBillingInterval: contract.metadata.billingInterval as "monthly" | "annual",
    referrerUserId: null,
    redeemingUserId: userId,
    referredServerId: serverId,
    stripeCustomerId: existingCustomerId,
    reservationExpiresAt,
    referralCheckoutIdempotencyKey: idempotencyKey,
  };
  const reservation = await readActiveReferralReservationForCode(reservationInput)
    ?? await createReferralReservationForCode(reservationInput);
  if (!reservation.code.stripePromotionCodeId) {
    throw new Error(REFERRAL_DISCOUNT_UNAVAILABLE);
  }

  const metadata = buildReferralCheckoutMetadata({
    redemptionId: reservation.id,
    codeId: reservation.codeId,
    campaignId: reservation.campaignId,
    referrerUserId: reservation.referrerUserId,
    providerStrategy: reservation.campaign.providerStrategy || REFERRAL_PROVIDER_STRATEGY,
  });
  const fullMetadata = { ...contract.metadata, ...metadata };
  const fullSubscriptionData = {
    metadata: {
      ...contract.metadata,
      ...metadata,
    },
  };
  const canonicalReservationExpiresAt = new Date(reservation.reservationExpiresAt);
  const requestPayload: ReferralCheckoutProviderRequest = {
    apiVersion: REFERRAL_STRIPE_API_VERSION,
    mode: "subscription",
    successUrl,
    cancelUrl,
    clientReferenceId: serverId,
    customer: existingCustomerId,
    discounts: [{ promotion_code: reservation.code.stripePromotionCodeId }],
    lineItems: contract.lineItems,
    metadata: fullMetadata,
    subscriptionData: fullSubscriptionData,
    reservationExpiresAt: canonicalReservationExpiresAt.toISOString(),
  };
  const requestFingerprint = fingerprintReferralProviderRequest(requestPayload);
  const operation = await beginReferralProviderOperation({
    environment: "stripe",
    livemode: false,
    operationType: "checkout_session_create",
    localTargetId: reservation.id,
    idempotencyKey: reservation.referralCheckoutIdempotencyKey ?? idempotencyKey,
    requestFingerprint,
    requestPayload,
  });
  return {
    promotionCodeId: reservation.code.stripePromotionCodeId,
    redemptionId: reservation.id,
    operationId: operation.id,
    operationState: operation.state,
    providerObjectId: operation.providerObjectId,
    idempotencyKey: operation.idempotencyKey,
    requestPayload: operation.requestPayload,
    metadata,
  };
}

export async function previewReferralDiscount(
  serverId: string,
  userId: string,
  request: BillingCheckoutRequest,
) {
  const normalizedCode = getReferralCodeInput(request);
  if (!normalizedCode || referralCheckoutMode() !== "sandbox") throw new Error(REFERRAL_DISCOUNT_UNAVAILABLE);
  const decisionAt = new Date(currentTimeMs());
  const existing = await getSubscription(serverId);
  const preview = await previewReferralCode({
    environment: "stripe",
    livemode: false,
    historyOriginAt: referralHistoryOriginAt(),
    decisionAt,
    normalizedCode,
    redeemingUserId: userId,
    referredServerId: serverId,
    stripeCustomerId: existing?.stripeCustomerId ?? null,
    targetProductScope: "pro",
    targetBillingInterval: toBillingInterval(request.billingInterval ?? request.interval),
  });
  return {
    status: "preview" as const,
    percentOff: preview.percentOff,
    durationMonths: preview.durationMonths,
    billingIntervalScope: preview.billingIntervalScope,
    expiresAt: preview.expiresAt?.toISOString() ?? null,
    tentative: true,
  };
}

export async function createCheckoutSession(
  serverId: string,
  userId: string,
  successUrl: string,
  cancelUrl: string,
  request: BillingCheckoutRequest = {},
): Promise<string> {
  let referralOperationToPark: string | null = null;
  let referralRedemptionToRelease: string | null = null;
  let referralProviderInvoked = false;
  traceBillingEvent("billing.checkout.requested", {
    server_id: serverId,
    billing_trace_id: toBillingTraceId(request.billingTraceId),
    user_id_present: Boolean(userId),
    target_plan: typeof request.targetPlan === "string" ? request.targetPlan : "unknown",
    requested_seat_quantity: request.seatQuantity ?? request.packQuantity ?? request.proPackQuantity ?? null,
    ...traceStripeBillingState(),
  });
  try {
    if (!isStripeBillingFlagEnabled()) throw new Error("Billing is not configured (STRIPE_BILLING_ENABLED must be true)");
    const contract = buildCheckoutContract(request, userId, serverId);
    traceBillingEvent("billing.checkout.contract_built", {
      server_id: serverId,
      billing_trace_id: contract.metadata.billingTraceId ?? null,
      target_plan: contract.metadata.targetPlan,
      billing_interval: contract.metadata.billingInterval,
      pricing_contract: contract.metadata.pricingContract,
      seat_quantity: Number(contract.metadata.seatQuantity),
      requested_human_seats: Number(contract.metadata.humanSeatQuantity),
      requested_agent_seats: Number(contract.metadata.requestedAgentSeats),
      provisioned_human_seats: Number(contract.metadata.provisionedHumanSeats),
      provisioned_agent_seats: Number(contract.metadata.provisionedAgentSeats),
    });
    const existing = await getSubscription(serverId);
    const referral = await prepareReferralCheckoutContext(serverId, userId, successUrl, cancelUrl, request, contract, existing?.stripeCustomerId ?? null);
    referralOperationToPark = referral?.operationId ?? null;
    referralRedemptionToRelease = referral?.redemptionId ?? null;
    const stripe = referral ? getReferralStripe() : getStripe();
    if (referral && referral.operationState !== "confirmed") {
      await markReferralProviderOperationStarted(referral.operationId);
    }
    if (referral) {
      referralProviderInvoked = true;
    }
    const session = referral
      ? await __invokeReferralCheckoutProviderForTests(stripe, referral)
      : await stripe.checkout.sessions.create({
        mode: "subscription",
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: serverId,
        customer: existing?.stripeCustomerId,
        allow_promotion_codes: true,
        line_items: contract.lineItems,
        metadata: contract.metadata,
        subscription_data: contract.subscriptionData,
      });

    if (!session.url) {
      traceBillingEvent("billing.checkout.session.missing_url", {
        server_id: serverId,
        billing_trace_id: contract.metadata.billingTraceId ?? null,
      });
      throw new Error("Stripe Checkout did not return a URL");
    }
    if (referral) {
      assertTestModeProviderObject(session, "checkout session");
      await confirmReferralProviderOperation(referral.operationId, { providerObjectId: session.id });
      await markReferralCheckoutCreated(referral.redemptionId, {
        decisionAt: new Date(currentTimeMs()),
        stripeCheckoutSessionId: session.id,
        stripeCustomerId: getStripeCustomerId(session.customer),
        stripeSubscriptionId: typeof session.subscription === "string" ? session.subscription : null,
        reservationExpiresAt: session.expires_at ? new Date(session.expires_at * 1000) : new Date(currentTimeMs() + 30 * 60 * 1000),
      });
    }
    traceBillingEvent("billing.checkout.session.created", {
      server_id: serverId,
      billing_trace_id: contract.metadata.billingTraceId ?? null,
      existing_customer_present: Boolean(existing?.stripeCustomerId),
      promotion_codes_enabled: !referral,
      referral_discount_applied: Boolean(referral),
      stripe_session_url_present: Boolean(session.url),
      line_item_count: contract.lineItems.length,
    });
    return session.url;
  } catch (error) {
    traceBillingEvent("billing.checkout.failed", {
      server_id: serverId,
      billing_trace_id: toBillingTraceId(request.billingTraceId),
      stage: "checkout_session_create",
      ...traceAttrs.error(error),
    });
    if (referralOperationToPark) {
      if (!referralProviderInvoked && referralRedemptionToRelease) {
        await voidReferralReservation(referralRedemptionToRelease, "provider_preinvoke_failed").catch(() => undefined);
      }
      await parkReferralProviderOperation(referralOperationToPark, {
        code: referralProviderInvoked ? "provider_operation_ambiguous" : "provider_preinvoke_failed",
        message: referralProviderInvoked
          ? "Referral checkout provider operation requires same-key replay."
          : "Referral checkout failed before provider invocation.",
      }).catch(() => undefined);
    }
    throw error;
  }
}

// ── Existing Subscription Seat Quantity Updates ──

function subscriptionMetadataForSeatQuantity(
  stripeSub: Stripe.Subscription,
  seatQuantity: number,
  overrides: Partial<Record<string, string>> = {},
): Record<string, string> {
  const metadata = stripeSub.metadata ?? {};
  const provisionedAgentSeats = seatQuantity * PRO_AGENT_SEAT_BLOCK_SIZE;
  return {
    pricingContract: RAFT_PRO_SEAT_PRICING_CONTRACT,
    serverId: overrides.serverId ?? metadata.serverId ?? "",
    userId: overrides.userId ?? metadata.userId ?? "",
    targetPlan: "pro",
    billingInterval: overrides.billingInterval ?? metadata.billingInterval ?? DEFAULT_BILLING_INTERVAL,
    seatQuantity: String(seatQuantity),
    humanSeatQuantity: overrides.humanSeatQuantity ?? metadata.humanSeatQuantity ?? String(seatQuantity),
    requestedAgentSeats: overrides.requestedAgentSeats ?? metadata.requestedAgentSeats ?? "0",
    agentSeatBlockQuantity: String(calculateAgentSeatBlockQuantity(Number(overrides.requestedAgentSeats ?? metadata.requestedAgentSeats ?? 0))),
    provisionedHumanSeats: String(seatQuantity),
    provisionedAgentSeats: String(provisionedAgentSeats),
    proPackQuantity: String(seatQuantity),
    packQuantity: String(seatQuantity),
    stripeInitialPaidPackQuantity: String(seatQuantity),
    trialFreePackQuantity: "0",
  };
}

function getSubscriptionItemByPrice(stripeSub: Stripe.Subscription, priceId: string | undefined): Stripe.SubscriptionItem | null {
  if (!priceId) return null;
  return stripeSub.items.data.find((item) => item.price.id === priceId) ?? null;
}

function getProSeatSubscriptionItem(
  stripeSub: Stripe.Subscription,
  priceIds: Partial<StripePriceIds> = getConfiguredPriceIdsBestEffort(),
): Stripe.SubscriptionItem | null {
  return getSubscriptionItemByPrice(stripeSub, priceIds.proSeatMonthly)
    ?? getSubscriptionItemByPrice(stripeSub, priceIds.proSeatAnnual);
}

function billingIntervalFromPriceId(priceId: string | undefined, priceIds: Partial<StripePriceIds>): BillingInterval | null {
  if (!priceId) return null;
  if (priceIds.proSeatAnnual && priceId === priceIds.proSeatAnnual) return "annual";
  if (priceIds.proSeatMonthly && priceId === priceIds.proSeatMonthly) return "monthly";
  return null;
}

function billingIntervalFromStripeSubscription(
  stripeSub: Stripe.Subscription,
  priceIds: Partial<StripePriceIds> = getConfiguredPriceIdsBestEffort(),
): BillingInterval {
  const primaryItem = getProSeatSubscriptionItem(stripeSub, priceIds);
  const priceInterval = billingIntervalFromPriceId(primaryItem?.price.id, priceIds);
  if (priceInterval) return priceInterval;
  const recurringInterval = primaryItem?.price.recurring?.interval;
  if (recurringInterval === "year") return "annual";
  if (recurringInterval === "month") return "monthly";
  return normalizeBillingInterval(stripeSub.metadata?.billingInterval ?? DEFAULT_BILLING_INTERVAL);
}

function hasPendingUpdate(stripeSub: Stripe.Subscription): boolean {
  return stripeSub.pending_update != null;
}

const BILLING_SEAT_PREVIEW_TOKEN_VERSION = 1;
const BILLING_SEAT_PREVIEW_TTL_MS = 5 * 60 * 1000;
const BILLING_SEAT_PREVIEW_SIGNATURE_DOMAIN = "raft-billing-seat-preview-v1";
const BILLING_SEAT_PREVIEW_CONFIRM_DOMAIN = "raft-billing-seat-preview-confirm-v1";
let billingPreviewNow = currentTimeMs;

interface BillingSeatPreviewClaims {
  version: typeof BILLING_SEAT_PREVIEW_TOKEN_VERSION;
  serverId: string;
  userId: string;
  subscriptionId: string;
  itemId: string;
  currentPackQuantity: number;
  requestedPackQuantity: number;
  promotionCodeId: string | null;
  promotionCode: string | null;
  prorationDate: number;
  expiresAtMs: number;
}

export function __setBillingPreviewClockForTests(now: () => number): void {
  billingPreviewNow = now;
}

export function __resetBillingPreviewClockForTests(): void {
  billingPreviewNow = currentTimeMs;
}

function getBillingPreviewSigningSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) throw new Error("Billing preview signing is not configured (JWT_SECRET missing)");
  return secret;
}

function signBillingSeatPreviewClaims(claims: BillingSeatPreviewClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", getBillingPreviewSigningSecret())
    .update(`${BILLING_SEAT_PREVIEW_SIGNATURE_DOMAIN}.${payload}`)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function billingSeatPreviewConfirmIdempotencyKey(
  previewToken: unknown,
  operation: "reactivate" | "quantity",
): string {
  if (typeof previewToken !== "string") {
    throw new Error("Seat update preview is invalid or expired");
  }
  const digest = createHmac("sha256", getBillingPreviewSigningSecret())
    .update(`${BILLING_SEAT_PREVIEW_CONFIRM_DOMAIN}.${operation}.${previewToken}`)
    .digest("hex");
  return `billing-seat-preview-${operation}-${digest}`;
}

function isBillingSeatPreviewClaims(value: unknown): value is BillingSeatPreviewClaims {
  if (!value || typeof value !== "object") return false;
  const claims = value as Partial<BillingSeatPreviewClaims>;
  return claims.version === BILLING_SEAT_PREVIEW_TOKEN_VERSION
    && typeof claims.serverId === "string"
    && typeof claims.userId === "string"
    && typeof claims.subscriptionId === "string"
    && typeof claims.itemId === "string"
    && Number.isInteger(claims.currentPackQuantity)
    && Number.isInteger(claims.requestedPackQuantity)
    && (claims.promotionCodeId === null || typeof claims.promotionCodeId === "string")
    && (claims.promotionCode === null || typeof claims.promotionCode === "string")
    && Number.isInteger(claims.prorationDate)
    && Number.isInteger(claims.expiresAtMs);
}

function verifyBillingSeatPreviewToken(value: unknown): BillingSeatPreviewClaims {
  if (typeof value !== "string" || value.length < 32 || value.length > 4096) {
    throw new Error("Seat update preview is invalid or expired");
  }
  const dotIndex = value.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === value.length - 1) {
    throw new Error("Seat update preview is invalid or expired");
  }
  try {
    const payload = value.slice(0, dotIndex);
    const suppliedSignatureText = value.slice(dotIndex + 1);
    const suppliedSignature = Buffer.from(suppliedSignatureText, "base64url");
    const payloadBytes = Buffer.from(payload, "base64url");
    // Bind the exact encoded text, not just the decoded bytes: Node's base64url
    // decoder tolerates non-canonical spellings (unused low bits, stray padding,
    // '+'/'/' in place of '-'/'_'), which would otherwise let an altered token
    // pass timingSafeEqual and mint duplicate idempotency representations of one
    // signed claim.
    if (
      suppliedSignature.toString("base64url") !== suppliedSignatureText
      || payloadBytes.toString("base64url") !== payload
    ) {
      throw new Error();
    }
    const expectedSignature = createHmac("sha256", getBillingPreviewSigningSecret())
      .update(`${BILLING_SEAT_PREVIEW_SIGNATURE_DOMAIN}.${payload}`)
      .digest();
    if (suppliedSignature.length !== expectedSignature.length || !timingSafeEqual(suppliedSignature, expectedSignature)) {
      throw new Error();
    }
    const claims = JSON.parse(payloadBytes.toString("utf8")) as unknown;
    if (!isBillingSeatPreviewClaims(claims) || billingPreviewNow() >= claims.expiresAtMs) {
      throw new Error();
    }
    return claims;
  } catch {
    throw new Error("Seat update preview is invalid or expired");
  }
}

function normalizePromotionCode(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error("Promotion code must be a string");
  const code = value.trim();
  if (!/^[A-Za-z0-9-]{1,128}$/.test(code)) throw new Error("Promotion code is invalid");
  return code;
}

function stripeCustomerId(customer: string | Stripe.Customer | Stripe.DeletedCustomer): string {
  return typeof customer === "string" ? customer : customer.id;
}

function promotionCoupon(promotionCode: Stripe.PromotionCode): Stripe.Coupon {
  const coupon = promotionCode.promotion.coupon;
  if (!coupon || typeof coupon === "string" || "deleted" in coupon) {
    throw new Error("Promotion code is invalid or expired");
  }
  return coupon;
}

function promotionAllowsSeatUpdates(promotionCode: Stripe.PromotionCode, coupon: Stripe.Coupon): boolean {
  return promotionCode.metadata?.raft_use === "seat_update"
    || coupon.metadata?.raft_use === "seat_update";
}

function validateSeatUpdatePromotionCode(
  promotionCode: Stripe.PromotionCode,
  expectedCode: string,
  customerId: string,
  proSeatItem: Stripe.SubscriptionItem,
): Stripe.Coupon {
  const nowSeconds = Math.floor(billingPreviewNow() / 1000);
  const coupon = promotionCoupon(promotionCode);
  if (!promotionCode.active
    || promotionCode.code.toLowerCase() !== expectedCode.toLowerCase()
    || (promotionCode.expires_at != null && promotionCode.expires_at <= nowSeconds)
    || (promotionCode.max_redemptions != null && promotionCode.times_redeemed >= promotionCode.max_redemptions)
    || !coupon.valid
    || (coupon.redeem_by != null && coupon.redeem_by <= nowSeconds)
    || (coupon.max_redemptions != null && coupon.times_redeemed >= coupon.max_redemptions)) {
    throw new Error("Promotion code is invalid or expired");
  }
  if (promotionCode.customer && stripeCustomerId(promotionCode.customer) !== customerId) {
    throw new Error("Promotion code is not valid for this customer");
  }
  if (promotionCode.customer_account) {
    throw new Error("Promotion code is not valid for this customer");
  }
  if (promotionCode.restrictions.first_time_transaction) {
    throw new Error("First-purchase promotion codes cannot be used for seat updates");
  }
  if (promotionCode.restrictions.minimum_amount != null
    || Object.keys(promotionCode.restrictions.currency_options ?? {}).length > 0) {
    throw new Error("Minimum-purchase promotion codes cannot be used for seat updates");
  }
  if (!promotionAllowsSeatUpdates(promotionCode, coupon)) {
    throw new Error("Promotion code is not valid for seat updates");
  }
  const restrictedProducts = coupon.applies_to?.products ?? [];
  const priceProduct = proSeatItem.price.product;
  const priceProductId = typeof priceProduct === "string" ? priceProduct : priceProduct?.id;
  if (restrictedProducts.length > 0 && (!priceProductId || !restrictedProducts.includes(priceProductId))) {
    throw new Error("Promotion code does not apply to Pro seats");
  }
  return coupon;
}

async function resolveSeatUpdatePromotionCode(
  stripe: Stripe,
  code: string,
  customerId: string,
  proSeatItem: Stripe.SubscriptionItem,
): Promise<{ promotionCode: Stripe.PromotionCode; coupon: Stripe.Coupon }> {
  const customerScopedResult = await stripe.promotionCodes.list({
    active: true,
    code,
    customer: customerId,
    expand: ["data.promotion.coupon"],
    limit: 1,
  });
  let promotionCode = customerScopedResult.data.find((candidate) => candidate.code.toLowerCase() === code.toLowerCase()
    && candidate.customer != null
    && stripeCustomerId(candidate.customer) === customerId);
  if (!promotionCode) {
    const publicResult = await stripe.promotionCodes.list({
      active: true,
      code,
      expand: ["data.promotion.coupon"],
      limit: 100,
    });
    promotionCode = publicResult.data.find((candidate) => candidate.code.toLowerCase() === code.toLowerCase()
      && candidate.customer == null
      && candidate.customer_account == null);
  }
  if (!promotionCode) throw new Error("Promotion code is invalid or expired");
  return {
    promotionCode,
    coupon: validateSeatUpdatePromotionCode(promotionCode, code, customerId, proSeatItem),
  };
}

async function retrieveSeatUpdatePromotionCode(
  stripe: Stripe,
  promotionCodeId: string,
  expectedCode: string,
  customerId: string,
  proSeatItem: Stripe.SubscriptionItem,
): Promise<Stripe.PromotionCode> {
  const promotionCode = await stripe.promotionCodes.retrieve(promotionCodeId, {
    expand: ["promotion.coupon"],
  });
  if (promotionCode.id !== promotionCodeId) throw new Error("Promotion code is invalid or expired");
  validateSeatUpdatePromotionCode(promotionCode, expectedCode, customerId, proSeatItem);
  return promotionCode;
}

function subscriptionHasDiscounts(stripeSub: Stripe.Subscription, proSeatItem: Stripe.SubscriptionItem): boolean {
  return (Array.isArray(stripeSub.discounts) && stripeSub.discounts.length > 0)
    || (Array.isArray(proSeatItem.discounts) && proSeatItem.discounts.length > 0);
}

function prorationAmountFromInvoice(invoice: Stripe.Invoice): number {
  return invoice.lines.data.reduce((total, line) => {
    if (line.parent?.type !== "subscription_item_details" || line.parent.subscription_item_details?.proration !== true) {
      return total;
    }
    const taxAmount = (line.taxes ?? []).reduce((sum, tax) => sum + tax.amount, 0);
    return total + line.amount + taxAmount;
  }, 0);
}

function discountAmountFromInvoice(invoice: Stripe.Invoice): number {
  return (invoice.total_discount_amounts ?? []).reduce((total, discount) => total + discount.amount, 0);
}

export async function previewProPackQuantityUpdate(
  serverId: string,
  userId: string,
  request: BillingPackQuantityRequest,
): Promise<BillingPackQuantityPreviewResult> {
  traceBillingEvent("billing.seat_update.preview_requested", {
    server_id: serverId,
    user_id_present: Boolean(userId),
    requested_seat_quantity: traceRequestedSeatQuantity(request),
    promotion_code_present: request.promotionCode != null && request.promotionCode !== "",
    ...traceStripeBillingState(),
  });
  try {
    if (!isStripeBillingFlagEnabled()) throw new Error("Billing is not configured (STRIPE_BILLING_ENABLED must be true)");
    const requestedPackQuantity = toPositiveInteger(
      request.seatQuantity ?? request.packQuantity ?? request.proPackQuantity,
      "seatQuantity",
    );
    if (!requestedPackQuantity) throw new Error("seatQuantity is required");
    const promotionCodeInput = normalizePromotionCode(request.promotionCode);
    const sub = await getSubscription(serverId);
    if (!sub || !isEntitlingStatus(sub.status)) throw new Error("Server does not have an active Pro subscription");
    if (sub.plan !== "pro") throw new Error("Server does not have a Pro subscription");
    const currentPackQuantity = Math.max(1, sub.proPackQuantity);
    if (requestedPackQuantity <= currentPackQuantity) {
      throw new Error("Seat update preview is only available when adding seats");
    }
    const usage = await getServerBillingUsage(getDb(), serverId);
    const minimumSeatQuantity = Math.max(1, Math.ceil(usage.universalSeats));
    if (requestedPackQuantity < minimumSeatQuantity) {
      throw new Error(`seatQuantity must be at least ${minimumSeatQuantity} to cover current server usage`);
    }
    const stripe = getStripe();
    const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
    if (hasPendingUpdate(stripeSub)) throw new Error("A seat update is already pending Stripe payment confirmation");
    const proSeatItem = getProSeatSubscriptionItem(stripeSub, getStripePriceIds());
    if (!proSeatItem) throw new Error("Server does not have a Pro Seat subscription item");
    if ((proSeatItem.quantity ?? 0) !== currentPackQuantity) {
      throw new Error("Seat update changed after preview; review the latest price before confirming");
    }
    const customerId = stripeCustomerId(stripeSub.customer);
    if (promotionCodeInput && subscriptionHasDiscounts(stripeSub, proSeatItem)) {
      throw new Error("This subscription already has a discount; it will not be replaced automatically");
    }
    const resolvedPromotion = promotionCodeInput
      ? await resolveSeatUpdatePromotionCode(stripe, promotionCodeInput, customerId, proSeatItem)
      : null;
    const discounts = resolvedPromotion
      ? [{ promotion_code: resolvedPromotion.promotionCode.id }]
      : undefined;
    const prorationDate = Math.floor(billingPreviewNow() / 1000);
    const items = [{ id: proSeatItem.id, quantity: requestedPackQuantity }];
    const nextInvoice = await stripe.invoices.createPreview({
      customer: customerId,
      subscription: sub.stripeSubscriptionId,
      ...(discounts ? { discounts } : {}),
      subscription_details: {
        items,
        proration_behavior: "always_invoice",
        proration_date: prorationDate,
      },
    });
    const recurringInvoice = await stripe.invoices.createPreview({
      customer: customerId,
      subscription: sub.stripeSubscriptionId,
      ...(discounts ? { discounts } : {}),
      preview_mode: "recurring",
      subscription_details: { items },
    });
    if (nextInvoice.currency !== recurringInvoice.currency) {
      throw new Error("Stripe returned inconsistent preview currencies");
    }
    const expiresAtMs = billingPreviewNow() + BILLING_SEAT_PREVIEW_TTL_MS;
    const claims: BillingSeatPreviewClaims = {
      version: BILLING_SEAT_PREVIEW_TOKEN_VERSION,
      serverId,
      userId,
      subscriptionId: sub.stripeSubscriptionId,
      itemId: proSeatItem.id,
      currentPackQuantity,
      requestedPackQuantity,
      promotionCodeId: resolvedPromotion?.promotionCode.id ?? null,
      promotionCode: resolvedPromotion?.promotionCode.code ?? null,
      prorationDate,
      expiresAtMs,
    };
    return {
      status: "preview",
      currentPackQuantity,
      requestedPackQuantity,
      currency: nextInvoice.currency,
      prorationAmount: prorationAmountFromInvoice(nextInvoice),
      recurringAmount: recurringInvoice.total,
      discountAmount: discountAmountFromInvoice(recurringInvoice),
      promotion: resolvedPromotion
        ? {
            code: resolvedPromotion.promotionCode.code,
            name: resolvedPromotion.coupon.name,
            percentOff: resolvedPromotion.coupon.percent_off,
            amountOff: resolvedPromotion.coupon.amount_off,
            currency: resolvedPromotion.coupon.currency,
          }
        : null,
      previewToken: signBillingSeatPreviewClaims(claims),
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  } catch (error) {
    traceBillingEvent("billing.seat_update.preview_failed", {
      server_id: serverId,
      requested_seat_quantity: traceRequestedSeatQuantity(request),
      ...traceAttrs.error(error),
    });
    throw error;
  }
}

export async function updateProPackQuantity(
  serverId: string,
  userId: string,
  request: BillingPackQuantityRequest,
): Promise<BillingPackQuantityUpdateResult> {
  traceBillingEvent("billing.seat_update.requested", {
    server_id: serverId,
    user_id_present: Boolean(userId),
    requested_seat_quantity: traceRequestedSeatQuantity(request),
    requested_human_seats: request.humanSeatQuantity ?? request.humanSeats ?? request.provisionedHumanSeats ?? null,
    requested_agent_seats: request.agentSeatQuantity ?? request.agentSeats ?? request.provisionedAgentSeats ?? null,
    ...traceStripeBillingState(),
  });
  try {
  if (!isStripeBillingFlagEnabled()) throw new Error("Billing is not configured (STRIPE_BILLING_ENABLED must be true)");
  const requestedSeatQuantity = toPositiveInteger(request.seatQuantity ?? request.packQuantity ?? request.proPackQuantity, "seatQuantity") ?? null;
  const requestedHumanSeatQuantity = toPositiveInteger(
    request.humanSeatQuantity ?? request.humanSeats ?? request.provisionedHumanSeats,
    "humanSeatQuantity",
  );
  const requestedAgentSeats = requestedSeatQuantity != null
    ? requestedSeatQuantity * PRO_AGENT_SEAT_BLOCK_SIZE
    : toNonNegativeInteger(
      request.agentSeatQuantity ?? request.agentSeats ?? request.provisionedAgentSeats,
      "agentSeatQuantity",
    );
  const promotionCodeInput = normalizePromotionCode(request.promotionCode);
  if (promotionCodeInput && request.previewToken == null) {
    throw new Error("Preview the promotion code before confirming the seat update");
  }
  const previewClaims = request.previewToken == null
    ? null
    : verifyBillingSeatPreviewToken(request.previewToken);
  if (previewClaims && promotionCodeInput
    && previewClaims.promotionCode?.toLowerCase() !== promotionCodeInput.toLowerCase()) {
    throw new Error("Seat update preview is invalid or expired");
  }

  const sub = await getSubscription(serverId);
  if (!sub || !isEntitlingStatus(sub.status)) {
    throw new Error("Server does not have an active Pro subscription");
  }
  if (sub.plan !== "pro") {
    throw new Error("Server does not have a Pro subscription");
  }
  if (previewClaims && (previewClaims.serverId !== serverId
    || previewClaims.userId !== userId
    || previewClaims.subscriptionId !== sub.stripeSubscriptionId)) {
    throw new Error("Seat update preview is invalid or expired");
  }

  const currentHumanSeats = Math.max(1, sub.provisionedHumanSeats);
  const currentAgentSeats = Math.max(0, sub.provisionedAgentSeats);
  const currentPackQuantity = Math.max(1, sub.proPackQuantity);
  const requestedPackQuantity = requestedSeatQuantity
    ?? (requestedHumanSeatQuantity == null && requestedAgentSeats == null
      ? null
      : calculateProPackQuantity(requestedHumanSeatQuantity ?? currentHumanSeats, requestedAgentSeats ?? currentAgentSeats));
  if (!requestedPackQuantity) {
    throw new Error("seatQuantity is required");
  }
  if (previewClaims && previewClaims.requestedPackQuantity !== requestedPackQuantity) {
    throw new Error("Seat update preview is invalid or expired");
  }
  const usage = await getServerBillingUsage(getDb(), serverId);
  const minimumSeatQuantity = Math.max(1, Math.ceil(usage.universalSeats));
  if (requestedPackQuantity < minimumSeatQuantity) {
    throw new Error(`seatQuantity must be at least ${minimumSeatQuantity} to cover current server usage`);
  }
  const currentPeriodEnd = sub.currentPeriodEnd;
  const stripe = getStripe();
  const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
  const shouldReactivate = sub.cancelAtPeriodEnd || stripeSub.cancel_at_period_end;
  const priceIds = getStripePriceIds();
  const proSeatItem = getProSeatSubscriptionItem(stripeSub, priceIds);
  if (proSeatItem) {
    const nextPackQuantity = requestedPackQuantity;
    if (nextPackQuantity > currentPackQuantity && hasPendingUpdate(stripeSub)) {
      throw new Error("A seat update is already pending Stripe payment confirmation");
    }
    let confirmedPromotionCodeId: string | null = null;
    if (previewClaims) {
      if (nextPackQuantity <= currentPackQuantity
        || previewClaims.currentPackQuantity !== currentPackQuantity
        || previewClaims.itemId !== proSeatItem.id
        || (proSeatItem.quantity ?? 0) !== previewClaims.currentPackQuantity) {
        throw new Error("Seat update changed after preview; review the latest price before confirming");
      }
      if (previewClaims.promotionCodeId) {
        if (!previewClaims.promotionCode || subscriptionHasDiscounts(stripeSub, proSeatItem)) {
          throw new Error("Seat update changed after preview; review the latest price before confirming");
        }
        const customerId = stripeCustomerId(stripeSub.customer);
        const promotionCode = await retrieveSeatUpdatePromotionCode(
          stripe,
          previewClaims.promotionCodeId,
          previewClaims.promotionCode,
          customerId,
          proSeatItem,
        );
        confirmedPromotionCodeId = promotionCode.id;
      }
    }
    if (nextPackQuantity === currentPackQuantity) {
      if (shouldReactivate) {
        const reactivated = await stripe.subscriptions.update(sub.stripeSubscriptionId, {
          cancel_at_period_end: false,
          metadata: {
            ...stripeSub.metadata,
            reactivatedByUserId: userId,
            reactivatedAt: new Date().toISOString(),
          },
        });
        await syncStripeSubscriptionProjection(reactivated, {
          serverId,
          userId,
        });
        return {
          status: "reactivated",
          currentPackQuantity,
          requestedPackQuantity: nextPackQuantity,
          effectiveAt: "current",
          currentPeriodEnd: getPeriodEnd(reactivated) ?? currentPeriodEnd,
        };
      }
      return {
        status: "unchanged",
        currentPackQuantity,
        requestedPackQuantity: nextPackQuantity,
        effectiveAt: "current",
        currentPeriodEnd,
      };
    }
    let stripeSubForQuantityUpdate = stripeSub;
    if (shouldReactivate) {
      stripeSubForQuantityUpdate = await stripe.subscriptions.update(sub.stripeSubscriptionId, {
        cancel_at_period_end: false,
        metadata: {
          ...stripeSub.metadata,
          reactivatedByUserId: userId,
          reactivatedAt: new Date().toISOString(),
        },
      }, previewClaims ? {
        idempotencyKey: billingSeatPreviewConfirmIdempotencyKey(request.previewToken, "reactivate"),
      } : undefined);
      await syncStripeSubscriptionProjection(stripeSubForQuantityUpdate, {
        serverId,
        userId,
      });
    }
    if (nextPackQuantity < currentPackQuantity) {
      const updated = await stripe.subscriptions.update(sub.stripeSubscriptionId, {
        items: [{ id: proSeatItem.id, quantity: nextPackQuantity }],
        metadata: subscriptionMetadataForSeatQuantity(stripeSubForQuantityUpdate, nextPackQuantity, {
          serverId,
          userId,
          billingInterval: billingIntervalFromStripeSubscription(stripeSubForQuantityUpdate, priceIds),
          humanSeatQuantity: String(requestedHumanSeatQuantity ?? nextPackQuantity),
          requestedAgentSeats: String(requestedAgentSeats ?? 0),
        }),
        proration_behavior: "create_prorations",
      });
      await syncStripeSubscriptionProjection(updated, {
        serverId,
        userId,
      });
      return {
        status: "updated",
        currentPackQuantity,
        requestedPackQuantity: nextPackQuantity,
        effectiveAt: "current",
        currentPeriodEnd: getPeriodEnd(updated) ?? currentPeriodEnd,
      };
    }
    const updated = await stripe.subscriptions.update(sub.stripeSubscriptionId, {
      items: [{ id: proSeatItem.id, quantity: nextPackQuantity }],
      metadata: subscriptionMetadataForSeatQuantity(stripeSubForQuantityUpdate, nextPackQuantity, {
        serverId,
        userId,
        billingInterval: billingIntervalFromStripeSubscription(stripeSubForQuantityUpdate, priceIds),
        humanSeatQuantity: String(requestedHumanSeatQuantity ?? nextPackQuantity),
        requestedAgentSeats: String(requestedAgentSeats ?? 0),
      }),
      ...(confirmedPromotionCodeId ? { discounts: [{ promotion_code: confirmedPromotionCodeId }] } : {}),
      payment_behavior: "pending_if_incomplete",
      proration_behavior: "always_invoice",
      ...(previewClaims ? { proration_date: previewClaims.prorationDate } : {}),
    }, previewClaims ? {
      idempotencyKey: billingSeatPreviewConfirmIdempotencyKey(request.previewToken, "quantity"),
    } : undefined);
    if (hasPendingUpdate(updated)) {
      return {
        status: "pending_payment",
        currentPackQuantity,
        requestedPackQuantity: nextPackQuantity,
        effectiveAt: "after_payment",
        currentPeriodEnd,
      };
    }
    return {
      status: "pending_webhook",
      currentPackQuantity,
      requestedPackQuantity: nextPackQuantity,
      effectiveAt: "after_payment",
      currentPeriodEnd,
    };
  }
  throw new Error("Server does not have a Pro Seat subscription item");
  } catch (error) {
    traceBillingEvent("billing.seat_update.failed", {
      server_id: serverId,
      requested_seat_quantity: traceRequestedSeatQuantity(request),
      ...traceAttrs.error(error),
    });
    throw error;
  }
}

// ── Customer Portal ──

export async function createPortalSession(
  serverId: string,
  returnUrl: string,
): Promise<string> {
  traceBillingEvent("billing.portal.requested", {
    server_id: serverId,
    ...traceStripeBillingState(),
  });
  try {
    if (!isStripeBillingFlagEnabled()) throw new Error("Billing is not configured (STRIPE_BILLING_ENABLED must be true)");
    const stripe = getStripe();
    const sub = await getSubscription(serverId);
    if (!sub) {
      traceBillingEvent("billing.portal.rejected", { server_id: serverId, reason: "missing_subscription" });
      throw new Error("No active subscription");
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripeCustomerId,
      return_url: returnUrl,
    });

    traceBillingEvent("billing.portal.session.created", {
      server_id: serverId,
      stripe_customer_present: Boolean(sub.stripeCustomerId),
      stripe_portal_url_present: Boolean(session.url),
    });
    return session.url;
  } catch (error) {
    traceBillingEvent("billing.portal.failed", {
      server_id: serverId,
      ...traceAttrs.error(error),
    });
    throw error;
  }
}

export async function cancelSubscriptionAtPeriodEnd(
  serverId: string,
  userId: string,
): Promise<{ status: "scheduled_period_end"; currentPeriodEnd: Date | null }> {
  traceBillingEvent("billing.cancel.requested", {
    server_id: serverId,
    user_id_present: Boolean(userId),
    ...traceStripeBillingState(),
  });
  try {
    if (!isStripeBillingFlagEnabled()) throw new Error("Billing is not configured (STRIPE_BILLING_ENABLED must be true)");
    const sub = await getSubscription(serverId);
    if (!sub || !isEntitlingStatus(sub.status)) {
      traceBillingEvent("billing.cancel.rejected", {
        server_id: serverId,
        reason: "missing_entitling_subscription",
        subscription_status: sub?.status ?? "none",
      });
      throw new Error("Server does not have an active Pro subscription");
    }

    const stripe = getStripe();
    const stripeSub = await stripe.subscriptions.update(sub.stripeSubscriptionId, {
      cancel_at_period_end: true,
      metadata: {
        cancelRequestedByUserId: userId,
        cancelRequestedAt: new Date().toISOString(),
      },
    });
    await syncStripeSubscriptionProjection(stripeSub, {
      serverId,
      userId,
    });
    traceBillingEvent("billing.cancel.scheduled", {
      server_id: serverId,
      cancel_at_period_end: true,
      current_period_end_present: Boolean(getPeriodEnd(stripeSub) ?? sub.currentPeriodEnd),
    });
    return {
      status: "scheduled_period_end",
      currentPeriodEnd: getPeriodEnd(stripeSub) ?? sub.currentPeriodEnd,
    };
  } catch (error) {
    traceBillingEvent("billing.cancel.failed", {
      server_id: serverId,
      ...traceAttrs.error(error),
    });
    throw error;
  }
}

// ── Subscription CRUD ──

export async function getSubscription(serverId: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.serverId, serverId));
  if (!row) return null;

  // If subscription looks active but period has expired, verify with Stripe
  if (
    row.status === "active" &&
    row.currentPeriodEnd &&
    new Date(row.currentPeriodEnd) < new Date()
  ) {
    await refreshSubscriptionStatus(row);
    // Re-fetch after refresh
    const [updated] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.serverId, serverId));
    return updated ?? null;
  }

  return row;
}

export async function refreshSubscriptionForServer(serverId: string): Promise<void> {
  if (!isStripeConfigured()) {
    traceBillingEvent("billing.subscription_refresh.skipped", {
      server_id: serverId,
      reason: "stripe_not_configured",
      ...traceStripeBillingState(),
    });
    return;
  }
  const db = getDb();
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.serverId, serverId));
  if (!sub) {
    traceBillingEvent("billing.subscription_refresh.skipped", {
      server_id: serverId,
      reason: "missing_subscription",
    });
    return;
  }
  await refreshSubscriptionStatus(sub);
}

function shouldRefreshSubscriptionProjection(sub: typeof subscriptions.$inferSelect, now: Date): boolean {
  if (sub.status !== "active" && sub.status !== "past_due") return false;
  if (sub.currentPeriodEnd && sub.currentPeriodEnd < now) return true;
  return sub.updatedAt < new Date(now.getTime() - PASSIVE_SUBSCRIPTION_REFRESH_MS);
}

export async function refreshSubscriptionForServerIfStale(serverId: string, now: Date = new Date()): Promise<void> {
  if (!isStripeConfigured()) {
    traceBillingEvent("billing.subscription_refresh.skipped", {
      server_id: serverId,
      reason: "stripe_not_configured",
      ...traceStripeBillingState(),
    });
    return;
  }
  const db = getDb();
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.serverId, serverId));
  if (!sub || !shouldRefreshSubscriptionProjection(sub, now)) {
    traceBillingEvent("billing.subscription_refresh.skipped", {
      server_id: serverId,
      reason: sub ? "not_stale" : "missing_subscription",
    });
    return;
  }
  await refreshSubscriptionStatus(sub);
}

/**
 * Verify subscription status with Stripe and update local record.
 * Used by billing reads and stale entitlement checks to recover from missed
 * Stripe webhooks before making local plan/capacity decisions.
 */
async function refreshSubscriptionStatus(sub: typeof subscriptions.$inferSelect): Promise<void> {
  if (!isStripeConfigured()) {
    traceBillingEvent("billing.subscription_refresh.skipped", {
      server_id: sub.serverId,
      reason: "stripe_not_configured",
      ...traceStripeBillingState(),
    });
    return;
  }

  try {
    traceBillingEvent("billing.subscription_refresh.started", {
      server_id: sub.serverId,
      subscription_status: sub.status,
      stripe_subscription_present: Boolean(sub.stripeSubscriptionId),
    });
    const stripe = getStripe();
    const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
    await syncStripeSubscriptionProjection(stripeSub, {
      serverId: sub.serverId,
      fallbackPlan: sub.plan as PaidBillingPlan,
    });
    traceBillingEvent("billing.subscription_refresh.completed", {
      server_id: sub.serverId,
      stripe_subscription_present: true,
    });
  } catch (err) {
    traceBillingEvent("billing.subscription_refresh.failed", {
      server_id: sub.serverId,
      ...traceAttrs.error(err),
    });
    console.error(`[Billing] Failed to refresh subscription for server ${sub.serverId}:`, err);
  }
}

// ── [UNUSED] Extra-Agent Quantity Sync ──
// Agent seats are no longer billed or synced separately.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _unusedSyncAgentQuantity() { /* see git history */ }

// ── Helpers ──

const STRIPE_STATUS_MAP: Record<string, "active" | "past_due" | "canceled" | "incomplete"> = {
  active: "active",
  past_due: "past_due",
  canceled: "canceled",
  incomplete: "incomplete",
  incomplete_expired: "canceled",
  trialing: "active",
  unpaid: "past_due",
};

function mapStripeStatus(status: string): "active" | "past_due" | "canceled" | "incomplete" {
  return STRIPE_STATUS_MAP[status] || "incomplete";
}

function isEntitlingStatus(status: "active" | "past_due" | "canceled" | "incomplete"): boolean {
  return status === "active" || status === "past_due";
}

function isStripeSubscriptionScheduledToCancel(stripeSub: Stripe.Subscription): boolean {
  if (stripeSub.cancel_at_period_end) return true;
  return stripeSub.status !== "canceled" && stripeSub.cancel_at != null;
}

function sameTimestamp(a: Date | null | undefined, b: Date | null | undefined): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

/** Extract current_period_end from a Stripe subscription (lives on items in v20+). */
function getPeriodEnd(stripeSub: Stripe.Subscription): Date | null {
  const firstItem = stripeSub.items.data[0];
  if (firstItem?.current_period_end) {
    return new Date(firstItem.current_period_end * 1000);
  }
  return null;
}

function getPeriodStart(stripeSub: Stripe.Subscription): Date | null {
  const firstItem = stripeSub.items.data[0];
  if (firstItem?.current_period_start) {
    return new Date(firstItem.current_period_start * 1000);
  }
  return null;
}

function metadataInt(metadata: Stripe.Metadata | undefined, key: string): number | null {
  const value = metadata?.[key];
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function metadataPlan(metadata: Stripe.Metadata | undefined): PaidBillingPlan | null {
  const plan = metadata?.targetPlan ?? metadata?.plan;
  return plan === "pro" ? plan : null;
}

function getStripeCustomerId(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && "id" in value && typeof value.id === "string") return value.id;
  return null;
}

function inferPlanFromItems(stripeSub: Stripe.Subscription, priceIds: Partial<StripePriceIds>): PaidBillingPlan | null {
  const priceIdSet = new Set(stripeSub.items.data.map((item) => item.price.id));
  if ((priceIds.proSeatMonthly && priceIdSet.has(priceIds.proSeatMonthly))
    || (priceIds.proSeatAnnual && priceIdSet.has(priceIds.proSeatAnnual))) return "pro";
  return null;
}

function getConfiguredPriceIdsBestEffort(): Partial<StripePriceIds> {
  return {
    proSeatMonthly: process.env.STRIPE_PRO_SEAT_MONTHLY_PRICE_ID?.trim(),
    proSeatAnnual: process.env.STRIPE_PRO_SEAT_ANNUAL_PRICE_ID?.trim(),
  };
}

function buildProjectionFromStripeSubscription(stripeSub: Stripe.Subscription, fallbackPlan?: PaidBillingPlan | null) {
  const metadata = stripeSub.metadata;
  const priceIds = getConfiguredPriceIdsBestEffort();
  const plan = metadataPlan(metadata) ?? inferPlanFromItems(stripeSub, priceIds) ?? fallbackPlan;
  if (!plan) return null;

  const proSeatItem = getProSeatSubscriptionItem(stripeSub, priceIds);
  const billingInterval = billingIntervalFromStripeSubscription(stripeSub, priceIds);
  const isSeatContract = metadata?.pricingContract === RAFT_PRO_SEAT_PRICING_CONTRACT
    || proSeatItem != null;
  if (!isSeatContract) return null;

  const seatQuantity = Math.max(
    1,
    proSeatItem?.quantity
      ?? metadataInt(metadata, "seatQuantity")
      ?? metadataInt(metadata, "proPackQuantity")
      ?? metadataInt(metadata, "packQuantity")
      ?? 1,
  );
  return {
    plan,
    billingInterval,
    stripeProPackItemId: proSeatItem?.id ?? null,
    provisionedHumanSeats: seatQuantity,
    provisionedAgentSeats: seatQuantity * PRO_AGENT_SEAT_BLOCK_SIZE,
    proPackQuantity: seatQuantity,
    trialFreePackQuantity: 0,
    firstPackTrialEndsAt: null,
  };
}

/** Extract subscription ID from an Invoice (parent.subscription_details in v20+). */
function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const subDetails = invoice.parent?.subscription_details;
  if (!subDetails) return null;
  const sub = subDetails.subscription;
  if (typeof sub === "string") return sub;
  if (sub && typeof sub === "object" && "id" in sub) return sub.id;
  return null;
}

// ── Cancel subscription on server deletion ──

/**
 * Cancel a server's Stripe subscription (if any) when the server is deleted.
 * Local record removal is intentionally owned by deleteServer's transaction so
 * it commits atomically with the server tombstone.
 */
export async function cancelSubscriptionForDeletedServer(serverId: string): Promise<void> {
  const db = getDb();
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.serverId, serverId));
  if (!sub) return; // No subscription — nothing to cancel

  if (isStripeConfigured()) {
    try {
      const stripe = getStripe();
      await stripe.subscriptions.cancel(sub.stripeSubscriptionId);
      console.log(`[Billing] Canceled Stripe subscription ${sub.stripeSubscriptionId} for deleted server ${serverId}`);
    } catch (err) {
      console.error(`[Billing] Failed to cancel Stripe subscription for server ${serverId}:`, err);
      // Deletion remains best-effort at the provider boundary. The local row is
      // removed atomically with the server tombstone by deleteServer.
    }
  }
}

// ── Webhook Handling ──

export function constructWebhookEvent(payload: Buffer, signature: string): Stripe.Event {
  if (!isStripeBillingFlagEnabled()) throw new Error("Billing is not configured (STRIPE_BILLING_ENABLED must be true)");
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET!;
  return stripe.webhooks.constructEvent(payload, signature, secret);
}

const WEBHOOK_PROCESSING_STALE_MS = 5 * 60 * 1000;

/**
 * Process a Stripe webhook event with idempotency protection.
 * Only processed events are final; stale processing claims can be retried.
 */
export async function handleWebhookEvent(event: Stripe.Event): Promise<void> {
  traceBillingEvent("billing.webhook.received", {
    event_type: event.type,
    stripe_event_id_present: Boolean(event.id),
  });
  const db = getDb();

  const now = new Date();
  const processingToken = randomUUID();
  let ownsClaim = false;
  const [claimed] = await db.insert(webhookEvents).values({
    id: event.id,
    type: event.type,
    status: "processing",
    processingToken,
    processedAt: now,
  }).onConflictDoNothing().returning({ id: webhookEvents.id });
  if (claimed) {
    ownsClaim = true;
    traceBillingEvent("billing.webhook.claim.created", {
      event_type: event.type,
      stripe_event_id_present: true,
    });
  } else {
    const [existing] = await db
      .select({
        status: webhookEvents.status,
        processedAt: webhookEvents.processedAt,
      })
      .from(webhookEvents)
      .where(eq(webhookEvents.id, event.id));

    if (!existing || existing.status === "processed") {
      traceBillingEvent("billing.webhook.duplicate_skipped", {
        event_type: event.type,
        existing_status: existing?.status ?? "missing",
      });
      console.log(`[Billing] Skipping duplicate webhook event ${event.id} (${event.type})`);
      return;
    }

    const staleCutoff = new Date(Date.now() - WEBHOOK_PROCESSING_STALE_MS);
    if (existing.processedAt >= staleCutoff) {
      traceBillingEvent("billing.webhook.concurrent_skipped", {
        event_type: event.type,
        existing_status: existing.status,
      });
      console.log(`[Billing] Skipping concurrent webhook event ${event.id} (${event.type})`);
      return;
    }

    const [reclaimed] = await db
      .update(webhookEvents)
      .set({
        type: event.type,
        processingToken,
        processedAt: now,
      })
      .where(and(
        eq(webhookEvents.id, event.id),
        eq(webhookEvents.status, "processing"),
        lt(webhookEvents.processedAt, staleCutoff),
      ))
      .returning({ id: webhookEvents.id });

    if (!reclaimed) {
      traceBillingEvent("billing.webhook.reclaim_lost", { event_type: event.type });
      console.log(`[Billing] Skipping concurrently reclaimed webhook event ${event.id} (${event.type})`);
      return;
    }
    ownsClaim = true;
    traceBillingEvent("billing.webhook.claim.reclaimed", {
      event_type: event.type,
      stale_claim: true,
    });

    console.log(`[Billing] Reclaimed stale webhook event ${event.id} (${event.type})`);
  }

  if (!ownsClaim) {
    traceBillingEvent("billing.webhook.claim.missing", { event_type: event.type });
    console.warn(`[Billing] Webhook event ${event.id} (${event.type}) had no owned processing claim`);
    return;
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session, event.id);
        break;
      case "checkout.session.expired":
        await handleCheckoutExpired(event.data.object as Stripe.Checkout.Session, event.id);
        break;
      case "invoice.paid":
        await handleInvoicePaid(event.data.object as Stripe.Invoice, event.id);
        break;
      case "refund.created":
      case "refund.updated":
        await handleReferralRefund(event.data.object as Stripe.Refund, event.id, event.type, event.created);
        break;
      case "credit_note.created":
      case "credit_note.updated":
      case "credit_note.voided":
        await handleReferralCreditNote(event.data.object as Stripe.CreditNote, event.id, event.type, event.created);
        break;
      case "charge.dispute.created":
      case "charge.dispute.closed":
        await handleReferralDispute(event.data.object as Stripe.Dispute, event.id, event.type, event.created);
        break;
      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice, event.id);
        break;
      case "customer.subscription.updated":
        await handleSubscriptionUpdated(event.data.object as Stripe.Subscription, event.id);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription, event.id);
        break;
    }
    const [processed] = await db
      .update(webhookEvents)
      .set({
        type: event.type,
        status: "processed",
        processingToken: null,
        processedAt: new Date(),
      })
      .where(and(
        eq(webhookEvents.id, event.id),
        eq(webhookEvents.status, "processing"),
        eq(webhookEvents.processingToken, processingToken),
      ))
      .returning({ id: webhookEvents.id });
    if (!processed) {
      traceBillingEvent("billing.webhook.claim_lost_after_processing", {
        event_type: event.type,
      });
      console.warn(`[Billing] Webhook event ${event.id} (${event.type}) was processed but its claim was no longer owned`);
    }
    traceBillingEvent("billing.webhook.processed", {
      event_type: event.type,
      claim_marked_processed: Boolean(processed),
    });
  } catch (err) {
    traceBillingEvent("billing.webhook.failed", {
      event_type: event.type,
      ...traceAttrs.error(err),
    });
    await db.delete(webhookEvents).where(and(
      eq(webhookEvents.id, event.id),
      eq(webhookEvents.status, "processing"),
      eq(webhookEvents.processingToken, processingToken),
    ));
    throw err;
  }
}

async function handleCheckoutExpired(session: Stripe.Checkout.Session, eventId: string): Promise<void> {
  if (!session.metadata?.referralRedemptionId) return;
  const payloadHash = hashReferralProviderPayload({
    kind: "checkout.session.expired",
    sessionId: session.id,
    sessionMetadata: session.metadata ?? {},
  });
  try {
    assertTestModeProviderObject(session, "checkout expired session");
    const tuple = assertReferralCheckoutMetadataPair(session.metadata, session.metadata);
    await applyReferralProviderEvent({
      environment: "stripe",
      livemode: false,
      stripeEventId: eventId,
      stripeEventType: "checkout.session.expired",
      providerObjectId: session.id,
      sourceApiVersion: REFERRAL_STRIPE_API_VERSION,
      payloadHash,
      normalizedPayload: {
        sessionId: session.id,
        sessionMetadata: session.metadata ?? {},
      },
    }, async (tx) => {
      await expireReferralCheckoutSession(tuple.redemptionId, session.id, tx);
    });
  } catch (error) {
    await ingestReferralProviderEvent({
      environment: "stripe",
      livemode: session.livemode === true,
      stripeEventId: eventId,
      stripeEventType: "checkout.session.expired",
      providerObjectId: session.id,
      sourceApiVersion: REFERRAL_STRIPE_API_VERSION,
      payloadHash,
      normalizedPayload: {
        sessionId: session.id,
        sessionMetadata: session.metadata ?? {},
      },
      sanitizedErrorCode: "provider_retrieve_failed",
      sanitizedErrorMessage: error instanceof Error ? error.message : "Referral checkout expiry failed.",
      processingState: "parked",
    }).catch(() => undefined);
  }
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session, eventId: string): Promise<void> {
  const serverId = session.metadata?.serverId;
  const billingTraceId = toBillingTraceId(session.metadata?.billingTraceId);
  traceBillingEvent("billing.checkout.completed.received", {
    server_id_present: Boolean(serverId),
    billing_trace_id: billingTraceId,
    mode: session.mode,
    stripe_subscription_present: Boolean(session.subscription),
    stripe_customer_present: Boolean(session.customer),
    stripe_event_id_present: Boolean(eventId),
  });
  if (!serverId || session.mode !== "subscription") {
    traceBillingEvent("billing.checkout.completed.skipped", {
      reason: !serverId ? "missing_server_id" : "non_subscription_mode",
      billing_trace_id: billingTraceId,
      mode: session.mode,
    });
    return;
  }

  // Skip if server has been deleted
  const db0 = getDb();
  const [srv] = await db0.select({ id: servers.id }).from(servers)
    .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)));
  if (!srv) {
    traceBillingEvent("billing.checkout.completed.skipped", {
      server_id: serverId,
      billing_trace_id: billingTraceId,
      reason: "deleted_server",
    });
    console.log(`[Billing] Skipping checkout for deleted server ${serverId}`);
    return;
  }

  const stripe = getStripe();
  const subscriptionId = session.subscription as string;

  // Fetch the full subscription to verify real status + get line item IDs
  const stripeSub = await stripe.subscriptions.retrieve(subscriptionId);
  await syncStripeSubscriptionProjection(stripeSub, {
    serverId,
    customerId: getStripeCustomerId(session.customer),
    userId: session.metadata?.userId ?? null,
    eventId,
  });
  await handleReferralCheckoutCompleted(session, eventId);
}

async function handleInvoicePaid(invoice: Stripe.Invoice, eventId: string): Promise<void> {
  const subscriptionId = getInvoiceSubscriptionId(invoice);
  traceBillingEvent("billing.invoice.paid.received", {
    stripe_subscription_present: Boolean(subscriptionId),
    stripe_event_id_present: Boolean(eventId),
  });
  if (!subscriptionId) return;

  const stripe = getStripe();
  const stripeSub = await stripe.subscriptions.retrieve(subscriptionId);
  await syncStripeSubscriptionProjection(stripeSub, { eventId });
  await handleReferralInvoicePaid(invoice, stripeSub.metadata ?? {}, eventId);
}

async function handleReferralCheckoutCompleted(
  session: Stripe.Checkout.Session,
  eventId: string,
): Promise<void> {
  if (!session.metadata?.referralRedemptionId) return;
  const payloadHash = hashReferralProviderPayload({
    kind: "checkout.session.completed",
    sessionId: session.id,
    subscriptionId: objectId(session.subscription),
    sessionMetadata: session.metadata ?? {},
  });
  const normalizedPayload = {
    sessionId: session.id,
    subscriptionId: objectId(session.subscription),
    customerId: getStripeCustomerId(session.customer),
    sessionMetadata: session.metadata ?? {},
  };
  try {
    assertTestModeProviderObject(session, "checkout completed session");
    const subscriptionId = objectId(session.subscription);
    if (!subscriptionId) throw new Error("Referral checkout completed without subscription id.");
    const stripeSub = await getReferralStripe().subscriptions.retrieve(subscriptionId);
    assertTestModeProviderObject(stripeSub, "subscription");
    const tuple = assertReferralCheckoutMetadataPair(session.metadata, stripeSub.metadata);
    await applyReferralProviderEvent({
      environment: "stripe",
      livemode: false,
      stripeEventId: eventId,
      stripeEventType: "checkout.session.completed",
      providerObjectId: session.id,
      sourceApiVersion: REFERRAL_STRIPE_API_VERSION,
      payloadHash,
      normalizedPayload,
    }, async (tx) => {
      await markReferralCheckoutCompleted(tuple.redemptionId, {
        stripeCheckoutSessionId: session.id,
        stripeCustomerId: getStripeCustomerId(session.customer) ?? objectId(stripeSub.customer),
        stripeSubscriptionId: stripeSub.id,
      }, tx);
    });
  } catch (error) {
    await ingestReferralProviderEvent({
      environment: "stripe",
      livemode: session.livemode === true,
      stripeEventId: eventId,
      stripeEventType: "checkout.session.completed",
      providerObjectId: session.id,
      sourceApiVersion: REFERRAL_STRIPE_API_VERSION,
      payloadHash,
      normalizedPayload,
      sanitizedErrorCode: "provider_retrieve_failed",
      sanitizedErrorMessage: error instanceof Error ? error.message : "Referral checkout completion failed.",
      processingState: "parked",
    }).catch(() => undefined);
    traceBillingEvent("billing.referral.checkout_completed.parked", {
      stripe_event_id_present: true,
      ...traceAttrs.error(error),
    });
  }
}

async function handleReferralInvoicePaid(
  invoice: Stripe.Invoice,
  observedSubscriptionMetadata: Stripe.Metadata,
  eventId: string,
): Promise<void> {
  const subscriptionId = getInvoiceSubscriptionId(invoice);
  if (!subscriptionId) return;
  if (!observedSubscriptionMetadata.referralRedemptionId) return;
  const payloadHash = hashReferralProviderPayload({
    kind: "invoice.paid",
    invoiceId: invoice.id,
    subscriptionId,
    customerId: objectId(invoice.customer),
    lineCount: invoice.lines?.data?.length ?? 0,
  });
  const normalizedPayload = {
    invoiceId: invoice.id,
    subscriptionId,
    customerId: objectId(invoice.customer),
    currency: invoice.currency,
    amountPaid: invoice.amount_paid,
    lineCount: invoice.lines?.data?.length ?? 0,
  };
  try {
    const referralStripe = getReferralStripe();
    const expandedInvoice = await referralStripe.invoices.retrieve(invoice.id, {
      expand: [
        "discounts.promotion_code",
        "discounts.promotion_code.coupon",
        "lines.data.discounts.promotion_code",
        "lines.data.discounts.promotion_code.coupon",
        "lines.data.price",
      ],
    });
    assertTestModeProviderObject(expandedInvoice, "invoice");
    const stripeSub = await referralStripe.subscriptions.retrieve(subscriptionId);
    assertTestModeProviderObject(stripeSub, "subscription");
    if (!stripeSub.metadata?.referralRedemptionId) return;
    const redemption = await readReferralRedemptionBySubscription(stripeSub.id);
    const sessionId = redemption?.stripeCheckoutSessionId ?? null;
    if (!sessionId) throw new Error("Referral subscription has no canonical checkout session.");
    const session = await referralStripe.checkout.sessions.retrieve(sessionId);
    assertTestModeProviderObject(session, "checkout session");
    const tuple = assertReferralCheckoutMetadataPair(session.metadata, stripeSub.metadata);
    const { promotionCodeId, couponId } = collectInvoiceDiscountIds(expandedInvoice);
    const expected = getStripePriceIds();
    if (!promotionCodeId || !couponId || promotionCodeId === "__mixed__" || couponId === "__mixed__") {
      throw new Error("Referral invoice discount is missing or mixed.");
    }
    const priceIds = invoiceLinePriceIdsWithDiscount(expandedInvoice, promotionCodeId, couponId);
    const matchedPrice = priceIds.find((id) => id === expected.proSeatMonthly || id === expected.proSeatAnnual);
    if (!matchedPrice) throw new Error("Referral invoice does not include an expected Pro price.");
    const matchedBillingInterval = billingIntervalFromPriceId(matchedPrice, expected);
    if (!matchedBillingInterval) throw new Error("Referral invoice price interval is not recognizable.");
    await applyReferralProviderEvent({
      environment: "stripe",
      livemode: false,
      stripeEventId: eventId,
      stripeEventType: "invoice.paid",
      providerObjectId: expandedInvoice.id,
      sourceApiVersion: REFERRAL_STRIPE_API_VERSION,
      payloadHash,
      normalizedPayload: {
        ...normalizedPayload,
        promotionCodeId,
        couponId,
        matchedPrice,
        sessionId,
      },
    }, async (tx) => {
      await qualifyReferralInvoicePayment({
        redemptionId: tuple.redemptionId,
        firstPaidInvoiceId: expandedInvoice.id,
        stripeSubscriptionId: stripeSub.id,
        stripeCustomerId: objectId(expandedInvoice.customer) ?? objectId(stripeSub.customer),
        stripePromotionCodeId: promotionCodeId,
        stripeCouponId: couponId,
        stripePriceId: matchedPrice,
        billingInterval: matchedBillingInterval,
        expectedPriceIds: [expected.proSeatMonthly, expected.proSeatAnnual],
      }, tx);
    });
  } catch (error) {
    await ingestReferralProviderEvent({
      environment: "stripe",
      livemode: invoice.livemode === true,
      stripeEventId: eventId,
      stripeEventType: "invoice.paid",
      providerObjectId: invoice.id,
      sourceApiVersion: REFERRAL_STRIPE_API_VERSION,
      payloadHash,
      normalizedPayload,
      sanitizedErrorCode: "provider_retrieve_failed",
      sanitizedErrorMessage: error instanceof Error ? error.message : "Referral invoice reconciliation failed.",
      processingState: "parked",
    }).catch(() => undefined);
    traceBillingEvent("billing.referral.invoice_paid.parked", {
      stripe_event_id_present: true,
      ...traceAttrs.error(error),
    });
  }
}

async function applyReferralFinancialProviderFact(input: {
  stripeEventId: string;
  stripeEventType: string;
  providerEventCreated?: number | null;
  providerObjectId: string;
  livemode?: boolean;
  kind: "refund" | "credit_note" | "dispute_opened" | "dispute_won" | "dispute_lost";
  stripeInvoiceId: string | null;
  stripeRefundId?: string | null;
  stripeCreditNoteId?: string | null;
  stripeDisputeId?: string | null;
  stripeChargeId?: string | null;
  currency: string | null;
  amount: number | null;
  netRevenueDelta: number;
  fullEconomicReversal?: boolean;
  raw: Record<string, unknown>;
}, executor: DatabaseExecutor = getDb()) {
  const payloadHash = hashReferralProviderPayload({
    eventType: input.stripeEventType,
    providerObjectId: input.providerObjectId,
    raw: input.raw,
  });
  let resolvedRedemptionId: string | null = null;
  try {
    if (input.livemode === true) {
      throw new Error("Referral financial provider fact was emitted in live mode; local-only v1 must park it.");
    }
    if (!input.stripeInvoiceId || !input.currency || input.amount == null) {
      throw new Error("Referral financial provider fact is missing deterministic invoice or amount lineage.");
    }
    const redemption = await readQualifiedReferralRedemptionByInvoice(input.stripeInvoiceId, executor);
    resolvedRedemptionId = redemption?.id ?? null;
    const providerFactSequence = referralFinancialProviderFactSequence(input);
    await applyReferralProviderEvent({
      environment: "stripe",
      livemode: false,
      stripeEventId: input.stripeEventId,
      stripeEventType: input.stripeEventType,
      providerObjectId: input.providerObjectId,
      sourceApiVersion: REFERRAL_STRIPE_API_VERSION,
      payloadHash,
      normalizedPayload: {
        ...input.raw,
        stripeInvoiceId: input.stripeInvoiceId,
        currency: input.currency,
        amount: input.amount,
        status: typeof input.raw.status === "string" ? input.raw.status : null,
        providerEventCreated: input.providerEventCreated ?? null,
        providerFactSequence,
      },
    }, async (tx, event) => {
      await lockReferralFinancialLineage({
        environment: "stripe",
        livemode: false,
        kind: input.kind,
        providerFactId: input.providerObjectId,
      }, tx);
      if (
        (input.kind === "refund" || input.kind === "credit_note")
        && await hasReferralFinancialSameSequenceAmbiguityMarker({
          environment: "stripe",
          livemode: false,
          kind: input.kind,
          providerFactId: input.providerObjectId,
          providerFactSequence,
        }, tx)
      ) {
        throw new Error("Referral financial same-second lineage is already ambiguous.");
      }
      const netRevenueDelta = await deriveReferralFinancialDelta({
        environment: "stripe",
        livemode: false,
        kind: input.kind,
        providerFactId: input.providerObjectId,
        providerFactSequence,
        cumulativeAmount: input.amount!,
        status: typeof input.raw.status === "string" ? input.raw.status : null,
        fallbackDelta: input.netRevenueDelta,
      }, tx);
      await recordReferralFinancialAdjustment({
        redemptionId: redemption?.id ?? null,
        environment: "stripe",
        livemode: false,
        kind: input.kind,
        providerFactId: input.providerObjectId,
        providerFactSequence,
        stripeEventId: input.stripeEventId,
        stripeInvoiceId: input.stripeInvoiceId!,
        stripeRefundId: input.stripeRefundId ?? null,
        stripeCreditNoteId: input.stripeCreditNoteId ?? null,
        stripeDisputeId: input.stripeDisputeId ?? null,
        stripeChargeId: input.stripeChargeId ?? null,
        currency: input.currency!,
        amount: input.amount!,
        netRevenueDelta,
        fullEconomicReversal: input.fullEconomicReversal ?? false,
        sanitizedReason: input.kind,
      }, tx);
      await appendReferralFinancialLineageCompensation({
        environment: "stripe",
        livemode: false,
        kind: input.kind,
        providerFactId: input.providerObjectId,
        redemptionId: redemption?.id ?? null,
        stripeEventId: input.stripeEventId,
        stripeInvoiceId: input.stripeInvoiceId!,
        stripeRefundId: input.stripeRefundId ?? null,
        stripeCreditNoteId: input.stripeCreditNoteId ?? null,
        stripeDisputeId: input.stripeDisputeId ?? null,
        stripeChargeId: input.stripeChargeId ?? null,
        currency: input.currency!,
        providerFactSequence,
      }, tx);
    }, executor);
  } catch (error) {
    await neutralizeReferralFinancialAmbiguousSameSequence({
      environment: "stripe",
      livemode: input.livemode === true,
      kind: input.kind,
      providerFactId: input.providerObjectId,
      redemptionId: resolvedRedemptionId,
      stripeEventId: input.stripeEventId,
      stripeInvoiceId: input.stripeInvoiceId,
      stripeRefundId: input.stripeRefundId ?? null,
      stripeCreditNoteId: input.stripeCreditNoteId ?? null,
      stripeDisputeId: input.stripeDisputeId ?? null,
      stripeChargeId: input.stripeChargeId ?? null,
      currency: input.currency,
      providerFactSequence: input.providerEventCreated ?? null,
      amount: input.amount,
      status: typeof input.raw.status === "string" ? input.raw.status : null,
    }, executor).catch(() => undefined);
    await ingestReferralProviderEvent({
      environment: "stripe",
      livemode: input.livemode === true,
      stripeEventId: input.stripeEventId,
      stripeEventType: input.stripeEventType,
      providerObjectId: input.providerObjectId,
      sourceApiVersion: REFERRAL_STRIPE_API_VERSION,
      payloadHash,
      normalizedPayload: input.raw,
      sanitizedErrorCode: "provider_lineage_mismatch",
      sanitizedErrorMessage: error instanceof Error ? error.message : "Referral financial provider fact could not be joined.",
      processingState: "parked",
    }, executor).catch(() => undefined);
  }
}

async function lockReferralFinancialLineage(
  input: {
    environment: string;
    livemode: boolean;
    kind: "refund" | "credit_note" | "dispute_opened" | "dispute_won" | "dispute_lost";
    providerFactId: string;
  },
  tx: DatabaseExecutor,
): Promise<void> {
  if (input.kind !== "refund" && input.kind !== "credit_note") return;
  const lockKey = [
    "referral_financial_lineage",
    input.environment,
    input.livemode ? "live" : "test",
    input.kind,
    input.providerFactId,
  ].join(":");
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
}

function referralFinancialProviderFactSequence(
  input: {
    stripeEventType: string;
    kind: "refund" | "credit_note" | "dispute_opened" | "dispute_won" | "dispute_lost";
    providerEventCreated?: number | null;
  },
): number {
  if (input.kind === "refund" || input.kind === "credit_note") {
    if (input.stripeEventType !== "refund.created"
      && input.stripeEventType !== "refund.updated"
      && input.stripeEventType !== "credit_note.created"
      && input.stripeEventType !== "credit_note.updated"
      && input.stripeEventType !== "credit_note.voided") {
      throw new Error("Referral financial provider fact has no supported immutable event ordering.");
    }
    if (!Number.isInteger(input.providerEventCreated) || (input.providerEventCreated ?? 0) <= 0) {
      throw new Error("Referral financial provider fact is missing Stripe event created ordering.");
    }
    return input.providerEventCreated!;
  }
  if (input.stripeEventType !== "charge.dispute.created" && input.stripeEventType !== "charge.dispute.closed") {
    throw new Error("Referral dispute provider fact has no supported immutable event ordering.");
  }
  if (!Number.isInteger(input.providerEventCreated) || (input.providerEventCreated ?? 0) <= 0) {
    throw new Error("Referral dispute provider fact is missing Stripe event created ordering.");
  }
  return input.providerEventCreated!;
}

function cumulativeFinancialDelta(
  kind: "refund" | "credit_note" | "dispute_opened" | "dispute_won" | "dispute_lost",
  amount: number,
  fallbackDelta: number,
  status?: string | null,
): number {
  const normalizedStatus = status?.toLowerCase() ?? null;
  if (kind === "refund" && (normalizedStatus === "failed" || normalizedStatus === "canceled" || normalizedStatus === "cancelled")) return 0;
  if (kind === "credit_note" && (normalizedStatus === "void" || normalizedStatus === "voided")) return 0;
  if (kind === "refund" || kind === "credit_note" || kind === "dispute_lost") return -amount;
  if (kind === "dispute_opened" || kind === "dispute_won") return 0;
  return fallbackDelta;
}

function effectiveCumulativeFinancialDeltaForSequence(
  kind: "refund" | "credit_note",
  snapshots: Array<{ amount: number; status: string | null; stripeEventId: string }>,
): number {
  if (snapshots.length === 0) return 0;
  const statuses = snapshots.map((snapshot) => snapshot.status?.toLowerCase() ?? null);
  const amounts = new Set(snapshots.map((snapshot) => snapshot.amount));
  if (amounts.size > 1) {
    throw new Error("Referral financial same-second snapshots disagree on amount.");
  }
  const [amount] = amounts;
  if (kind === "credit_note") {
    if (statuses.some((status) => status === "void" || status === "voided")) return 0;
    return -amount;
  }

  const hasFailed = statuses.some((status) => status === "failed" || status === "canceled" || status === "cancelled");
  const hasSucceeded = statuses.some((status) => status === "succeeded");
  if (hasFailed && hasSucceeded) {
    throw new Error("Referral refund same-second snapshots contain conflicting terminal states.");
  }
  if (hasFailed) return 0;
  return -amount;
}

async function neutralizeReferralFinancialAmbiguousSameSequence(
  input: {
    environment: string;
    livemode: boolean;
    kind: "refund" | "credit_note" | "dispute_opened" | "dispute_won" | "dispute_lost";
    providerFactId: string;
    redemptionId: string | null;
    stripeEventId: string;
    stripeInvoiceId: string | null;
    stripeRefundId: string | null;
    stripeCreditNoteId: string | null;
    stripeDisputeId: string | null;
    stripeChargeId: string | null;
    currency: string | null;
    providerFactSequence: number | null;
    amount: number | null;
    status: string | null;
  },
  executor: DatabaseExecutor,
): Promise<void> {
  if (input.kind !== "refund" && input.kind !== "credit_note") return;
  if (!input.redemptionId || !input.stripeInvoiceId || !input.currency || input.amount == null) return;
  if (!Number.isInteger(input.providerFactSequence) || (input.providerFactSequence ?? 0) <= 0) return;
  const kind: "refund" | "credit_note" = input.kind;
  const providerFactSequence = input.providerFactSequence!;
  const stripeInvoiceId = input.stripeInvoiceId;
  const currency = input.currency;
  const amount = input.amount;

  await executor.transaction(async (tx) => {
    await lockReferralFinancialLineage({
      environment: input.environment,
      livemode: input.livemode,
      kind,
      providerFactId: input.providerFactId,
    }, tx);
    const rows = await tx.select().from(referralDiscountFinancialAdjustments)
      .where(and(
        eq(referralDiscountFinancialAdjustments.environment, input.environment),
        eq(referralDiscountFinancialAdjustments.livemode, input.livemode),
        eq(referralDiscountFinancialAdjustments.kind, kind),
        eq(referralDiscountFinancialAdjustments.providerFactId, input.providerFactId),
      ))
      .orderBy(referralDiscountFinancialAdjustments.providerFactSequence, referralDiscountFinancialAdjustments.stripeEventId);

    const realRows = rows.filter((row) => !row.stripeEventId.endsWith(REFERRAL_FINANCIAL_COMPENSATION_SUFFIX));
    const currentSequenceRows = realRows.filter((row) => row.providerFactSequence === providerFactSequence);
    if (currentSequenceRows.length === 0) return;

    const currentSequenceSnapshots: Array<{ amount: number; status: string | null; stripeEventId: string }> = [];
    for (const row of currentSequenceRows) {
      currentSequenceSnapshots.push({
        amount: row.amount,
        status: await readReferralFinancialAdjustmentStatus(row.stripeEventId, tx),
        stripeEventId: row.stripeEventId,
      });
    }
    try {
      effectiveCumulativeFinancialDeltaForSequence(kind, [
        ...currentSequenceSnapshots,
        { amount, status: input.status, stripeEventId: input.stripeEventId },
      ]);
      return;
    } catch {
      // Ambiguous same-second snapshots have no provider-authoritative order.
    }

    let priorCumulative = 0;
    const priorSnapshotsBySequence = new Map<number, Array<{ amount: number; status: string | null; stripeEventId: string }>>();
    for (const row of realRows) {
      if (row.providerFactSequence >= providerFactSequence) continue;
      const group = priorSnapshotsBySequence.get(row.providerFactSequence) ?? [];
      group.push({
        amount: row.amount,
        status: await readReferralFinancialAdjustmentStatus(row.stripeEventId, tx),
        stripeEventId: row.stripeEventId,
      });
      priorSnapshotsBySequence.set(row.providerFactSequence, group);
    }
    for (const sequence of [...priorSnapshotsBySequence.keys()].sort((left, right) => left - right)) {
      priorCumulative = effectiveCumulativeFinancialDeltaForSequence(kind, priorSnapshotsBySequence.get(sequence)!);
    }

    const currentTotal = rows.reduce((total, row) => total + row.netRevenueDelta, 0);
    const compensationDelta = priorCumulative - currentTotal;

    await recordReferralFinancialAdjustment({
      redemptionId: input.redemptionId,
      environment: input.environment,
      livemode: input.livemode,
      kind,
      providerFactId: input.providerFactId,
      providerFactSequence: -providerFactSequence,
      stripeEventId: `${input.stripeEventId}${REFERRAL_FINANCIAL_COMPENSATION_SUFFIX}`,
      stripeInvoiceId,
      stripeRefundId: input.stripeRefundId,
      stripeCreditNoteId: input.stripeCreditNoteId,
      stripeDisputeId: input.stripeDisputeId,
      stripeChargeId: input.stripeChargeId,
      currency,
      amount: 0,
      netRevenueDelta: compensationDelta,
      fullEconomicReversal: false,
      sanitizedReason: `${kind}${REFERRAL_FINANCIAL_SAME_SEQUENCE_AMBIGUITY_REASON_SUFFIX}`,
    }, tx);
  });
}

const REFERRAL_FINANCIAL_SAME_SEQUENCE_AMBIGUITY_REASON_SUFFIX = ":same_sequence_ambiguous_compensation";

async function hasReferralFinancialSameSequenceAmbiguityMarker(
  input: {
    environment: string;
    livemode: boolean;
    kind: "refund" | "credit_note";
    providerFactId: string;
    providerFactSequence: number;
  },
  tx: DatabaseExecutor,
): Promise<boolean> {
  const [marker] = await tx.select({ id: referralDiscountFinancialAdjustments.id })
    .from(referralDiscountFinancialAdjustments)
    .where(and(
      eq(referralDiscountFinancialAdjustments.environment, input.environment),
      eq(referralDiscountFinancialAdjustments.livemode, input.livemode),
      eq(referralDiscountFinancialAdjustments.kind, input.kind),
      eq(referralDiscountFinancialAdjustments.providerFactId, input.providerFactId),
      eq(referralDiscountFinancialAdjustments.providerFactSequence, -input.providerFactSequence),
      eq(referralDiscountFinancialAdjustments.sanitizedReason, `${input.kind}${REFERRAL_FINANCIAL_SAME_SEQUENCE_AMBIGUITY_REASON_SUFFIX}`),
    ))
    .limit(1);
  return Boolean(marker);
}

async function deriveReferralFinancialDelta(
  input: {
    environment: string;
    livemode: boolean;
    kind: "refund" | "credit_note" | "dispute_opened" | "dispute_won" | "dispute_lost";
    providerFactId: string;
    providerFactSequence: number;
    cumulativeAmount: number;
    status?: string | null;
    fallbackDelta: number;
  },
  tx: DatabaseExecutor,
): Promise<number> {
  const currentCumulative = cumulativeFinancialDelta(input.kind, input.cumulativeAmount, input.fallbackDelta, input.status);
  if ((input.kind !== "refund" && input.kind !== "credit_note") || input.providerFactSequence <= 1) {
    return currentCumulative;
  }
  const [prior] = await tx.select().from(referralDiscountFinancialAdjustments)
    .where(and(
      eq(referralDiscountFinancialAdjustments.environment, input.environment),
      eq(referralDiscountFinancialAdjustments.livemode, input.livemode),
      eq(referralDiscountFinancialAdjustments.kind, input.kind),
      eq(referralDiscountFinancialAdjustments.providerFactId, input.providerFactId),
      sql`${referralDiscountFinancialAdjustments.providerFactSequence} < ${input.providerFactSequence}`,
    ))
    .orderBy(sql`${referralDiscountFinancialAdjustments.providerFactSequence} DESC`)
    .limit(1);
  if (!prior) {
    return currentCumulative;
  }
  const priorStatus = await readReferralFinancialAdjustmentStatus(prior.stripeEventId, tx);
  return currentCumulative - cumulativeFinancialDelta(input.kind, prior.amount, prior.netRevenueDelta, priorStatus);
}

async function readReferralFinancialAdjustmentStatus(stripeEventId: string, tx: DatabaseExecutor): Promise<string | null> {
  const [event] = await tx.select({ normalizedPayload: referralDiscountProviderEvents.normalizedPayload })
    .from(referralDiscountProviderEvents)
    .where(and(
      eq(referralDiscountProviderEvents.environment, "stripe"),
      eq(referralDiscountProviderEvents.livemode, false),
      eq(referralDiscountProviderEvents.stripeEventId, stripeEventId),
    ))
    .limit(1);
  const status = event?.normalizedPayload?.status;
  return typeof status === "string" ? status : null;
}

const REFERRAL_FINANCIAL_COMPENSATION_SUFFIX = ":lineage_compensation";

async function appendReferralFinancialLineageCompensation(
  input: {
    environment: string;
    livemode: boolean;
    kind: "refund" | "credit_note" | "dispute_opened" | "dispute_won" | "dispute_lost";
    providerFactId: string;
    redemptionId: string | null;
    stripeEventId: string;
    stripeInvoiceId: string;
    stripeRefundId: string | null;
    stripeCreditNoteId: string | null;
    stripeDisputeId: string | null;
    stripeChargeId: string | null;
    currency: string;
    providerFactSequence: number;
  },
  tx: DatabaseExecutor,
): Promise<void> {
  if (input.kind !== "refund" && input.kind !== "credit_note") return;
  const rows = await tx.select().from(referralDiscountFinancialAdjustments)
    .where(and(
      eq(referralDiscountFinancialAdjustments.environment, input.environment),
      eq(referralDiscountFinancialAdjustments.livemode, input.livemode),
      eq(referralDiscountFinancialAdjustments.kind, input.kind),
      eq(referralDiscountFinancialAdjustments.providerFactId, input.providerFactId),
    ))
    .orderBy(referralDiscountFinancialAdjustments.providerFactSequence, referralDiscountFinancialAdjustments.stripeEventId);

  const realSnapshots = rows.filter((row) => !row.stripeEventId.endsWith(REFERRAL_FINANCIAL_COMPENSATION_SUFFIX));
  let effectiveCumulative = 0;
  const snapshotsBySequence = new Map<number, Array<{ amount: number; status: string | null; stripeEventId: string }>>();
  for (const row of realSnapshots) {
    const status = await readReferralFinancialAdjustmentStatus(row.stripeEventId, tx);
    const group = snapshotsBySequence.get(row.providerFactSequence) ?? [];
    group.push({ amount: row.amount, status, stripeEventId: row.stripeEventId });
    snapshotsBySequence.set(row.providerFactSequence, group);
  }
  for (const sequence of [...snapshotsBySequence.keys()].sort((left, right) => left - right)) {
    effectiveCumulative = effectiveCumulativeFinancialDeltaForSequence(input.kind, snapshotsBySequence.get(sequence)!);
  }
  const currentTotal = rows.reduce((total, row) => total + row.netRevenueDelta, 0);
  const compensationDelta = effectiveCumulative - currentTotal;
  if (compensationDelta === 0) return;

  await recordReferralFinancialAdjustment({
    redemptionId: input.redemptionId,
    environment: input.environment,
    livemode: input.livemode,
    kind: input.kind,
    providerFactId: input.providerFactId,
    providerFactSequence: -input.providerFactSequence,
    stripeEventId: `${input.stripeEventId}${REFERRAL_FINANCIAL_COMPENSATION_SUFFIX}`,
    stripeInvoiceId: input.stripeInvoiceId,
    stripeRefundId: input.stripeRefundId,
    stripeCreditNoteId: input.stripeCreditNoteId,
    stripeDisputeId: input.stripeDisputeId,
    stripeChargeId: input.stripeChargeId,
    currency: input.currency,
    amount: 0,
    netRevenueDelta: compensationDelta,
    fullEconomicReversal: false,
    sanitizedReason: `${input.kind}:lineage_compensation`,
  }, tx);
}

async function parkReferralFinancialProviderEvent(input: {
  stripeEventId: string;
  stripeEventType: string;
  providerObjectId: string;
  livemode?: boolean;
  raw: Record<string, unknown>;
  code?: string;
  message: string;
}, executor: DatabaseExecutor = getDb()) {
  await ingestReferralProviderEvent({
    environment: "stripe",
    livemode: input.livemode === true,
    stripeEventId: input.stripeEventId,
    stripeEventType: input.stripeEventType,
    providerObjectId: input.providerObjectId,
    sourceApiVersion: REFERRAL_STRIPE_API_VERSION,
    payloadHash: hashReferralProviderPayload({
      eventType: input.stripeEventType,
      providerObjectId: input.providerObjectId,
      raw: input.raw,
    }),
    normalizedPayload: input.raw,
    sanitizedErrorCode: input.code ?? "provider_lineage_mismatch",
    sanitizedErrorMessage: input.message,
    processingState: "parked",
  }, executor).catch(() => undefined);
}

export async function __dispatchReferralFinancialWebhookForTests(event: Pick<Stripe.Event, "id" | "type" | "created" | "data">, executor: DatabaseExecutor = getDb()) {
  switch (event.type) {
    case "refund.created":
    case "refund.updated":
      return handleReferralRefund(event.data.object as Stripe.Refund, event.id, event.type, event.created, executor);
    case "credit_note.created":
    case "credit_note.updated":
    case "credit_note.voided":
      return handleReferralCreditNote(event.data.object as Stripe.CreditNote, event.id, event.type, event.created, executor);
    case "charge.dispute.created":
    case "charge.dispute.closed":
      return handleReferralDispute(event.data.object as Stripe.Dispute, event.id, event.type, event.created, executor);
    default:
      throw new Error(`Unsupported referral financial webhook type in test: ${event.type}`);
  }
}

async function handleReferralRefund(refund: Stripe.Refund, eventId: string, eventType: string, eventCreated?: number, executor: DatabaseExecutor = getDb()): Promise<void> {
  const compatibleRefund = refund as unknown as StripeFinancialObjectCompatibility;
  const livemode = compatibleRefund.livemode === true;
  const chargeId = objectId(compatibleRefund.charge);
  let invoiceId = objectId(compatibleRefund.invoice);
  if (livemode) {
    await parkReferralFinancialProviderEvent({
      stripeEventId: eventId,
      stripeEventType: eventType,
      providerObjectId: refund.id,
      livemode,
      raw: {
        refundId: refund.id,
        chargeId,
        invoiceId,
        status: refund.status ?? null,
      },
      code: "provider_live_mode",
      message: "Referral refund event was live mode; local-only v1 parks it without provider reads.",
    }, executor);
    return;
  }
  if (!invoiceId && chargeId) {
    const charge = await getReferralStripe().charges.retrieve(chargeId, { expand: ["invoice"] });
    invoiceId = objectId((charge as unknown as StripeFinancialObjectCompatibility).invoice);
  }
  await applyReferralFinancialProviderFact({
    stripeEventId: eventId,
    stripeEventType: eventType,
    providerEventCreated: eventCreated,
    providerObjectId: refund.id,
    livemode,
    kind: "refund",
    stripeInvoiceId: invoiceId,
    stripeRefundId: refund.id,
    stripeChargeId: chargeId,
    currency: refund.currency ?? null,
    amount: refund.amount ?? null,
    netRevenueDelta: -(refund.amount ?? 0),
    raw: {
      refundId: refund.id,
      chargeId,
      invoiceId,
      status: refund.status ?? null,
    },
  }, executor);
}

async function handleReferralCreditNote(creditNote: Stripe.CreditNote, eventId: string, eventType: string, eventCreated?: number, executor: DatabaseExecutor = getDb()): Promise<void> {
  const livemode = creditNote.livemode === true;
  const invoiceId = objectId((creditNote as unknown as StripeFinancialObjectCompatibility).invoice);
  if (livemode) {
    await parkReferralFinancialProviderEvent({
      stripeEventId: eventId,
      stripeEventType: eventType,
      providerObjectId: creditNote.id,
      livemode,
      raw: {
        creditNoteId: creditNote.id,
        invoiceId,
        status: creditNote.status ?? null,
      },
      code: "provider_live_mode",
      message: "Referral credit-note event was live mode; local-only v1 parks it without folding.",
    }, executor);
    return;
  }
  await applyReferralFinancialProviderFact({
    stripeEventId: eventId,
    stripeEventType: eventType,
    providerEventCreated: eventCreated,
    providerObjectId: creditNote.id,
    livemode,
    kind: "credit_note",
    stripeInvoiceId: invoiceId,
    stripeCreditNoteId: creditNote.id,
    currency: creditNote.currency ?? null,
    amount: creditNote.total ?? null,
    netRevenueDelta: -(creditNote.total ?? 0),
    fullEconomicReversal: false,
    raw: {
      creditNoteId: creditNote.id,
      invoiceId,
      status: eventType === "credit_note.voided" ? "voided" : (creditNote.status ?? null),
    },
  }, executor);
}

async function handleReferralDispute(dispute: Stripe.Dispute, eventId: string, eventType: string, eventCreated?: number, executor: DatabaseExecutor = getDb()): Promise<void> {
  const livemode = dispute.livemode === true;
  const compatibleDispute = dispute as unknown as StripeFinancialObjectCompatibility;
  const chargeId = objectId(compatibleDispute.charge);
  let invoiceId = objectId(compatibleDispute.invoice);
  if (livemode) {
    await parkReferralFinancialProviderEvent({
      stripeEventId: eventId,
      stripeEventType: eventType,
      providerObjectId: dispute.id,
      livemode,
      raw: {
        disputeId: dispute.id,
        chargeId,
        invoiceId,
        status: dispute.status ?? null,
      },
      code: "provider_live_mode",
      message: "Referral dispute event was live mode; local-only v1 parks it without provider reads.",
    }, executor);
    return;
  }
  if (!invoiceId && chargeId) {
    const charge = await getReferralStripe().charges.retrieve(chargeId, { expand: ["invoice"] });
    invoiceId = objectId((charge as unknown as StripeFinancialObjectCompatibility).invoice);
  }
  const kind = eventType === "charge.dispute.created"
    ? "dispute_opened"
    : dispute.status === "won"
      ? "dispute_won"
      : dispute.status === "lost"
        ? "dispute_lost"
        : null;
  if (!kind) {
    await parkReferralFinancialProviderEvent({
      stripeEventId: eventId,
      stripeEventType: eventType,
      providerObjectId: dispute.id,
      livemode,
      raw: {
        disputeId: dispute.id,
        chargeId,
        invoiceId,
        status: dispute.status ?? null,
      },
      message: "Referral dispute close status is not a canonical won/lost terminal state.",
    }, executor);
    return;
  }
  await applyReferralFinancialProviderFact({
    stripeEventId: eventId,
    stripeEventType: eventType,
    providerEventCreated: eventCreated,
    providerObjectId: dispute.id,
    livemode,
    kind,
    stripeInvoiceId: invoiceId,
    stripeDisputeId: dispute.id,
    stripeChargeId: chargeId,
    currency: dispute.currency ?? null,
    amount: dispute.amount ?? null,
    netRevenueDelta: kind === "dispute_won" ? 0 : -(dispute.amount ?? 0),
    fullEconomicReversal: kind === "dispute_lost",
    raw: {
      disputeId: dispute.id,
      chargeId,
      invoiceId,
      status: dispute.status ?? null,
    },
  }, executor);
}

async function handleInvoicePaymentFailed(invoice: Stripe.Invoice, eventId: string): Promise<void> {
  const subscriptionId = getInvoiceSubscriptionId(invoice);
  traceBillingEvent("billing.invoice.payment_failed.received", {
    stripe_subscription_present: Boolean(subscriptionId),
    stripe_event_id_present: Boolean(eventId),
  });
  if (!subscriptionId) return;

  const stripe = getStripe();
  const stripeSub = await stripe.subscriptions.retrieve(subscriptionId);
  await syncStripeSubscriptionProjection(stripeSub, {
    eventId,
    overrideStatus: "past_due",
  });
}

async function handleSubscriptionUpdated(stripeSub: Stripe.Subscription, eventId: string): Promise<void> {
  traceBillingEvent("billing.subscription.updated.received", {
    stripe_subscription_present: Boolean(stripeSub.id),
    stripe_status: stripeSub.status,
    stripe_event_id_present: Boolean(eventId),
  });
  await syncStripeSubscriptionProjection(stripeSub, { eventId });
}

async function handleSubscriptionDeleted(stripeSub: Stripe.Subscription, eventId: string): Promise<void> {
  traceBillingEvent("billing.subscription.deleted.received", {
    stripe_subscription_present: Boolean(stripeSub.id),
    stripe_status: stripeSub.status,
    stripe_event_id_present: Boolean(eventId),
  });
  await syncStripeSubscriptionProjection(stripeSub, {
    eventId,
    overrideStatus: "canceled",
  });
}

async function syncStripeSubscriptionProjection(
  stripeSub: Stripe.Subscription,
  opts: {
    serverId?: string | null;
    customerId?: string | null;
    userId?: string | null;
    eventId?: string | null;
    fallbackPlan?: PaidBillingPlan | null;
    overrideStatus?: "active" | "past_due" | "canceled" | "incomplete";
  } = {},
): Promise<void> {
  traceBillingEvent("billing.subscription_projection.sync_started", {
    server_id_present: Boolean(opts.serverId ?? stripeSub.metadata?.serverId),
    billing_trace_id: toBillingTraceId(stripeSub.metadata?.billingTraceId),
    stripe_subscription_present: Boolean(stripeSub.id),
    stripe_customer_present: Boolean(stripeSub.customer ?? opts.customerId),
    stripe_status: stripeSub.status,
    stripe_event_id_present: Boolean(opts.eventId),
    override_status: opts.overrideStatus ?? null,
  });
  const db = getDb();
  const [existing] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.stripeSubscriptionId, stripeSub.id));

  const serverId = opts.serverId ?? stripeSub.metadata?.serverId ?? existing?.serverId;
  if (!serverId) {
    traceBillingEvent("billing.subscription_projection.skipped", {
      reason: "missing_server_id",
      billing_trace_id: toBillingTraceId(stripeSub.metadata?.billingTraceId),
      stripe_subscription_present: Boolean(stripeSub.id),
    });
    console.warn(`[Billing] Cannot reconcile Stripe subscription ${stripeSub.id}: missing serverId metadata`);
    return;
  }
  const [srv] = await db.select({ id: servers.id, plan: servers.plan }).from(servers)
    .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)));
  if (!srv) {
    traceBillingEvent("billing.subscription_projection.skipped", {
      server_id: serverId,
      billing_trace_id: toBillingTraceId(stripeSub.metadata?.billingTraceId),
      reason: "deleted_server",
    });
    console.log(`[Billing] Skipping subscription sync for deleted server ${serverId}`);
    return;
  }

  const existingPlan = existing?.plan === "pro" ? existing.plan : null;
  const projection = buildProjectionFromStripeSubscription(stripeSub, opts.fallbackPlan ?? existingPlan);
  if (!projection) {
    traceBillingEvent("billing.subscription_projection.skipped", {
      server_id: serverId,
      billing_trace_id: toBillingTraceId(stripeSub.metadata?.billingTraceId),
      reason: "missing_projection",
      stripe_subscription_present: Boolean(stripeSub.id),
    });
    console.warn(`[Billing] Cannot reconcile Stripe subscription ${stripeSub.id}: missing plan metadata or recognized price id`);
    return;
  }

  const status = opts.overrideStatus ?? mapStripeStatus(stripeSub.status);
  const customerId = opts.customerId ?? getStripeCustomerId(stripeSub.customer) ?? existing?.stripeCustomerId;
  if (!customerId) {
    traceBillingEvent("billing.subscription_projection.skipped", {
      server_id: serverId,
      billing_trace_id: toBillingTraceId(stripeSub.metadata?.billingTraceId),
      reason: "missing_customer_id",
      stripe_subscription_present: Boolean(stripeSub.id),
    });
    console.warn(`[Billing] Cannot reconcile Stripe subscription ${stripeSub.id}: missing customer id`);
    return;
  }
  const userId = opts.userId ?? stripeSub.metadata?.userId ?? existing?.createdByUserId ?? null;
  const now = new Date();
  const currentPeriodStart = getPeriodStart(stripeSub);
  const currentPeriodEnd = getPeriodEnd(stripeSub);
  const cancelAtPeriodEnd = isStripeSubscriptionScheduledToCancel(stripeSub);
  const serverInternalPlan = srv.plan === "founder" || srv.plan === "partner" ? srv.plan : null;
  const nextPlan: ServerPlan = serverInternalPlan ?? (isEntitlingStatus(status) ? projection.plan : "free");
  const shouldBroadcast = !existing
    || srv.plan !== nextPlan
    || existing.provider !== "stripe"
    || existing.stripeCustomerId !== customerId
    || existing.stripeSubscriptionId !== stripeSub.id
    || existing.plan !== projection.plan
    || existing.billingInterval !== projection.billingInterval
    || existing.stripeProPackItemId !== projection.stripeProPackItemId
    || existing.status !== status
    || existing.provisionedHumanSeats !== projection.provisionedHumanSeats
    || existing.provisionedAgentSeats !== projection.provisionedAgentSeats
    || existing.proPackQuantity !== projection.proPackQuantity
    || existing.trialFreePackQuantity !== projection.trialFreePackQuantity
    || !sameTimestamp(existing.firstPackTrialEndsAt, projection.firstPackTrialEndsAt)
    || !sameTimestamp(existing.currentPeriodStart, currentPeriodStart)
    || !sameTimestamp(existing.currentPeriodEnd, currentPeriodEnd)
    || existing.cancelAtPeriodEnd !== cancelAtPeriodEnd;

  await db.insert(subscriptions).values({
    serverId,
    provider: "stripe",
    stripeCustomerId: customerId,
    stripeSubscriptionId: stripeSub.id,
    plan: projection.plan,
    billingInterval: projection.billingInterval,
    stripeProPackItemId: projection.stripeProPackItemId,
    status,
    provisionedHumanSeats: projection.provisionedHumanSeats,
    provisionedAgentSeats: projection.provisionedAgentSeats,
    proPackQuantity: projection.proPackQuantity,
    trialFreePackQuantity: projection.trialFreePackQuantity,
    firstPackTrialEndsAt: projection.firstPackTrialEndsAt,
    currentPeriodStart,
    currentPeriodEnd,
    cancelAtPeriodEnd,
    createdByUserId: userId,
    updatedByUserId: userId,
    lastProviderEventId: opts.eventId ?? null,
  }).onConflictDoUpdate({
    target: subscriptions.serverId,
    set: {
      provider: "stripe",
      stripeCustomerId: customerId,
      stripeSubscriptionId: stripeSub.id,
      plan: projection.plan,
      billingInterval: projection.billingInterval,
      stripeProPackItemId: projection.stripeProPackItemId,
      status,
      provisionedHumanSeats: projection.provisionedHumanSeats,
      provisionedAgentSeats: projection.provisionedAgentSeats,
      proPackQuantity: projection.proPackQuantity,
      trialFreePackQuantity: projection.trialFreePackQuantity,
      firstPackTrialEndsAt: projection.firstPackTrialEndsAt,
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd,
      updatedByUserId: userId,
      lastProviderEventId: opts.eventId ?? null,
      updatedAt: now,
    },
  });

  await db
    .update(servers)
    .set({
      plan: nextPlan,
      planDowngradedAt: isEntitlingStatus(status) ? null : new Date(),
      updatedAt: now,
    })
    .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)));

  // Contract v0.3 §18.8: a plan change can move a joint over (or back within)
  // its free-server cap. Observe it now instead of waiting for the hourly
  // sweep. Best effort: the sweep is the backstop if this fails.
  try {
    const { reconcileJointsForServer } = await import("./jointChannelLimitService");
    await reconcileJointsForServer(serverId, new Date(now));
  } catch (err) {
    console.error(`[Billing] Joint over-limit reconcile failed for server ${serverId}:`, err instanceof Error ? err.message : err);
  }

  if (shouldBroadcast) {
    console.log(`[Billing] Synced Stripe subscription ${stripeSub.id} for server ${serverId}: ${projection.plan}/${status}`);
    broadcastPlanChange(serverId, nextPlan);
  }
  traceBillingEvent("billing.subscription_projection.synced", {
    server_id: serverId,
    billing_trace_id: toBillingTraceId(stripeSub.metadata?.billingTraceId),
    previous_server_plan: srv.plan,
    next_server_plan: nextPlan,
    plan: projection.plan,
    status,
    billing_interval: projection.billingInterval,
    provisioned_human_seats: projection.provisionedHumanSeats,
    provisioned_agent_seats: projection.provisionedAgentSeats,
    seat_quantity: projection.proPackQuantity,
    trial_free_pack_quantity: projection.trialFreePackQuantity,
    first_pack_trial_ends_at_present: Boolean(projection.firstPackTrialEndsAt),
    current_period_start_present: Boolean(currentPeriodStart),
    current_period_end_present: Boolean(currentPeriodEnd),
    cancel_at_period_end: cancelAtPeriodEnd,
    stripe_subscription_present: Boolean(stripeSub.id),
    stripe_customer_present: Boolean(customerId),
    stripe_event_id_present: Boolean(opts.eventId),
    broadcast_sent: shouldBroadcast,
  });
}

// ── Webhook Event Cleanup ──

/** Delete webhook events older than 48 hours. Called periodically from server.ts. */
export async function cleanupWebhookEvents(): Promise<void> {
  const db = getDb();
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - 48);
  const result = await db.delete(webhookEvents).where(and(
    eq(webhookEvents.status, "processed"),
    lt(webhookEvents.processedAt, cutoff),
  ));
  if (result.rowCount && result.rowCount > 0) {
    console.log(`[Billing] Cleaned up ${result.rowCount} old webhook events`);
  }
  traceBillingEvent("billing.webhook.cleanup.finished", {
    deleted_event_count: result.rowCount ?? 0,
  });
}
