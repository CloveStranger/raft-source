ALTER TABLE "oauth_client_installs" ADD COLUMN "agent_jwt_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Pre-existing clients retain NULL only for legacy operator opt-in compatibility.
ALTER TABLE "oauth_clients" ADD COLUMN "agent_jwt_enabled" boolean;--> statement-breakpoint
ALTER TABLE "oauth_clients" ALTER COLUMN "agent_jwt_enabled" SET DEFAULT false;