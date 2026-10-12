# RisingWave SQL

These definitions and validation queries support the Inbox materialized views.
They are executable infrastructure inputs, not PostgreSQL/Drizzle migrations.
The numeric prefixes retain links to the design history in `rfcs/`.

The local bootstrap in `packages/server/scripts/bootstrap-risingwave-local.ts`
(raftdev `--risingwave` and the `risingwave-real` CI job) selects, statement by
statement, exactly the relations the server reads and their dependencies from
024 (CDC-table indexes only), 061, 063-unified-inbox-chain, 063-chain-v5,
075, 067, 076, 077, 071 (indexes only), and 074, in that order (066's muted arm and
068's consumers are superseded by 075/076; 076's serving and totals and
063-chain-v5's watermark by 077, which builds on 076's items; 069's
`rw_followed_thread_stats_v2`, 070's `rw_followed_thread_stats_v3` and 072's
`rw_followed_threads_v4` are superseded by 074's `rw_followed_threads_v5`, which
also covers joint threads, and are not applied; 074 also reads the `rw_tasks`
CDC table). The selection lives in `RISINGWAVE_BOOTSTRAP_ARTIFACTS`
(`scripts/dev/raftdev-risingwave-bootstrap.ts`), which is also the list of
applied relations. When a new generation replaces a
view the server reads, add it there, or the `risingwave-real` job fails. That
script is the consumer to check when
changing file locations.

Do not run every file alphabetically: some are superseded generations kept
because tests still read them. For local setup use `./raftdev --risingwave`,
which applies exactly the `RISINGWAVE_BOOTSTRAP_ARTIFACTS` list above, in
order.

The views read Postgres through CDC source tables (`rw_messages`, `rw_channels`
and the others named in each file's prerequisites). The local bootstrap creates
them for a loopback Postgres and RisingWave. For any other cluster, create the
CDC source and its tables first, then apply the same files in the same order.

`075-inbox-cursor-decouple.sql` and `076-cursor-decouple-consumers.sql` are the
inbox arms with the read cursor as a join condition (a cursor move no longer
rewrites every message of the conversation), plus the 068 consumers re-pointed
at them. `076-parity-checks.sql` compares each new view with the one it
replaces; every pair must report 0. The server reads the
076 views; until an environment has built them, a read that finds one missing
reads its 068 counterpart (`withUnifiedChainTransition` in
`packages/server/src/db/risingwave.ts`). Drop the 068 generation (and
`rw_inbox_normal_v4`, `rw_inbox_muted_prefix_v1`, `rw_inbox_muted_full_v1`) only
after 076 is built everywhere and traces show no
`inbox.rw.unified_chain_view_fallback` events.

The fallback covers a view that is missing or still backfilling (RW 3.0.3
answers `42704 table or source not found` for both), but not a view whose index
is still being built: in that gap reads would go to the new view unindexed and
scan it. So the four server-read views are built under a `_build` name and
renamed only once everything, indexes included, has finished (see Building
the views below).
Until the last rename, at least one read view is missing, so every read stays on
068; after it, all four switch together. A server that reads 076 can therefore
be deployed before, during or after the build. An environment built under the
final names directly (such as the dev bootstrap) must not run that server until
its indexes exist.

`077-deleted-parent-threads.sql` drops threads whose parent is
deleted (an agent's DM after the agent is deleted) from the human Activity, as
the canonical Postgres read and `rw_agent_inbox_v6` already do. `rw_inbox_items_v12`
filters 076's `rw_inbox_items_v11` (which therefore stays, as its base); 077
replaces 076's `rw_inbox_serving_v7`, `rw_activity_totals_v5` and 063-chain-v5's
`rw_activity_watermark_v5` with `rw_inbox_serving_v8`, `rw_activity_totals_v6`
and `rw_activity_watermark_v6`; the columns are unchanged. The server reads serving v8 / totals v6 and, while they are missing, falls
back to v7 / v5, or to 068's v6 / v4 where 076 is not built either (same
mechanism as above, one step further). Unlike 076,
077 is not meant to be identical to what it replaces: `077-parity-checks.sql`
expects the only differences to be threads below a deleted parent.

### Building the views

Every view in 075-077 backfills from the whole message table. On a cluster with
real data, build them throttled and one object per step: in the session, before
each `CREATE`, set `BACKGROUND_DDL = true`, cap `STREAMING_PARALLELISM`, and set
`backfill_rate_limit`. Keep the parallelism cap even with a rate limit: a rate
limit alone still occupies every core (see the build note in 063). Before each
step, `rw_ddl_progress` must be empty and the previous object visible in the
catalog.

Order: 075 (`rw_inbox_normal_v5`, `rw_inbox_muted_full_v2`,
`rw_inbox_muted_prefix_v2`); 076 (`rw_inbox_items_v11`, `rw_inbox_serving_v7`,
its index, `rw_activity_totals_v5`, `rw_agent_inbox_v6`, its index,
`rw_conversation_unread_v3`, its index); 077 (`rw_activity_watermark_v6`,
`rw_inbox_items_v12`, `rw_inbox_serving_v8`, its index, `rw_activity_totals_v6`).

The views the server reads (serving, totals, agent inbox, conversation unread)
and their indexes are created under a `_build` name (a totals `_build` view
reads the serving `_build` view) and renamed to their final names in one session
once the last index has finished and `rw_ddl_progress` is empty, for example:

```sql
ALTER MATERIALIZED VIEW rw_inbox_serving_v8_build RENAME TO rw_inbox_serving_v8;
ALTER MATERIALIZED VIEW rw_activity_totals_v6_build RENAME TO rw_activity_totals_v6;
ALTER INDEX idx_rw_inbox_serving_v8_receiver_build RENAME TO idx_rw_inbox_serving_v8_receiver;
```

The other views are not read by the server and keep their final names. A rename
is catalog-only and does not wait on a barrier. Indexes and downstream views
refer to their upstream by id, so they keep working and the planner keeps using
the renamed index. RW rewrites a dependent view's stored definition to
`FROM <new name> AS <old name>` and does not rewrite the stored text of an index
(it still says `ON ..._build`); both are cosmetic.

Then run the parity checks. Drop a replaced view only after its successor is
built everywhere and traces show no `inbox.rw.unified_chain_view_fallback`
events. Keep `rw_inbox_items_v11`: it is `rw_inbox_items_v12`'s base.
