import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, compose, sql, waitFor } from './common.mjs';
import { RISINGWAVE_BOOTSTRAP_ARTIFACTS, RISINGWAVE_REQUIRED_RELATIONS, RISINGWAVE_CDC_TABLES,
  RISINGWAVE_ARTIFACT_CDC_TABLES, RISINGWAVE_PUBLICATION_TABLES, RISINGWAVE_LOCAL_SOURCE,
  RISINGWAVE_LOCAL_SLOT, RISINGWAVE_LOCAL_PUBLICATION, buildRisingWaveBootstrapStatements,
} from '../dev/raftdev-risingwave-bootstrap.ts';
export const rwsql = (ctx, text) => compose(ctx, ['exec', '-T', '-e', 'PGCONNECT_TIMEOUT=5', 'db', 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
  '-h', 'risingwave', '-p', '4566', '-U', 'root', '-d', 'dev', '-At'], { input: text });
const literal = s => "'" + s.replaceAll("'", "''") + "'";
export async function ensureRisingWave(ctx) {
  await waitFor(() => rwsql(ctx, 'SELECT 1;'), 'RisingWave');
  const existing = (await rwsql(ctx, 'SELECT name FROM rw_catalog.rw_relations;')).trim().split('\n');
  const present = RISINGWAVE_REQUIRED_RELATIONS.filter(n => existing.includes(n));
  if (present.length && present.length !== RISINGWAVE_REQUIRED_RELATIONS.length) throw new Error('Incomplete RisingWave catalog; rebuild in a fresh recovery target');
  if (!present.length) {
    const env = await readFile(path.join(ctx.state, 'server.env'), 'utf8');
    const password = /^POSTGRES_PASSWORD=(.+)$/m.exec(env)?.[1];
    if (!password) throw new Error('Missing Postgres password');
    // Empty/recovered RW: discard only the owned, inactive CDC slot/publication.
    await sql(ctx, `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name='${RISINGWAVE_LOCAL_SLOT}';
      DROP PUBLICATION IF EXISTS ${RISINGWAVE_LOCAL_PUBLICATION};
      CREATE PUBLICATION ${RISINGWAVE_LOCAL_PUBLICATION} FOR TABLE ${RISINGWAVE_PUBLICATION_TABLES.join(',')};`);
    await rwsql(ctx, `CREATE SOURCE ${RISINGWAVE_LOCAL_SOURCE} WITH (
      connector='postgres-cdc', hostname='db', port='5432', username='postgres', password=${literal(password)},
      database.name='slock', schema.name='public', slot.name='${RISINGWAVE_LOCAL_SLOT}',
      publication.name='${RISINGWAVE_LOCAL_PUBLICATION}', publication.create.enable='false');`);
    const artifacts = Object.fromEntries(await Promise.all(RISINGWAVE_BOOTSTRAP_ARTIFACTS.map(async a =>
      [a.file, await readFile(path.join(ROOT, a.file), 'utf8')])));
    for (const statement of buildRisingWaveBootstrapStatements(artifacts)) await rwsql(ctx, statement + ';');
  }
  await waitFor(async () => {
    for (const t of [...RISINGWAVE_CDC_TABLES, ...RISINGWAVE_ARTIFACT_CDC_TABLES]) {
      if ((await sql(ctx, `SELECT count(*) FROM ${t.upstream};`)).trim() !==
          (await rwsql(ctx, `SELECT count(*) FROM ${t.name};`)).trim()) throw new Error('CDC snapshot pending');
    }
    if ((await rwsql(ctx, 'SELECT count(*) FROM rw_catalog.rw_ddl_progress;')).trim() !== '0') throw new Error('DDL pending');
    if ((await rwsql(ctx, "SELECT count(*) FROM rw_inbox_serving_v8 WHERE (kind='thread' AND reply_count IS NULL) OR (mention_only AND (activity_at IS NULL OR latest_activity_message_id IS NULL));")).trim() !== '0') throw new Error('Invalid serving rows');
  }, 'RisingWave initial snapshot', 180);
}
