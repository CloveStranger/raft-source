ALTER TABLE "referral_discount_redemptions" ADD COLUMN "target_product_scope" text DEFAULT 'pro' NOT NULL;--> statement-breakpoint
ALTER TABLE "referral_discount_redemptions" ADD COLUMN "target_billing_interval" text DEFAULT 'monthly' NOT NULL;--> statement-breakpoint
ALTER TABLE "referral_discount_redemptions" ADD CONSTRAINT "referral_discount_redemptions_product_scope_known" CHECK ("referral_discount_redemptions"."target_product_scope" = 'pro');--> statement-breakpoint
ALTER TABLE "referral_discount_redemptions" ADD CONSTRAINT "referral_discount_redemptions_billing_interval_known" CHECK ("referral_discount_redemptions"."target_billing_interval" IN ('monthly', 'annual'));--> statement-breakpoint
CREATE TABLE "referral_discount_provider_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"environment" text NOT NULL,
	"livemode" boolean NOT NULL,
	"stripe_event_id" text NOT NULL,
	"stripe_event_type" text NOT NULL,
	"provider_object_id" text,
	"source_api_version" text,
	"payload_hash" text NOT NULL,
	"normalized_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"processing_state" text DEFAULT 'parked' NOT NULL,
	"sanitized_error_code" text,
	"sanitized_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_discount_provider_events_processing_state_known" CHECK ("referral_discount_provider_events"."processing_state" IN ('parked', 'applied'))
);
--> statement-breakpoint
CREATE TABLE "referral_discount_provider_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"environment" text NOT NULL,
	"livemode" boolean NOT NULL,
	"operation_type" text NOT NULL,
	"local_target_id" uuid NOT NULL,
	"state" text DEFAULT 'intent' NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"request_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider_object_id" text,
	"provider_request_id" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"sanitized_error_code" text,
	"sanitized_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_discount_provider_operations_operation_known" CHECK ("referral_discount_provider_operations"."operation_type" IN ('campaign_coupon_create', 'code_promotion_create', 'checkout_session_create')),
	CONSTRAINT "referral_discount_provider_operations_state_known" CHECK ("referral_discount_provider_operations"."state" IN ('intent', 'provider_started', 'confirmed', 'failed', 'parked')),
	CONSTRAINT "referral_discount_provider_operations_attempts_nonnegative" CHECK ("referral_discount_provider_operations"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "referral_discount_financial_adjustments" ADD COLUMN "provider_fact_sequence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DROP INDEX "idx_referral_discount_adjustments_provider_fact";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_referral_discount_adjustments_provider_fact" ON "referral_discount_financial_adjustments" USING btree ("environment","livemode","kind","provider_fact_id","stripe_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_referral_discount_provider_events_event" ON "referral_discount_provider_events" USING btree ("environment","livemode","stripe_event_id");--> statement-breakpoint
CREATE INDEX "idx_referral_discount_provider_events_object" ON "referral_discount_provider_events" USING btree ("provider_object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_referral_discount_provider_operations_target" ON "referral_discount_provider_operations" USING btree ("environment","livemode","operation_type","local_target_id");--> statement-breakpoint
CREATE INDEX "idx_referral_discount_provider_operations_state" ON "referral_discount_provider_operations" USING btree ("state");