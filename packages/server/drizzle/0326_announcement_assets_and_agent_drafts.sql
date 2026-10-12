CREATE TABLE "announcement_image_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_by_user_id" uuid,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unreferenced_since" timestamp with time zone,
	"deleting_at" timestamp with time zone,
	CONSTRAINT "announcement_image_assets_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
ALTER TABLE "announcement_audit_events" ADD COLUMN "actor_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "created_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "updated_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "announcement_image_assets" ADD CONSTRAINT "announcement_image_assets_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_image_assets" ADD CONSTRAINT "announcement_image_assets_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_audit_events" ADD CONSTRAINT "announcement_audit_events_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;