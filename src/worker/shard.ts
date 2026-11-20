// EventShard: one SQLite Durable Object per (project, period) holding that period's events (design.md "Event shards").
// The head ProjectStore routes inserts here and fans queries out; every method is a primitive from eventsql.ts.
import { DurableObject } from 'cloudflare:workers';
import type { Env, NormEvent } from './env';
import * as X from './eventsql';
import { runShardSql, SqlShardSpec } from './sqlquery';

export class EventShard extends DurableObject<Env> {
  sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => { for (const s of X.EVENTS_SCHEMA) this.sql.exec(s); });
  }
  /** INSERT OR IGNORE by uuid; returns the number of new rows. */
  async insert(events: NormEvent[]): Promise<number> {
    let n = 0;
    this.ctx.storage.transactionSync(() => {
      for (const ev of events) n += this.sql.exec('INSERT OR IGNORE INTO events (uuid, event, distinct_id, timestamp, properties, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
        ev.uuid, ev.event, ev.distinct_id, ev.ts, JSON.stringify(ev.properties), ev.received_at).toArray().length;
    });
    return n;
  }
  async trend(s: X.TrendSpec) { return X.trendRows(this.sql, s); }
  async funnel(s: X.FunnelSpec) { return X.funnelRows(this.sql, s); }
  async funnelCounts(s: X.FunnelSpec) { return X.funnelCountRows(this.sql, s); }
  async sqlRows(s: SqlShardSpec) { return runShardSql(this.sql, s); }
  async heatmap(s: X.HeatmapSpec) { return X.heatmapRows(this.sql, s); }
  async scroll(s: { from: number; to: number; pathname?: string | null }) { return X.scrollRows(this.sql, s); }
  async periods(s: X.PeriodSpec) { return X.periodRows(this.sql, s); }
  async firsts(s: { node: X.NodeSpec; global?: X.PropertyFilter[]; before: number }) { return X.firstRows(this.sql, s); }
  async events(s: X.EventsSpec) { return X.eventRows(this.sql, s); }
  async llm(s: X.LlmSpec) { return X.llmRows(this.sql, s); }
  async propertyValues(key: string) { return X.propertyValueRows(this.sql, key); }
  async stats(since: number) { return { ...X.eventStats(this.sql, since), bytes: this.sql.databaseSize }; }
  async purge(before: number) { return X.purgeBefore(this.sql, before); }
  async deleteDistinctIds(dids: string[]) { return X.deleteDistinctIds(this.sql, dids); }
  async destroy() { await this.ctx.storage.deleteAll(); }
}
