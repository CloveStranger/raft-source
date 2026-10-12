CREATE TABLE "system_attention_incidents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"account_key_hash" text NOT NULL,
	"window_key" text NOT NULL,
	"activation_generation" integer NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"affected_agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"last_observed_at" timestamp with time zone NOT NULL,
	"resets_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_attention_incidents_generation_positive" CHECK ("system_attention_incidents"."activation_generation" > 0),
	CONSTRAINT "system_attention_incidents_account_key_hash" CHECK ("system_attention_incidents"."account_key_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "system_attention_incidents_window_key" CHECK (length(btrim("system_attention_incidents"."window_key")) BETWEEN 1 AND 64),
	CONSTRAINT "system_attention_incidents_state_shape" CHECK (("system_attention_incidents"."state" = 'active' AND "system_attention_incidents"."resolved_at" IS NULL)
      OR ("system_attention_incidents"."state" = 'resolved' AND "system_attention_incidents"."resolved_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "system_attention_receipts" (
	"incident_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"seen_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_attention_receipts_incident_id_user_id_pk" PRIMARY KEY("incident_id","user_id"),
	CONSTRAINT "system_attention_receipts_dismiss_implies_seen" CHECK ("system_attention_receipts"."dismissed_at" IS NULL OR "system_attention_receipts"."seen_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "system_attention_incidents" ADD CONSTRAINT "system_attention_incidents_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_attention_incidents" ADD CONSTRAINT "system_attention_incidents_machine_id_daemons_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."daemons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_attention_receipts" ADD CONSTRAINT "system_attention_receipts_incident_id_system_attention_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."system_attention_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_attention_receipts" ADD CONSTRAINT "system_attention_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_system_attention_incidents_generation" ON "system_attention_incidents" USING btree ("server_id","machine_id","kind","provider","account_key_hash","window_key","activation_generation");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_system_attention_incidents_active_identity" ON "system_attention_incidents" USING btree ("server_id","machine_id","kind","provider","account_key_hash","window_key") WHERE "system_attention_incidents"."state" = 'active';--> statement-breakpoint
CREATE INDEX "idx_system_attention_incidents_server_state" ON "system_attention_incidents" USING btree ("server_id","state","activated_at");--> statement-breakpoint
CREATE INDEX "idx_system_attention_receipts_user" ON "system_attention_receipts" USING btree ("user_id","updated_at");
--> statement-breakpoint
INSERT INTO "feature_flags" (
	"key",
	"description",
	"enabled",
	"kill_switch",
	"randomization_unit",
	"default_enabled",
	"default_variant",
	"salt"
) VALUES (
	'usage_limit_attention_v0',
	'Durable usage-limit attention in Notifications; gated internal rollout',
	true,
	false,
	'server',
	false,
	NULL,
	'usage_limit_attention_v0'
) ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
WITH allowlist AS (
	SELECT COALESCE(jsonb_agg("id"::text ORDER BY "slug"), '[]'::jsonb) AS "server_ids"
	FROM "servers"
	WHERE "slug" = 'botiverse'
		AND "deleted_at" IS NULL
)
INSERT INTO "feature_flag_rules" (
	"id",
	"flag_key",
	"stage",
	"priority",
	"decision",
	"values",
	"percentage_basis_points",
	"variant"
)
SELECT
	'3a4a89e1-8d3c-40d7-a4b9-4d4988f2e377',
	'usage_limit_attention_v0',
	'server',
	0,
	'allow',
	"server_ids",
	NULL,
	NULL
FROM allowlist
WHERE jsonb_array_length("server_ids") > 0
ON CONFLICT ("id") DO UPDATE SET
	"values" = EXCLUDED."values",
	"updated_at" = now();
