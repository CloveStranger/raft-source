-- users.trace_user_id is the only user identifier traces carry; mapping a trace
-- back to a user is a lookup on it (monitoring rules, debugging). Random by
-- construction (rotated on retire/delete, never cleared), so unique: the index
-- makes a duplicate impossible and the lookup one probe. ~31k rows, ~1MB.
-- Staging/prod build it first with
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_users_trace_user_id_unique ON users (trace_user_id);
-- so this statement is a no-op there and never holds a write lock on users.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_trace_user_id_unique" ON "users" USING btree ("trace_user_id");
