-- RFC 074 §2 assistant doorbell. Additive, metadata-only on existing tables:
-- third_party_agent_events.client_id becomes nullable and a system_app column
-- is added, so a Raft system app ("system.assistant") can store events in the
-- same table (same delivery, push, rebuild, re-read and Agent panel paths).
-- The exactly-one-source check is added NOT VALID and validated separately
-- (every existing row has a client_id, so it holds). agents and servers are
-- hot: the new table's FKs only lock them briefly, and a 5s lock timeout
-- (the deploy retries) keeps this DDL from queueing writes behind it.
--
-- Also the backstop for "an assistant is only in its DM with its owner": a
-- deferred constraint trigger on channel_agents (checked at commit, so the
-- DM's human row may be written after its agent row in the same transaction).
-- The application refuses earlier with a clear error on the known paths
-- (addAgent, DM creation, sends); this catches every other insert path.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "assistant_doorbells" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"first_change_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant_doorbells" ADD CONSTRAINT "assistant_doorbells_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_doorbells" ADD CONSTRAINT "assistant_doorbells_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "third_party_agent_events" ALTER COLUMN "client_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "third_party_agent_events" ADD COLUMN "system_app" text;--> statement-breakpoint
ALTER TABLE "third_party_agent_events" ADD CONSTRAINT "third_party_agent_events_one_source" CHECK (num_nonnulls("third_party_agent_events"."client_id", "third_party_agent_events"."system_app") = 1) NOT VALID;--> statement-breakpoint
ALTER TABLE "third_party_agent_events" VALIDATE CONSTRAINT "third_party_agent_events_one_source";--> statement-breakpoint
CREATE OR REPLACE FUNCTION "assistant_channel_agents_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owner_id uuid;
BEGIN
  SELECT a."assistant_owner_user_id" INTO owner_id FROM "agents" a WHERE a."id" = NEW."agent_id";
  IF owner_id IS NULL THEN
    RETURN NULL;
  END IF;
  -- Removed again before commit: nothing to check.
  IF NOT EXISTS (
    SELECT 1 FROM "channel_agents" ca WHERE ca."channel_id" = NEW."channel_id" AND ca."agent_id" = NEW."agent_id"
  ) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM "channels" c WHERE c."id" = NEW."channel_id" AND c."type" = 'dm')
     AND EXISTS (SELECT 1 FROM "channel_humans" h WHERE h."channel_id" = NEW."channel_id" AND h."user_id" = owner_id)
     AND NOT EXISTS (SELECT 1 FROM "channel_agents" o WHERE o."channel_id" = NEW."channel_id" AND o."agent_id" <> NEW."agent_id")
  THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'A personal assistant can only be in its DM with its owner'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'assistant_channel_agents_guard';
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "assistant_channel_agents_guard"
AFTER INSERT ON "channel_agents"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "assistant_channel_agents_guard"();
