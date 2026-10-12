CREATE TABLE "billing_paid_history_coverage" (
	"environment" text NOT NULL,
	"livemode" boolean NOT NULL,
	"coverage_origin_at" timestamp with time zone NOT NULL,
	"coverage_watermark_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"source" text NOT NULL,
	"audit_actor" text,
	"audit_reason" text NOT NULL,
	"unresolved_identity_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_paid_history_coverage_environment_livemode_pk" PRIMARY KEY("environment","livemode"),
	CONSTRAINT "billing_paid_history_coverage_unresolved_nonnegative" CHECK ("billing_paid_history_coverage"."unresolved_identity_count" >= 0),
	CONSTRAINT "billing_paid_history_coverage_window_valid" CHECK ("billing_paid_history_coverage"."coverage_watermark_at" >= "billing_paid_history_coverage"."coverage_origin_at"),
	CONSTRAINT "billing_paid_history_coverage_completed_covers_window" CHECK ("billing_paid_history_coverage"."completed_at" IS NULL OR "billing_paid_history_coverage"."completed_at" >= "billing_paid_history_coverage"."coverage_watermark_at")
);
--> statement-breakpoint
CREATE TABLE "billing_paid_identity_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"environment" text NOT NULL,
	"livemode" boolean NOT NULL,
	"stripe_event_id" text NOT NULL,
	"stripe_invoice_id" text NOT NULL,
	"stripe_subscription_id" text,
	"stripe_customer_id" text,
	"paid_fact_kind" text NOT NULL,
	"stripe_product_id" text NOT NULL,
	"stripe_price_id" text NOT NULL,
	"server_id" uuid,
	"payer_user_id" uuid,
	"owner_user_id" uuid,
	"identity_resolution_state" text NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"currency" text NOT NULL,
	"invoice_subtotal" integer NOT NULL,
	"invoice_total" integer NOT NULL,
	"amount_paid" integer NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_paid_identity_events_identity_state_consistent" CHECK ((
      "billing_paid_identity_events"."identity_resolution_state" = 'resolved'
      AND "billing_paid_identity_events"."server_id" IS NOT NULL
      AND "billing_paid_identity_events"."payer_user_id" IS NOT NULL
      AND "billing_paid_identity_events"."owner_user_id" IS NOT NULL
    ) OR "billing_paid_identity_events"."identity_resolution_state" = 'parked'),
	CONSTRAINT "billing_paid_identity_events_amounts_nonnegative" CHECK ("billing_paid_identity_events"."invoice_subtotal" >= 0 AND "billing_paid_identity_events"."invoice_total" >= 0 AND "billing_paid_identity_events"."amount_paid" >= 0),
	CONSTRAINT "billing_paid_identity_events_currency_lower" CHECK ("billing_paid_identity_events"."currency" = lower("billing_paid_identity_events"."currency")),
	CONSTRAINT "billing_paid_identity_events_fact_kind_known" CHECK ("billing_paid_identity_events"."paid_fact_kind" = 'pro_invoice_paid'),
	CONSTRAINT "billing_paid_identity_events_identity_state_known" CHECK ("billing_paid_identity_events"."identity_resolution_state" IN ('resolved', 'parked'))
);
--> statement-breakpoint
CREATE TABLE "billing_paid_identity_resolutions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"paid_identity_event_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"payer_user_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"audit_actor" text,
	"audit_reason" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referral_discount_campaigns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"provider_state" text DEFAULT 'pending' NOT NULL,
	"provider_provisioning_started_at" timestamp with time zone,
	"stripe_coupon_id" text,
	"provider_strategy" text NOT NULL,
	"provider_error_code" text,
	"provider_error_message" text,
	"provider_synced_at" timestamp with time zone,
	"percent_off" integer NOT NULL,
	"duration_months" integer NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"product_scope" text DEFAULT 'pro' NOT NULL,
	"billing_interval_scope" text DEFAULT 'both' NOT NULL,
	"max_paid_redemptions" integer,
	"live_reserved_count" integer DEFAULT 0 NOT NULL,
	"qualified_count" integer DEFAULT 0 NOT NULL,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"mutation_reason" text NOT NULL,
	CONSTRAINT "referral_discount_campaigns_percent_range" CHECK ("referral_discount_campaigns"."percent_off" > 0 AND "referral_discount_campaigns"."percent_off" <= 100),
	CONSTRAINT "referral_discount_campaigns_duration_positive" CHECK ("referral_discount_campaigns"."duration_months" > 0),
	CONSTRAINT "referral_discount_campaigns_currency_lower" CHECK ("referral_discount_campaigns"."currency" = lower("referral_discount_campaigns"."currency")),
	CONSTRAINT "referral_discount_campaigns_counts_nonnegative" CHECK ("referral_discount_campaigns"."live_reserved_count" >= 0 AND "referral_discount_campaigns"."qualified_count" >= 0),
	CONSTRAINT "referral_discount_campaigns_cap_nonnegative" CHECK ("referral_discount_campaigns"."max_paid_redemptions" IS NULL OR "referral_discount_campaigns"."max_paid_redemptions" >= 0),
	CONSTRAINT "referral_discount_campaigns_counts_within_cap" CHECK ("referral_discount_campaigns"."max_paid_redemptions" IS NULL OR ("referral_discount_campaigns"."live_reserved_count" + "referral_discount_campaigns"."qualified_count") <= "referral_discount_campaigns"."max_paid_redemptions"),
	CONSTRAINT "referral_discount_campaigns_status_known" CHECK ("referral_discount_campaigns"."status" IN ('draft', 'active', 'paused', 'archived')),
	CONSTRAINT "referral_discount_campaigns_provider_state_known" CHECK ("referral_discount_campaigns"."provider_state" IN ('pending', 'ready', 'failed', 'disabled')),
	CONSTRAINT "referral_discount_campaigns_product_scope_known" CHECK ("referral_discount_campaigns"."product_scope" = 'pro'),
	CONSTRAINT "referral_discount_campaigns_billing_interval_scope_known" CHECK ("referral_discount_campaigns"."billing_interval_scope" IN ('monthly', 'annual', 'both'))
);
--> statement-breakpoint
CREATE TABLE "referral_discount_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"referrer_user_id" uuid NOT NULL,
	"display_code" text NOT NULL,
	"normalized_code" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"provider_state" text DEFAULT 'pending' NOT NULL,
	"provider_provisioning_started_at" timestamp with time zone,
	"stripe_promotion_code_id" text,
	"provider_error_code" text,
	"provider_error_message" text,
	"provider_synced_at" timestamp with time zone,
	"max_paid_redemptions" integer,
	"live_reserved_count" integer DEFAULT 0 NOT NULL,
	"qualified_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"issued_by_user_id" uuid,
	"issued_reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_discount_codes_normalized_lower" CHECK ("referral_discount_codes"."normalized_code" = lower("referral_discount_codes"."normalized_code")),
	CONSTRAINT "referral_discount_codes_counts_nonnegative" CHECK ("referral_discount_codes"."live_reserved_count" >= 0 AND "referral_discount_codes"."qualified_count" >= 0),
	CONSTRAINT "referral_discount_codes_cap_nonnegative" CHECK ("referral_discount_codes"."max_paid_redemptions" IS NULL OR "referral_discount_codes"."max_paid_redemptions" >= 0),
	CONSTRAINT "referral_discount_codes_counts_within_cap" CHECK ("referral_discount_codes"."max_paid_redemptions" IS NULL OR ("referral_discount_codes"."live_reserved_count" + "referral_discount_codes"."qualified_count") <= "referral_discount_codes"."max_paid_redemptions"),
	CONSTRAINT "referral_discount_codes_status_known" CHECK ("referral_discount_codes"."status" IN ('active', 'paused', 'revoked', 'expired')),
	CONSTRAINT "referral_discount_codes_provider_state_known" CHECK ("referral_discount_codes"."provider_state" IN ('pending', 'ready', 'failed', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "referral_discount_financial_adjustment_resolutions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"financial_adjustment_id" uuid NOT NULL,
	"redemption_id" uuid NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"audit_actor" text,
	"audit_reason" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referral_discount_financial_adjustments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"environment" text NOT NULL,
	"livemode" boolean NOT NULL,
	"kind" text NOT NULL,
	"provider_fact_id" text NOT NULL,
	"stripe_event_id" text NOT NULL,
	"stripe_invoice_id" text NOT NULL,
	"stripe_refund_id" text,
	"stripe_credit_note_id" text,
	"stripe_dispute_id" text,
	"stripe_charge_id" text,
	"currency" text NOT NULL,
	"amount" integer NOT NULL,
	"net_revenue_delta" integer NOT NULL,
	"full_economic_reversal" boolean DEFAULT false NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sanitized_reason" text,
	"observed_redemption_id" uuid,
	"resolved_redemption_id" uuid,
	"processing_state" text DEFAULT 'parked' NOT NULL,
	"applied_at" timestamp with time zone,
	CONSTRAINT "referral_discount_adjustments_amount_nonnegative" CHECK ("referral_discount_financial_adjustments"."amount" >= 0),
	CONSTRAINT "referral_discount_adjustments_currency_lower" CHECK ("referral_discount_financial_adjustments"."currency" = lower("referral_discount_financial_adjustments"."currency")),
	CONSTRAINT "referral_discount_adjustments_kind_known" CHECK ("referral_discount_financial_adjustments"."kind" IN ('refund', 'credit_note', 'dispute_opened', 'dispute_won', 'dispute_lost')),
	CONSTRAINT "referral_discount_adjustments_processing_state_known" CHECK ("referral_discount_financial_adjustments"."processing_state" IN ('parked', 'applied')),
	CONSTRAINT "referral_discount_adjustments_applied_has_redemption" CHECK ("referral_discount_financial_adjustments"."processing_state" <> 'applied' OR ("referral_discount_financial_adjustments"."resolved_redemption_id" IS NOT NULL AND "referral_discount_financial_adjustments"."applied_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "referral_discount_redemptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"code_id" uuid NOT NULL,
	"referrer_user_id" uuid NOT NULL,
	"referred_server_id" uuid NOT NULL,
	"redeeming_user_id" uuid NOT NULL,
	"stripe_customer_id" text,
	"stripe_checkout_session_id" text,
	"stripe_subscription_id" text,
	"first_paid_invoice_id" text,
	"acquisition_state" text DEFAULT 'reserved' NOT NULL,
	"qualification_disposition" text DEFAULT 'none' NOT NULL,
	"financial_risk" text DEFAULT 'clear' NOT NULL,
	"cap_slot_state" text DEFAULT 'held' NOT NULL,
	"reservation_expires_at" timestamp with time zone NOT NULL,
	"referral_checkout_idempotency_key" text,
	"internal_reason" text,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checkout_created_at" timestamp with time zone,
	"checkout_completed_at" timestamp with time zone,
	"qualified_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_discount_redemptions_qualification_consistent" CHECK ((
      "referral_discount_redemptions"."acquisition_state" = 'qualified'
      AND "referral_discount_redemptions"."qualification_disposition" IN ('qualified', 'reversed')
      AND "referral_discount_redemptions"."cap_slot_state" = 'consumed'
    ) OR (
      "referral_discount_redemptions"."acquisition_state" <> 'qualified'
      AND "referral_discount_redemptions"."qualification_disposition" = 'none'
    )),
	CONSTRAINT "referral_discount_redemptions_cap_slot_consistent" CHECK ((
      "referral_discount_redemptions"."acquisition_state" IN ('reserved', 'checkout_created', 'checkout_completed')
      AND "referral_discount_redemptions"."cap_slot_state" = 'held'
    ) OR (
      "referral_discount_redemptions"."acquisition_state" = 'qualified'
      AND "referral_discount_redemptions"."cap_slot_state" = 'consumed'
    ) OR (
      "referral_discount_redemptions"."acquisition_state" IN ('checkout_expired', 'void')
      AND "referral_discount_redemptions"."cap_slot_state" = 'released'
    )),
	CONSTRAINT "referral_discount_redemptions_acquisition_state_known" CHECK ("referral_discount_redemptions"."acquisition_state" IN ('reserved', 'checkout_created', 'checkout_completed', 'qualified', 'checkout_expired', 'void')),
	CONSTRAINT "referral_discount_redemptions_disposition_known" CHECK ("referral_discount_redemptions"."qualification_disposition" IN ('none', 'qualified', 'reversed')),
	CONSTRAINT "referral_discount_redemptions_financial_risk_known" CHECK ("referral_discount_redemptions"."financial_risk" IN ('clear', 'disputed')),
	CONSTRAINT "referral_discount_redemptions_cap_slot_known" CHECK ("referral_discount_redemptions"."cap_slot_state" IN ('held', 'consumed', 'released'))
);
--> statement-breakpoint
ALTER TABLE "billing_paid_identity_resolutions" ADD CONSTRAINT "billing_paid_identity_resolutions_paid_identity_event_id_billing_paid_identity_events_id_fk" FOREIGN KEY ("paid_identity_event_id") REFERENCES "public"."billing_paid_identity_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_discount_campaigns" ADD CONSTRAINT "referral_discount_campaigns_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_discount_codes" ADD CONSTRAINT "referral_discount_codes_campaign_id_referral_discount_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."referral_discount_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_discount_codes" ADD CONSTRAINT "referral_discount_codes_referrer_user_id_users_id_fk" FOREIGN KEY ("referrer_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_discount_codes" ADD CONSTRAINT "referral_discount_codes_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_discount_financial_adjustment_resolutions" ADD CONSTRAINT "referral_discount_financial_adjustment_resolutions_financial_adjustment_id_referral_discount_financial_adjustments_id_fk" FOREIGN KEY ("financial_adjustment_id") REFERENCES "public"."referral_discount_financial_adjustments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_discount_financial_adjustment_resolutions" ADD CONSTRAINT "referral_discount_financial_adjustment_resolutions_redemption_id_referral_discount_redemptions_id_fk" FOREIGN KEY ("redemption_id") REFERENCES "public"."referral_discount_redemptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_discount_financial_adjustments" ADD CONSTRAINT "referral_discount_financial_adjustments_observed_redemption_id_referral_discount_redemptions_id_fk" FOREIGN KEY ("observed_redemption_id") REFERENCES "public"."referral_discount_redemptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_discount_financial_adjustments" ADD CONSTRAINT "referral_discount_financial_adjustments_resolved_redemption_id_referral_discount_redemptions_id_fk" FOREIGN KEY ("resolved_redemption_id") REFERENCES "public"."referral_discount_redemptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_discount_redemptions" ADD CONSTRAINT "referral_discount_redemptions_campaign_id_referral_discount_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."referral_discount_campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_discount_redemptions" ADD CONSTRAINT "referral_discount_redemptions_code_id_referral_discount_codes_id_fk" FOREIGN KEY ("code_id") REFERENCES "public"."referral_discount_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_discount_redemptions" ADD CONSTRAINT "referral_discount_redemptions_referred_server_id_servers_id_fk" FOREIGN KEY ("referred_server_id") REFERENCES "public"."servers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_discount_redemptions" ADD CONSTRAINT "referral_discount_redemptions_redeeming_user_id_users_id_fk" FOREIGN KEY ("redeeming_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_billing_paid_identity_event_env_mode_event" ON "billing_paid_identity_events" USING btree ("environment","livemode","stripe_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_billing_paid_identity_event_env_mode_invoice" ON "billing_paid_identity_events" USING btree ("environment","livemode","stripe_invoice_id");--> statement-breakpoint
CREATE INDEX "idx_billing_paid_identity_events_server" ON "billing_paid_identity_events" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_billing_paid_identity_events_payer" ON "billing_paid_identity_events" USING btree ("payer_user_id");--> statement-breakpoint
CREATE INDEX "idx_billing_paid_identity_events_owner" ON "billing_paid_identity_events" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "idx_billing_paid_identity_events_customer" ON "billing_paid_identity_events" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_billing_paid_identity_resolutions_event" ON "billing_paid_identity_resolutions" USING btree ("paid_identity_event_id");--> statement-breakpoint
CREATE INDEX "idx_billing_paid_identity_resolutions_server" ON "billing_paid_identity_resolutions" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "idx_billing_paid_identity_resolutions_payer" ON "billing_paid_identity_resolutions" USING btree ("payer_user_id");--> statement-breakpoint
CREATE INDEX "idx_billing_paid_identity_resolutions_owner" ON "billing_paid_identity_resolutions" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_referral_discount_codes_normalized" ON "referral_discount_codes" USING btree ("normalized_code");--> statement-breakpoint
CREATE INDEX "idx_referral_discount_codes_campaign" ON "referral_discount_codes" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "idx_referral_discount_codes_referrer" ON "referral_discount_codes" USING btree ("referrer_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_referral_discount_adjustment_resolutions_adjustment" ON "referral_discount_financial_adjustment_resolutions" USING btree ("financial_adjustment_id");--> statement-breakpoint
CREATE INDEX "idx_referral_discount_adjustment_resolutions_redemption" ON "referral_discount_financial_adjustment_resolutions" USING btree ("redemption_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_referral_discount_adjustments_provider_fact" ON "referral_discount_financial_adjustments" USING btree ("environment","livemode","kind","provider_fact_id");--> statement-breakpoint
CREATE INDEX "idx_referral_discount_adjustments_observed_redemption" ON "referral_discount_financial_adjustments" USING btree ("observed_redemption_id");--> statement-breakpoint
CREATE INDEX "idx_referral_discount_adjustments_resolved_redemption" ON "referral_discount_financial_adjustments" USING btree ("resolved_redemption_id");--> statement-breakpoint
CREATE INDEX "idx_referral_discount_adjustments_invoice" ON "referral_discount_financial_adjustments" USING btree ("stripe_invoice_id");--> statement-breakpoint
CREATE INDEX "idx_referral_discount_redemptions_campaign" ON "referral_discount_redemptions" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "idx_referral_discount_redemptions_code" ON "referral_discount_redemptions" USING btree ("code_id");--> statement-breakpoint
CREATE INDEX "idx_referral_discount_redemptions_server" ON "referral_discount_redemptions" USING btree ("referred_server_id");--> statement-breakpoint
CREATE INDEX "idx_referral_discount_redemptions_redeeming_user" ON "referral_discount_redemptions" USING btree ("redeeming_user_id");--> statement-breakpoint
CREATE INDEX "idx_referral_discount_redemptions_customer" ON "referral_discount_redemptions" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_referral_discount_redemptions_session" ON "referral_discount_redemptions" USING btree ("stripe_checkout_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_referral_discount_redemptions_invoice" ON "referral_discount_redemptions" USING btree ("first_paid_invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_referral_discount_redemptions_active_server" ON "referral_discount_redemptions" USING btree ("referred_server_id") WHERE "referral_discount_redemptions"."acquisition_state" IN ('reserved', 'checkout_created', 'checkout_completed');--> statement-breakpoint
CREATE UNIQUE INDEX "idx_referral_discount_redemptions_active_user" ON "referral_discount_redemptions" USING btree ("redeeming_user_id") WHERE "referral_discount_redemptions"."acquisition_state" IN ('reserved', 'checkout_created', 'checkout_completed');--> statement-breakpoint
CREATE UNIQUE INDEX "idx_referral_discount_redemptions_active_customer" ON "referral_discount_redemptions" USING btree ("stripe_customer_id") WHERE "referral_discount_redemptions"."stripe_customer_id" IS NOT NULL AND "referral_discount_redemptions"."acquisition_state" IN ('reserved', 'checkout_created', 'checkout_completed');--> statement-breakpoint
CREATE UNIQUE INDEX "idx_referral_discount_redemptions_success_server" ON "referral_discount_redemptions" USING btree ("referred_server_id") WHERE "referral_discount_redemptions"."acquisition_state" = 'qualified';--> statement-breakpoint
CREATE UNIQUE INDEX "idx_referral_discount_redemptions_success_user" ON "referral_discount_redemptions" USING btree ("redeeming_user_id") WHERE "referral_discount_redemptions"."acquisition_state" = 'qualified';--> statement-breakpoint
CREATE UNIQUE INDEX "idx_referral_discount_redemptions_success_customer" ON "referral_discount_redemptions" USING btree ("stripe_customer_id") WHERE "referral_discount_redemptions"."stripe_customer_id" IS NOT NULL AND "referral_discount_redemptions"."acquisition_state" = 'qualified';