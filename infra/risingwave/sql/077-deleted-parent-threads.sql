-- Threads below a deleted parent leave the human Activity. Deleting an agent soft-deletes its DM but leaves
-- the DM's threads live (channels.inbox.api.test.ts pins that). The canonical
-- Postgres read (getInboxItems: parent_ch.deleted_at IS NULL on the followed
-- and the mention arms) and rw_agent_inbox_v6 (065's parent join) drop those
-- threads; this chain did not: rw_subs_v2 and rw_inbox_mention_v6 check only the
-- thread row, so a followed thread or a leftover unread mention under a deleted
-- DM stayed in Activity, and Done (a residue no-op for an unavailable target)
-- could not remove it.
--
-- One filter at the items layer (over rw_inbox_items_v11) covers both arms: a thread row is kept only
-- while its parent (rw_thread_parent_v3, the same join rw_agent_inbox_v6 uses)
-- exists and is not deleted. The watermark's thread arm takes the same
-- condition, so those threads no longer occupy any of the 500 ranked slots.
-- Serving and totals are 076's definitions with the upstream names advanced.
-- Output columns are unchanged, so the server switch is a rename.
--
-- New names: items_v12, serving_v8, totals_v6, watermark_v6.
-- Apply after 076 (whose rw_inbox_items_v11 is the base), 067 and 063-chain-v5. Build order and names: README.

CREATE MATERIALIZED VIEW rw_activity_watermark_v6 AS
WITH structural AS (
  SELECT 'user' AS receiver_type, CAST(ch.user_id AS VARCHAR) AS receiver_id, c.id AS target_id, c.server_id
  FROM rw_channel_humans AS ch
  JOIN rw_channels AS c ON ch.channel_id = c.id AND c.type <> 'thread' AND c.deleted_at IS NULL AND c.archived_at IS NULL
  UNION ALL
  SELECT 'agent', CAST(ca.agent_id AS VARCHAR), c.id, c.server_id
  FROM rw_channel_agents AS ca
  JOIN rw_channels AS c ON ca.channel_id = c.id AND c.type <> 'thread' AND c.deleted_at IS NULL AND c.archived_at IS NULL
  UNION ALL
  SELECT tf.follower_type, CAST(tf.follower_id AS VARCHAR), c.id, c.server_id
  FROM rw_thread_follows AS tf
  JOIN rw_channels AS c ON tf.thread_channel_id = c.id AND c.deleted_at IS NULL AND c.archived_at IS NULL
  JOIN rw_thread_parent_v3 AS tp ON tp.thread_channel_id = c.id
  JOIN rw_channels AS pc ON pc.id = tp.parent_channel_id AND pc.deleted_at IS NULL
  WHERE tf.unfollowed_at IS NULL
), ranked AS (
  SELECT s.receiver_type, s.receiver_id, s.server_id, tl.latest_seq,
         ROW_NUMBER() OVER (PARTITION BY s.receiver_type, s.receiver_id, s.server_id ORDER BY tl.latest_seq DESC) AS rk
  FROM structural AS s
  JOIN rw_target_latest_v4 AS tl ON tl.target_id = s.target_id
)
-- Only a partition that actually HAS 500 targets gets a cutoff: the watermark exists to
-- cap the list at 500 targets, so below that nothing is trimmed. v4 emitted MIN over
-- whatever was there, which with fewer than 500 targets is simply the oldest target --
-- and that trimmed mention-only rows (threads the receiver does not follow are not
-- targets) older than it. Per server this bit far more often than globally (a
-- first v5 build without this guard hid rows that v4 showed).
SELECT receiver_type, receiver_id, server_id, MIN(latest_seq) AS watermark_seq
FROM ranked WHERE rk <= 500
GROUP BY receiver_type, receiver_id, server_id
HAVING COUNT(*) >= 500;

-- Wraps 076's items rather than repeating its FULL JOIN, so the build backfills
-- two point joins instead of the three arms and suppression again.
-- rw_inbox_items_v11 therefore stays as this view's base.
CREATE MATERIALIZED VIEW rw_inbox_items_v12 AS
SELECT b.* FROM rw_inbox_items_v11 AS b
LEFT JOIN rw_thread_parent_v3 AS tp ON tp.thread_channel_id = b.target_id AND b.kind = 'thread'
LEFT JOIN rw_channels AS pc ON pc.id = tp.parent_channel_id
WHERE b.kind <> 'thread' OR (pc.id IS NOT NULL AND pc.deleted_at IS NULL);

CREATE MATERIALIZED VIEW rw_inbox_serving_v8 AS SELECT p.server_id, p.receiver_type, p.receiver_id, p.kind, CASE WHEN p.kind = 'thread' THEN NULL ELSE p.target_id END AS channel_id, CASE WHEN p.kind = 'thread' THEN NULL ELSE c.name END AS channel_name, CASE WHEN p.kind = 'thread' THEN NULL ELSE c.type END AS channel_type, lm.id AS last_message_id, fu.id AS first_unread_message_id, CASE WHEN p.kind = 'thread' THEN NULL ELSE p.latest_at END AS last_message_at, CASE WHEN p.kind = 'thread' THEN NULL ELSE lm.preview END AS last_message_preview, CASE WHEN p.kind = 'thread' THEN NULL ELSE lm.sender_type END AS last_message_sender_type, CASE WHEN p.kind = 'thread' THEN NULL ELSE lm.sender_id END AS last_message_sender_id, CAST(COALESCE(p.unread_count, 0) AS INT) AS unread_count, CASE WHEN p.kind = 'thread' THEN p.target_id ELSE NULL END AS thread_channel_id, tp.parent_message_id, tp.parent_channel_id, tp.parent_channel_name, tp.parent_channel_type, pm.preview AS parent_message_preview, pm.sender_type AS parent_message_sender_type, pm.sender_id AS parent_message_sender_id, COALESCE(lm.preview, ma.preview) AS latest_activity_preview, COALESCE(lm.sender_type, ma.sender_type) AS latest_activity_sender_type, COALESCE(lm.sender_id, ma.sender_id) AS latest_activity_sender_id, COALESCE(lm.id, ma.id) AS latest_activity_message_id, COALESCE(lm.seq, ma.seq) AS latest_activity_seq, p.latest_at AS last_activity_at, CASE WHEN p.kind = 'thread' THEN p.latest_at ELSE NULL END AS last_reply_at, CASE WHEN p.kind = 'thread' THEN CAST(tl.msg_count AS INT) ELSE NULL END AS reply_count, pm.task_number, pm.task_status, pm.task_assignee_type AS task_claimed_by_type, pm.task_assignee_id AS task_claimed_by_id, (p.mention_unread > 0) AS has_mention, (p.mention_unread > 0 AND p.unread_count IS NULL) AS mention_only, CAST(p.last_read_seq AS BIGINT) AS last_read_seq, COALESCE(p.latest_at, ma.created_at) AS activity_at, (p.total_mentions > 0) AS has_any_mention FROM rw_inbox_items_v12 AS p LEFT JOIN rw_activity_watermark_v6 AS w ON w.receiver_type = p.receiver_type AND w.receiver_id = p.receiver_id AND w.server_id = p.server_id LEFT JOIN rw_channels AS c ON c.id = p.target_id LEFT JOIN rw_message_preview_v1 AS lm ON lm.seq = p.latest_seq LEFT JOIN rw_message_preview_v1 AS fu ON fu.seq = p.first_unread_seq LEFT JOIN rw_thread_parent_v3 AS tp ON tp.thread_channel_id = p.target_id AND p.kind = 'thread' LEFT JOIN rw_message_preview_v1 AS pm ON pm.id = tp.parent_message_id LEFT JOIN rw_target_latest_v4 AS tl ON tl.target_id = p.target_id LEFT JOIN rw_message_preview_v1 AS ma ON ma.seq = p.max_mention_seq WHERE p.present AND GREATEST(COALESCE(tl.latest_seq, 0), COALESCE(p.latest_seq, 0), COALESCE(p.max_mention_seq, 0)) >= COALESCE(w.watermark_seq, 0);

CREATE INDEX idx_rw_inbox_serving_v8_receiver ON rw_inbox_serving_v8(receiver_type, receiver_id, activity_at DESC);

CREATE MATERIALIZED VIEW rw_activity_totals_v6 AS WITH served AS (SELECT i.receiver_type, i.receiver_id, i.server_id, CAST(COALESCE(SUM(CASE WHEN i.mention_only THEN 0 ELSE i.unread_count END), 0) AS INT) AS total_unread_count FROM rw_inbox_serving_v8 AS i WHERE (i.kind = 'thread' OR i.channel_type IN ('channel', 'private', 'joint', 'dm')) GROUP BY i.receiver_type, i.receiver_id, i.server_id), members AS (SELECT 'user' AS receiver_type, CAST(user_id AS CHARACTER VARYING) AS receiver_id, server_id FROM rw_server_members) SELECT COALESCE(m.receiver_type, s.receiver_type) AS receiver_type, COALESCE(m.receiver_id, s.receiver_id) AS receiver_id, COALESCE(m.server_id, s.server_id) AS server_id, COALESCE(s.total_unread_count, 0) AS total_unread_count FROM members AS m FULL JOIN served AS s ON s.receiver_type = m.receiver_type AND s.receiver_id = m.receiver_id AND s.server_id = m.server_id;
