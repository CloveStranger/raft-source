CREATE TABLE "agent_config_migrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"runtime" text NOT NULL,
	"from_value" text NOT NULL,
	"to_value" text NOT NULL,
	"before_model" text NOT NULL,
	"before_runtime_config" jsonb,
	"migrated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notice_dismissed_at" timestamp with time zone,
	"rolled_back_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_config_migrations" ADD CONSTRAINT "agent_config_migrations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_config_migrations_agent" ON "agent_config_migrations" USING btree ("agent_id");