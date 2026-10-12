-- RFC 074 §2 personal assistant v0: agents.assistant_owner_user_id.
-- Additive. agents is hot (status updates), so fail fast instead of queueing
-- every agent and users write behind this DDL: a 5s lock timeout (the deploy
-- retries), the FK added NOT VALID (no scan while holding SHARE ROW EXCLUSIVE
-- on agents and users) and validated separately under the lighter lock. The
-- new column is all NULL, so the validation is instant. The partial unique
-- index covers no rows yet; agents is small, so a plain CREATE INDEX is fine.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "assistant_owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_assistant_owner_user_id_users_id_fk" FOREIGN KEY ("assistant_owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_assistant_owner_user_id_users_id_fk";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agents_server_assistant_owner" ON "agents" USING btree ("server_id","assistant_owner_user_id") WHERE assistant_owner_user_id is not null and deleted_at is null;
