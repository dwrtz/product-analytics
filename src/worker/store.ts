// ProjectStore: the head SQLite Durable Object of a project (design.md "Event store").
// Holds persons, groups, definitions, insights, dashboards, flags, experiments, surveys, recordings metadata and the
// shard registry. Events live in EventShard objects, one per period; the head's own legacy `events` table (0.1 data) is
// queried as one more shard, so upgrades move no data.
import { DurableObject } from 'cloudflare:workers';
import type { Env, NormEvent } from './env';
import { isIllegalDistinctId, uuidv7 } from '../shared/ids';
import { evaluateFlag, FlagDef, FlagResult } from '../shared/flags';
import { runQuery, QueryContext, Engine, ShardApi, PersonRef } from './query';
import * as X from './eventsql';
import type { EventShard } from './shard';
import { experimentResults, validateMetric, Experiment } from './experiments';
import { cleanSurvey, publicSurvey, surveyResults } from './surveys';

const SCHEMA = [
  ...X.EVENTS_SCHEMA,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS shards (key TEXT PRIMARY KEY, start INTEGER NOT NULL, end INTEGER NOT NULL, events INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS session_recordings (session_id TEXT PRIMARY KEY, distinct_id TEXT NOT NULL, start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL,
     click_count INTEGER NOT NULL DEFAULT 0, keypress_count INTEGER NOT NULL DEFAULT 0, console_error_count INTEGER NOT NULL DEFAULT 0,
     first_url TEXT, size INTEGER NOT NULL DEFAULT 0, chunks INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS recordings_start ON session_recordings (start_ts)`,
  `CREATE INDEX IF NOT EXISTS recordings_did ON session_recordings (distinct_id, start_ts)`,
  `CREATE TABLE IF NOT EXISTS experiments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', feature_flag_key TEXT NOT NULL,
     metrics TEXT NOT NULL DEFAULT '[]', filters TEXT NOT NULL DEFAULT '[]', start_date INTEGER, end_date INTEGER, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS surveys (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', type TEXT NOT NULL, questions TEXT NOT NULL, appearance TEXT NOT NULL,
     conditions TEXT, linked_flag_key TEXT, enable_partial_responses INTEGER NOT NULL DEFAULT 0, start_date INTEGER, end_date INTEGER, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ingest_log (uuid TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS ingest_log_at ON ingest_log (at)`,
  `CREATE TABLE IF NOT EXISTS persons (
     id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE, properties TEXT NOT NULL DEFAULT '{}',
     is_identified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_seen_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS person_distinct_ids (distinct_id TEXT PRIMARY KEY, person_id INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS pdi_person ON person_distinct_ids (person_id)`,
  `CREATE TABLE IF NOT EXISTS group_types (idx INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)`,
  `CREATE TABLE IF NOT EXISTS groups (group_type TEXT NOT NULL, group_key TEXT NOT NULL, properties TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, PRIMARY KEY (group_type, group_key))`,
  `CREATE TABLE IF NOT EXISTS event_definitions (name TEXT PRIMARY KEY, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS property_definitions (kind TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (kind, name))`,
  `CREATE TABLE IF NOT EXISTS insights (id INTEGER PRIMARY KEY AUTOINCREMENT, short_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', query TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS dashboards (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', date_from TEXT, pinned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS dashboard_tiles (dashboard_id INTEGER NOT NULL, insight_id INTEGER NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (dashboard_id, insight_id))`,
  `CREATE TABLE IF NOT EXISTS feature_flags (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, filters TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
];

type Row = Record<string, SqlStorageValue>;
const parse = (s: unknown) => { try { return typeof s === 'string' ? JSON.parse(s) : {}; } catch { return {}; } };
const typeOf = (v: unknown) => typeof v === 'number' ? 'Numeric' : typeof v === 'boolean' ? 'Boolean' : typeof v === 'string' ? (/^\d{4}-\d{2}-\d{2}T/.test(v) ? 'DateTime' : 'String') : 'String';
const MAX_GROUP_TYPES = 5;

export class ProjectStore extends DurableObject<Env> {
  sql: SqlStorage;
  private seenEvents = new Set<string>();
  private seenProps = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => { for (const s of SCHEMA) this.sql.exec(s); });
  }
  private all<T = Row>(q: string, ...b: unknown[]): T[] { return this.sql.exec(q, ...(b as SqlStorageValue[])).toArray() as T[]; }
  private one<T = Row>(q: string, ...b: unknown[]): T | null { return (this.all<T>(q, ...b)[0] ?? null); }

  // ---------- shards ----------
  private period(): 'month' | 'day' {
    let r = this.one<{ value: string }>("SELECT value FROM meta WHERE key = 'shard_period'")?.value;
    if (!r) { r = this.env.SHARD_PERIOD === 'day' ? 'day' : 'month'; this.sql.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('shard_period', ?)", r); }
    return r as 'month' | 'day';
  }
  /** The period key and bounds holding a timestamp (UTC months, or UTC days when SHARD_PERIOD=day). */
  private periodOf(ts: number): { key: string; start: number; end: number } {
    const d = new Date(ts); const y = d.getUTCFullYear(), m = d.getUTCMonth();
    if (this.period() === 'day') { const start = Date.UTC(y, m, d.getUTCDate()); return { key: new Date(start).toISOString().slice(0, 10), start, end: start + 86400_000 }; }
    return { key: new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7), start: Date.UTC(y, m, 1), end: Date.UTC(y, m + 1, 1) };
  }
  private shardStub(key: string) {
    const ns = this.env.SHARDS; return ns.get(ns.idFromName(`${this.ctx.id.toString()}:${key}`)) as unknown as EventShard;
  }
  private legacyRows: boolean | null = null;
  private hasLegacy(): boolean {
    if (this.legacyRows === null) this.legacyRows = !!this.one('SELECT 1 AS x FROM events LIMIT 1');
    return this.legacyRows;
  }
  private local(): ShardApi {
    const q = this.sql;
    return { trend: async s => X.trendRows(q, s), funnel: async s => X.funnelRows(q, s), periods: async s => X.periodRows(q, s), firsts: async s => X.firstRows(q, s), events: async s => X.eventRows(q, s) };
  }
  private shardsFor(from: number, to: number): { key: string; api: ShardApi }[] {
    const out: { key: string; api: ShardApi }[] = [];
    if (this.hasLegacy()) out.push({ key: 'legacy', api: this.local() });
    for (const r of this.all<{ key: string }>('SELECT key FROM shards WHERE start <= ? AND end > ? ORDER BY start', to, from)) out.push({ key: r.key, api: this.shardStub(r.key) as unknown as ShardApi });
    return out;
  }
  private engine(): Engine {
    return {
      shards: async (from, to) => this.shardsFor(from, to).map(s => s.api),
      resolve: dids => {
        const m = new Map<string, PersonRef>();
        for (let i = 0; i < dids.length; i += 5000) {
          for (const r of this.all<{ d: string; id: number; uuid: string; properties: string }>('SELECT d.distinct_id AS d, p.id, p.uuid, p.properties FROM json_each(?) j JOIN person_distinct_ids d ON d.distinct_id = j.value JOIN persons p ON p.id = d.person_id', JSON.stringify(dids.slice(i, i + 5000))))
            m.set(r.d, { pk: 'p' + r.id, uuid: r.uuid, props: parse(r.properties) });
        }
        return m;
      },
      groupTypeName: idx => this.one<{ name: string }>('SELECT name FROM group_types WHERE idx = ?', idx)?.name ?? null,
      firstEventAt: () => this.firstEventAt(),
      distinctIdsOfPerson: uuid => this.all<{ d: string }>('SELECT distinct_id AS d FROM person_distinct_ids WHERE person_id = (SELECT id FROM persons WHERE uuid = ? OR CAST(id AS TEXT) = ?)', uuid, uuid).map(r => r.d),
    };
  }

  // ---------- ingestion ----------
  private inflight = new Set<string>();
  /**
   * Exactly-once person processing: an event is new when its uuid is not in ingest_log (kept 7 days). New events go to
   * their period's shard (INSERT OR IGNORE, so a retry after a crash cannot duplicate them), then persons, groups and
   * definitions are updated in one head transaction that also records the uuids.
   */
  async ingest(events: NormEvent[]): Promise<{ inserted: number; duplicates: number }> {
    const fresh: NormEvent[] = []; const batch = new Set<string>();
    const legacy = this.hasLegacy();
    for (const ev of events) {
      if (batch.has(ev.uuid) || this.inflight.has(ev.uuid)) continue;
      if (this.one('SELECT 1 AS x FROM ingest_log WHERE uuid = ?', ev.uuid)) continue;
      if (legacy && this.one('SELECT 1 AS x FROM events WHERE uuid = ?', ev.uuid)) continue;
      batch.add(ev.uuid); fresh.push(ev);
    }
    for (const u of batch) this.inflight.add(u);
    try {
      const groups = new Map<string, { start: number; end: number; evs: NormEvent[] }>();
      for (const ev of fresh) { const p = this.periodOf(ev.ts); let g = groups.get(p.key); if (!g) groups.set(p.key, g = { start: p.start, end: p.end, evs: [] }); g.evs.push(ev); }
      const counts = await Promise.all([...groups].map(async ([key, g]) => [key, g, await this.shardStub(key).insert(g.evs)] as const));
      const now = Date.now();
      this.ctx.storage.transactionSync(() => {
        for (const [key, g, n] of counts) this.sql.exec('INSERT INTO shards (key, start, end, events) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET events = events + excluded.events', key, g.start, g.end, n);
        const lastSeen = new Map<string, number>();
        for (const ev of fresh) {
          this.sql.exec('INSERT OR IGNORE INTO ingest_log (uuid, at) VALUES (?, ?)', ev.uuid, now);
          this.define(ev);
          if (ev.event === '$groupidentify') this.groupIdentify(ev);
          if (ev.person) this.processPerson(ev);
          lastSeen.set(ev.distinct_id, Math.max(lastSeen.get(ev.distinct_id) ?? 0, ev.ts));
        }
        for (const [did, ts] of lastSeen) this.sql.exec('UPDATE persons SET last_seen_at = MAX(COALESCE(last_seen_at, 0), ?) WHERE id = (SELECT person_id FROM person_distinct_ids WHERE distinct_id = ?)', ts, did);
      });
    } finally { for (const u of batch) this.inflight.delete(u); }
    return { inserted: fresh.length, duplicates: events.length - fresh.length };
  }

  private define(ev: NormEvent) {
    if (!this.seenEvents.has(ev.event)) {
      this.sql.exec('INSERT INTO event_definitions (name, first_seen_at, last_seen_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET last_seen_at = MAX(last_seen_at, excluded.last_seen_at)', ev.event, ev.ts, ev.ts);
      this.seenEvents.add(ev.event);
    }
    const note = (kind: string, props: Record<string, unknown> | undefined) => {
      for (const [k, v] of Object.entries(props ?? {})) {
        if (v === null || v === undefined || typeof v === 'object' || k === '$set' || k === '$set_once') continue;
        const id = kind + '\u0000' + k; if (this.seenProps.has(id)) continue;
        this.sql.exec('INSERT OR IGNORE INTO property_definitions (kind, name, type) VALUES (?, ?, ?)', kind, k, typeOf(v));
        this.seenProps.add(id); if (this.seenProps.size > 20000) this.seenProps.clear();
      }
    };
    note('event', ev.properties);
    if (ev.person) { note('person', ev.set); note('person', ev.set_once); }
  }

  private groupIdentify(ev: NormEvent) {
    const type = ev.properties.$group_type, key = ev.properties.$group_key;
    if (typeof type !== 'string' || (typeof key !== 'string' && typeof key !== 'number')) return;
    if (!this.groupTypeIndex(type)) return;
    const set = (ev.properties.$group_set && typeof ev.properties.$group_set === 'object') ? ev.properties.$group_set as Record<string, unknown> : {};
    const cur = this.one<{ properties: string }>('SELECT properties FROM groups WHERE group_type = ? AND group_key = ?', type, String(key));
    const props = { ...(cur ? parse(cur.properties) : {}), ...set };
    this.sql.exec('INSERT INTO groups (group_type, group_key, properties, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(group_type, group_key) DO UPDATE SET properties = excluded.properties', type, String(key), JSON.stringify(props), ev.ts);
    for (const k of Object.keys(set)) this.sql.exec('INSERT OR IGNORE INTO property_definitions (kind, name, type) VALUES (?, ?, ?)', 'group:' + type, k, typeOf(set[k]));
  }
  private groupTypeIndex(name: string): number | null {
    const r = this.one<{ idx: number }>('SELECT idx FROM group_types WHERE name = ?', name);
    if (r) return r.idx + 1;
    const n = this.one<{ c: number }>('SELECT COUNT(*) AS c FROM group_types')!.c;
    if (n >= MAX_GROUP_TYPES) return null;
    this.sql.exec('INSERT INTO group_types (idx, name) VALUES (?, ?)', n, name);
    return n + 1;
  }

  private personOf(did: string): { id: number; properties: string; is_identified: number; created_at: number } | null {
    return this.one('SELECT p.id, p.properties, p.is_identified, p.created_at FROM person_distinct_ids d JOIN persons p ON p.id = d.person_id WHERE d.distinct_id = ?', did);
  }
  private createPerson(dids: string[], ts: number, identified: boolean): number {
    const r = this.one<{ id: number }>('INSERT INTO persons (uuid, properties, is_identified, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?) RETURNING id', uuidv7(ts), '{}', identified ? 1 : 0, ts, ts)!;
    for (const d of dids) this.sql.exec('INSERT OR REPLACE INTO person_distinct_ids (distinct_id, person_id) VALUES (?, ?)', d, r.id);
    return r.id;
  }

  /** Identify, alias and merge; then $set / $set_once / $unset on the event's person. */
  private processPerson(ev: NormEvent) {
    const target = ev.distinct_id;
    let other: unknown = null; let allowIdentified = false;
    if (ev.event === '$identify') other = ev.properties.$anon_distinct_id;
    else if (ev.event === '$create_alias') other = ev.properties.alias;
    else if (ev.event === '$merge_dangerously') { other = ev.properties.alias; allowIdentified = true; }
    if (typeof other === 'number') other = String(other);
    if (typeof other === 'string' && other && other !== target && !isIllegalDistinctId(target) && !isIllegalDistinctId(other)) {
      this.merge(target, other, allowIdentified, ev.ts);
    } else if (ev.event === '$identify' && !isIllegalDistinctId(target)) {
      const p = this.personOf(target);
      if (p) this.sql.exec('UPDATE persons SET is_identified = 1 WHERE id = ?', p.id);
      else this.createPerson([target], ev.ts, true);
    }
    let p = this.personOf(target);
    if (!p) { this.createPerson([target], ev.ts, false); p = this.personOf(target)!; }
    if (ev.set || ev.set_once || ev.unset) {
      const props = parse(p.properties);
      let changed = false;
      for (const [k, v] of Object.entries(ev.set_once ?? {})) if (!(k in props)) { props[k] = v; changed = true; }
      for (const [k, v] of Object.entries(ev.set ?? {})) if (props[k] !== v) { props[k] = v; changed = true; }
      for (const k of ev.unset ?? []) if (k in props) { delete props[k]; changed = true; }
      if (changed) this.sql.exec('UPDATE persons SET properties = ? WHERE id = ?', JSON.stringify(props), p.id);
    }
  }

  private merge(target: string, other: string, allowIdentified: boolean, ts: number) {
    const tp = this.personOf(target), op = this.personOf(other);
    if (!tp && !op) { this.createPerson([target, other], ts, true); return; }
    if (tp && !op) { this.sql.exec('INSERT OR REPLACE INTO person_distinct_ids (distinct_id, person_id) VALUES (?, ?)', other, tp.id); this.sql.exec('UPDATE persons SET is_identified = 1 WHERE id = ?', tp.id); return; }
    if (!tp && op) { this.sql.exec('INSERT OR REPLACE INTO person_distinct_ids (distinct_id, person_id) VALUES (?, ?)', target, op.id); this.sql.exec('UPDATE persons SET is_identified = 1 WHERE id = ?', op.id); return; }
    if (tp!.id === op!.id) { this.sql.exec('UPDATE persons SET is_identified = 1 WHERE id = ?', tp!.id); return; }
    if (op!.is_identified && !allowIdentified) { this.sql.exec('UPDATE persons SET is_identified = 1 WHERE id = ?', tp!.id); return; }
    const props = { ...parse(op!.properties), ...parse(tp!.properties) };
    this.sql.exec('UPDATE person_distinct_ids SET person_id = ? WHERE person_id = ?', tp!.id, op!.id);
    this.sql.exec('UPDATE persons SET properties = ?, is_identified = 1, created_at = MIN(created_at, ?), last_seen_at = MAX(COALESCE(last_seen_at,0), ?) WHERE id = ?',
      JSON.stringify(props), op!.created_at, ts, tp!.id);
    this.sql.exec('DELETE FROM persons WHERE id = ?', op!.id);
  }

  // ---------- feature flags (/flags) ----------
  async evaluateFlags(distinctId: string, overrides: Record<string, unknown>, onlyKeys?: string[] | null): Promise<FlagResult[]> {
    const p = this.personOf(distinctId);
    const props = { ...(p ? parse(p.properties) : {}), ...overrides, distinct_id: distinctId };
    const flags = this.all<{ id: number; key: string; name: string; active: number; filters: string; version: number }>('SELECT * FROM feature_flags WHERE active = 1 ORDER BY id');
    const out: FlagResult[] = [];
    for (const f of flags) {
      if (onlyKeys && onlyKeys.length && !onlyKeys.includes(f.key)) continue;
      const def: FlagDef = { id: f.id, key: f.key, name: f.name, active: true, version: f.version, filters: parse(f.filters) };
      out.push(await evaluateFlag(def, distinctId, props));
    }
    return out;
  }
  async hasActiveFlags(): Promise<boolean> { return !!this.one('SELECT 1 FROM feature_flags WHERE active = 1 LIMIT 1'); }

  // ---------- queries ----------
  async query(q: unknown, qc: QueryContext): Promise<unknown> { return runQuery(this.engine(), q, qc); }

  async definitions() {
    return {
      events: this.all('SELECT name, first_seen_at, last_seen_at FROM event_definitions ORDER BY last_seen_at DESC LIMIT 1000'),
      properties: this.all('SELECT kind, name, type FROM property_definitions ORDER BY kind, name LIMIT 5000'),
      group_types: this.all('SELECT idx, name FROM group_types ORDER BY idx'),
    };
  }
  async propertyValues(kind: string, key: string): Promise<string[]> {
    const path = X.pathOf(key);
    if (kind === 'person') return this.all<{ v: string }>('SELECT DISTINCT CAST(json_extract(properties, ?) AS TEXT) AS v FROM persons WHERE json_extract(properties, ?) IS NOT NULL LIMIT 50', path, path).map(r => r.v);
    const newest = this.one<{ key: string }>('SELECT key FROM shards ORDER BY start DESC LIMIT 1');
    if (newest) return this.shardStub(newest.key).propertyValues(key);
    return X.propertyValueRows(this.sql, key);
  }

  // ---------- persons ----------
  async listPersons(search: string, cursor: number | null, limit = 100) {
    const like = `%${search.toLowerCase()}%`;
    const rows = this.all<any>(`SELECT p.id, p.uuid, p.properties, p.is_identified, p.created_at, p.last_seen_at,
        (SELECT group_concat(distinct_id, char(31)) FROM person_distinct_ids WHERE person_id = p.id) AS dids
      FROM persons p WHERE (? IS NULL OR p.id < ?) AND (? = '' OR lower(p.properties) LIKE ? OR EXISTS (SELECT 1 FROM person_distinct_ids d WHERE d.person_id = p.id AND lower(d.distinct_id) LIKE ?))
      ORDER BY p.id DESC LIMIT ?`, cursor, cursor, search, like, like, limit);
    const total = this.one<{ c: number }>(`SELECT COUNT(*) AS c FROM persons p WHERE (? = '' OR lower(p.properties) LIKE ? OR EXISTS (SELECT 1 FROM person_distinct_ids d WHERE d.person_id = p.id AND lower(d.distinct_id) LIKE ?))`, search, like, like)!.c;
    return { total, results: rows.map(personOut), next: rows.length === limit ? rows[rows.length - 1].id : null };
  }
  async getPerson(id: string) {
    const r = this.one<any>(`SELECT p.*, (SELECT group_concat(distinct_id, char(31)) FROM person_distinct_ids WHERE person_id = p.id) AS dids FROM persons p WHERE p.uuid = ? OR CAST(p.id AS TEXT) = ?`, id, id);
    return r ? personOut(r) : null;
  }
  /** Deletes a person (and with deleteEvents their events and recordings); returns the deleted recordings' session ids. */
  async deletePerson(id: string, deleteEvents: boolean): Promise<false | { recordings: string[] }> {
    const p = this.one<{ id: number }>('SELECT id FROM persons WHERE uuid = ? OR CAST(id AS TEXT) = ?', id, id);
    if (!p) return false;
    let recordings: string[] = [];
    if (deleteEvents) recordings = this.sql.exec('DELETE FROM session_recordings WHERE distinct_id IN (SELECT distinct_id FROM person_distinct_ids WHERE person_id = ?) RETURNING session_id', p.id).toArray().map(r => String(r.session_id));
    if (deleteEvents) {
      const dids = this.all<{ d: string }>('SELECT distinct_id AS d FROM person_distinct_ids WHERE person_id = ?', p.id).map(r => r.d);
      for (let i = 0; i < dids.length; i += 1000) {
        const part = dids.slice(i, i + 1000);
        X.deleteDistinctIds(this.sql, part);
        for (const sh of this.all<{ key: string }>('SELECT key FROM shards')) {
          const n = await this.shardStub(sh.key).deleteDistinctIds(part);
          if (n) this.sql.exec('UPDATE shards SET events = MAX(0, events - ?) WHERE key = ?', n, sh.key);
        }
      }
    }
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM person_distinct_ids WHERE person_id = ?', p.id);
      this.sql.exec('DELETE FROM persons WHERE id = ?', p.id);
    });
    return { recordings };
  }

  // ---------- saved objects ----------
  async listInsights() { return this.all<any>('SELECT * FROM insights ORDER BY updated_at DESC').map(insightOut); }
  async getInsight(id: string) { const r = this.one<any>('SELECT * FROM insights WHERE short_id = ? OR CAST(id AS TEXT) = ?', id, id); return r ? insightOut(r) : null; }
  async saveInsight(id: string | null, b: { name?: string; description?: string; query?: unknown }, by: string) {
    const now = Date.now();
    if (id) {
      const cur = await this.getInsight(id); if (!cur) return null;
      this.sql.exec('UPDATE insights SET name = ?, description = ?, query = ?, updated_at = ? WHERE id = ?', b.name ?? cur.name, b.description ?? cur.description, JSON.stringify(b.query ?? cur.query), now, cur.id);
      return this.getInsight(String(cur.id));
    }
    const short = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    const r = this.one<{ id: number }>('INSERT INTO insights (short_id, name, description, query, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
      short, b.name || 'Untitled insight', b.description ?? '', JSON.stringify(b.query ?? {}), by, now, now)!;
    return this.getInsight(String(r.id));
  }
  async deleteInsight(id: string) {
    const cur = await this.getInsight(id); if (!cur) return false;
    this.sql.exec('DELETE FROM dashboard_tiles WHERE insight_id = ?', cur.id); this.sql.exec('DELETE FROM insights WHERE id = ?', cur.id); return true;
  }
  async listDashboards() {
    return this.all<any>('SELECT d.*, (SELECT COUNT(*) FROM dashboard_tiles t WHERE t.dashboard_id = d.id) AS tiles FROM dashboards d ORDER BY d.pinned DESC, d.name');
  }
  async getDashboard(id: number) {
    const d = this.one<any>('SELECT * FROM dashboards WHERE id = ?', id); if (!d) return null;
    const tiles = this.all<any>('SELECT i.* FROM dashboard_tiles t JOIN insights i ON i.id = t.insight_id WHERE t.dashboard_id = ? ORDER BY t.position', id).map(insightOut);
    return { ...d, insights: tiles };
  }
  async saveDashboard(id: number | null, b: { name?: string; description?: string; date_from?: string | null; pinned?: boolean }) {
    const now = Date.now();
    if (id) {
      const cur = this.one<any>('SELECT * FROM dashboards WHERE id = ?', id); if (!cur) return null;
      this.sql.exec('UPDATE dashboards SET name = ?, description = ?, date_from = ?, pinned = ?, updated_at = ? WHERE id = ?', b.name ?? cur.name, b.description ?? cur.description, b.date_from === undefined ? cur.date_from : b.date_from, b.pinned === undefined ? cur.pinned : b.pinned ? 1 : 0, now, id);
      return this.getDashboard(id);
    }
    const r = this.one<{ id: number }>('INSERT INTO dashboards (name, description, date_from, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id', b.name || 'New dashboard', b.description ?? '', b.date_from ?? null, b.pinned ? 1 : 0, now, now)!;
    return this.getDashboard(r.id);
  }
  async deleteDashboard(id: number) { this.sql.exec('DELETE FROM dashboard_tiles WHERE dashboard_id = ?', id); return this.sql.exec('DELETE FROM dashboards WHERE id = ?', id).rowsWritten > 0; }
  async addTile(did: number, insightId: number) {
    if (!this.one('SELECT 1 FROM dashboards WHERE id = ?', did) || !this.one('SELECT 1 FROM insights WHERE id = ?', insightId)) return false;
    const pos = this.one<{ m: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS m FROM dashboard_tiles WHERE dashboard_id = ?', did)!.m;
    this.sql.exec('INSERT OR IGNORE INTO dashboard_tiles (dashboard_id, insight_id, position) VALUES (?, ?, ?)', did, insightId, pos); return true;
  }
  async removeTile(did: number, insightId: number) { return this.sql.exec('DELETE FROM dashboard_tiles WHERE dashboard_id = ? AND insight_id = ?', did, insightId).rowsWritten > 0; }

  async listFlags() { return this.all<any>('SELECT * FROM feature_flags ORDER BY key').map(flagOut); }
  async getFlag(id: number) { const r = this.one<any>('SELECT * FROM feature_flags WHERE id = ?', id); return r ? flagOut(r) : null; }
  async saveFlag(id: number | null, b: { key?: string; name?: string; active?: boolean; filters?: unknown }): Promise<{ error: string } | ReturnType<typeof flagOut>> {
    const now = Date.now();
    if (b.key !== undefined && !/^[A-Za-z0-9_-]{1,200}$/.test(b.key)) return { error: 'key: letters, numbers, - and _ only' };
    if (b.filters !== undefined) { const e = validateFilters(b.filters); if (e) return { error: e }; }
    try {
      if (id) {
        const cur = this.one<any>('SELECT * FROM feature_flags WHERE id = ?', id); if (!cur) return { error: 'not_found' };
        this.sql.exec('UPDATE feature_flags SET key = ?, name = ?, active = ?, filters = ?, version = version + 1, updated_at = ? WHERE id = ?',
          b.key ?? cur.key, b.name ?? cur.name, b.active === undefined ? cur.active : b.active ? 1 : 0, b.filters === undefined ? cur.filters : JSON.stringify(b.filters), now, id);
        return (await this.getFlag(id))!;
      }
      if (!b.key) return { error: 'key is required' };
      const r = this.one<{ id: number }>('INSERT INTO feature_flags (key, name, active, filters, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
        b.key, b.name ?? '', b.active === false ? 0 : 1, JSON.stringify(b.filters ?? { groups: [{ properties: [], rollout_percentage: 100 }] }), now, now)!;
      return (await this.getFlag(r.id))!;
    } catch (e) { return { error: String(e).includes('UNIQUE') ? 'a flag with that key exists' : 'could not save' }; }
  }
  async deleteFlag(id: number) { return this.sql.exec('DELETE FROM feature_flags WHERE id = ?', id).rowsWritten > 0; }

  // ---------- experiments ----------
  private expOut(r: any) {
    const flag = this.one<any>('SELECT * FROM feature_flags WHERE key = ?', r.feature_flag_key);
    const f = flag ? parse(flag.filters) : {};
    return { id: r.id, name: r.name, description: r.description, feature_flag_key: r.feature_flag_key, feature_flag_id: flag?.id ?? null,
      variants: (f.multivariate?.variants ?? []).map((v: any) => ({ key: v.key, rollout_percentage: v.rollout_percentage })),
      metrics: parse(r.metrics), filters: parse(r.filters), archived: !!r.archived,
      start_date: r.start_date ? new Date(r.start_date).toISOString() : null, end_date: r.end_date ? new Date(r.end_date).toISOString() : null,
      status: r.end_date ? 'complete' : r.start_date ? 'running' : 'draft', created_at: r.created_at, updated_at: r.updated_at };
  }
  async listExperiments() { return this.all<any>('SELECT * FROM experiments ORDER BY id DESC').map(r => this.expOut(r)); }
  async getExperiment(id: number) { const r = this.one<any>('SELECT * FROM experiments WHERE id = ?', id); return r ? this.expOut(r) : null; }
  /**
   * Create or update. A new experiment creates its multivariate flag (inactive until launch) unless one with that key
   * exists; an existing flag must be multivariate. `action: launch` sets start_date and turns the flag on; `stop` ends it.
   */
  async saveExperiment(id: number | null, b: any): Promise<{ error: string } | ReturnType<ProjectStore['expOut']>> {
    const now = Date.now();
    let metrics: unknown[] | undefined;
    try { if (b.metrics !== undefined) { if (!Array.isArray(b.metrics) || b.metrics.length > 10) return { error: 'metrics must be a list of at most 10' }; metrics = b.metrics.map(validateMetric); } }
    catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
    const filters = b.filters !== undefined ? (Array.isArray(b.filters) ? b.filters : []) : undefined;
    if (!id) {
      const name = String(b.name ?? '').trim().slice(0, 200); if (!name) return { error: 'name is required' };
      const key = String(b.feature_flag_key ?? '').trim(); if (!/^[A-Za-z0-9_-]{1,200}$/.test(key)) return { error: 'feature_flag_key: letters, numbers, - and _ only' };
      const flag = this.one<any>('SELECT * FROM feature_flags WHERE key = ?', key);
      if (flag) { if (!parse(flag.filters).multivariate?.variants?.length) return { error: 'that flag has no variants; use a multivariate flag' }; }
      else {
        const variants = Array.isArray(b.variants) && b.variants.length >= 2 ? b.variants.map((v: any) => ({ key: String(v.key), rollout_percentage: Number(v.rollout_percentage) }))
          : [{ key: 'control', rollout_percentage: 50 }, { key: 'test', rollout_percentage: 50 }];
        if (variants[0].key !== 'control') return { error: 'the first variant must be control' };
        const r = await this.saveFlag(null, { key, name: `Experiment: ${name}`, active: false, filters: { groups: [{ properties: [], rollout_percentage: 100 }], multivariate: { variants } } });
        if ('error' in r) return r;
      }
      const r = this.one<{ id: number }>('INSERT INTO experiments (name, description, feature_flag_key, metrics, filters, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
        name, String(b.description ?? ''), key, JSON.stringify(metrics ?? []), JSON.stringify(filters ?? []), now, now)!;
      id = r.id;
    } else {
      const cur = this.one<any>('SELECT * FROM experiments WHERE id = ?', id); if (!cur) return { error: 'not_found' };
      this.sql.exec('UPDATE experiments SET name = ?, description = ?, metrics = ?, filters = ?, archived = ?, updated_at = ? WHERE id = ?',
        b.name !== undefined ? String(b.name).trim().slice(0, 200) || cur.name : cur.name, b.description !== undefined ? String(b.description) : cur.description,
        metrics ? JSON.stringify(metrics) : cur.metrics, filters ? JSON.stringify(filters) : cur.filters, b.archived !== undefined ? (b.archived ? 1 : 0) : cur.archived, now, id);
    }
    const cur = this.one<any>('SELECT * FROM experiments WHERE id = ?', id)!;
    if (b.action === 'launch' && !cur.start_date) {
      this.sql.exec('UPDATE experiments SET start_date = ?, updated_at = ? WHERE id = ?', now, now, id);
      this.sql.exec('UPDATE feature_flags SET active = 1, version = version + 1, updated_at = ? WHERE key = ?', now, cur.feature_flag_key);
    }
    if (b.action === 'stop' && cur.start_date && !cur.end_date) this.sql.exec('UPDATE experiments SET end_date = ?, updated_at = ? WHERE id = ?', now, now, id);
    return (await this.getExperiment(id))!;
  }
  async deleteExperiment(id: number) { return this.sql.exec('DELETE FROM experiments WHERE id = ? RETURNING id', id).toArray().length > 0; }
  async experimentResults(id: number, now = Date.now()) {
    const r = this.one<any>('SELECT * FROM experiments WHERE id = ?', id); if (!r) return null;
    const e = this.expOut(r);
    const exp: Experiment = { id: r.id, name: r.name, feature_flag_key: r.feature_flag_key, start_date: r.start_date, end_date: r.end_date, metrics: parse(r.metrics), filters: parse(r.filters) };
    return experimentResults(this.engine(), exp, e.variants.map((v: any) => v.key), now);
  }

  // ---------- surveys ----------
  private surveyRow(r: any) {
    return { id: r.id, name: r.name, description: r.description, type: r.type, questions: parse(r.questions), appearance: parse(r.appearance), conditions: r.conditions ? parse(r.conditions) : null,
      linked_flag_key: r.linked_flag_key, enable_partial_responses: !!r.enable_partial_responses, start_date: r.start_date, end_date: r.end_date, archived: !!r.archived, created_at: r.created_at, updated_at: r.updated_at };
  }
  private surveyOut(r: any) { const s = this.surveyRow(r); return { ...publicSurvey(s), archived: s.archived, status: s.end_date ? 'complete' : s.start_date ? 'running' : 'draft', created_at: s.created_at, updated_at: s.updated_at }; }
  async listSurveys() { return this.all<any>('SELECT * FROM surveys ORDER BY created_at DESC').map(r => this.surveyOut(r)); }
  async getSurvey(id: string) { const r = this.one<any>('SELECT * FROM surveys WHERE id = ?', id); return r ? this.surveyOut(r) : null; }
  /** `action: launch` sets start_date, `stop` sets end_date, `resume` clears it. */
  async saveSurvey(id: string | null, b: any): Promise<{ error: string } | ReturnType<ProjectStore['surveyOut']>> {
    const now = Date.now();
    const prev = id ? this.one<any>('SELECT * FROM surveys WHERE id = ?', id) : null;
    if (id && !prev) return { error: 'not_found' };
    let c: ReturnType<typeof cleanSurvey>;
    try { c = cleanSurvey(b, prev ? this.surveyRow(prev) : undefined); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
    const sid = id ?? crypto.randomUUID();
    let start = prev?.start_date ?? null, end = prev?.end_date ?? null;
    if (b.action === 'launch' && !start) start = now;
    if (b.action === 'stop' && start && !end) end = now;
    if (b.action === 'resume') end = null;
    this.sql.exec(`INSERT INTO surveys (id, name, description, type, questions, appearance, conditions, linked_flag_key, enable_partial_responses, start_date, end_date, archived, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, type = excluded.type, questions = excluded.questions,
        appearance = excluded.appearance, conditions = excluded.conditions, linked_flag_key = excluded.linked_flag_key, enable_partial_responses = excluded.enable_partial_responses,
        start_date = excluded.start_date, end_date = excluded.end_date, archived = excluded.archived, updated_at = excluded.updated_at`,
      sid, c.name, c.description, c.type, JSON.stringify(c.questions), JSON.stringify(c.appearance), c.conditions ? JSON.stringify(c.conditions) : null, c.linked_flag_key, c.enable_partial_responses ? 1 : 0,
      start, end, b.archived !== undefined ? (b.archived ? 1 : 0) : (prev?.archived ?? 0), prev?.created_at ?? now, now);
    return (await this.getSurvey(sid))!;
  }
  async deleteSurvey(id: string) { return this.sql.exec('DELETE FROM surveys WHERE id = ? RETURNING id', id).toArray().length > 0; }
  /** Launched, unfinished, unarchived surveys in posthog-js shape. */
  async activeSurveys() { return this.all<any>('SELECT * FROM surveys WHERE start_date IS NOT NULL AND end_date IS NULL AND archived = 0 ORDER BY created_at').map(r => publicSurvey(this.surveyRow(r))); }
  async hasActiveSurveys(): Promise<boolean> { return !!this.one('SELECT 1 AS x FROM surveys WHERE start_date IS NOT NULL AND end_date IS NULL AND archived = 0 LIMIT 1'); }
  async surveyResults(id: string) { const r = this.one<any>('SELECT * FROM surveys WHERE id = ?', id); return r ? surveyResults(this.engine(), this.surveyRow(r)) : null; }

  // ---------- session recordings ----------
  async recordReplay(metas: import('./replay').ReplayMeta[]) {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      for (const m of metas) this.sql.exec(`INSERT INTO session_recordings (session_id, distinct_id, start_ts, end_ts, click_count, keypress_count, console_error_count, first_url, size, chunks, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET start_ts = MIN(start_ts, excluded.start_ts), end_ts = MAX(end_ts, excluded.end_ts),
          click_count = click_count + excluded.click_count, keypress_count = keypress_count + excluded.keypress_count, console_error_count = console_error_count + excluded.console_error_count,
          first_url = CASE WHEN excluded.start_ts < start_ts OR first_url IS NULL THEN COALESCE(excluded.first_url, first_url) ELSE first_url END,
          distinct_id = CASE WHEN distinct_id = '' THEN excluded.distinct_id ELSE distinct_id END, size = size + excluded.size, chunks = chunks + excluded.chunks`,
        m.session_id, m.distinct_id, m.start_ts, m.end_ts, m.clicks, m.keypresses, m.console_errors, m.first_url, m.size, m.chunks, now);
    });
  }
  private recordingOut(r: any, ref?: PersonRef) {
    return { id: r.session_id, distinct_id: r.distinct_id, start_time: new Date(r.start_ts).toISOString(), end_time: new Date(r.end_ts).toISOString(),
      recording_duration: Math.round((r.end_ts - r.start_ts) / 1000), click_count: r.click_count, keypress_count: r.keypress_count, console_error_count: r.console_error_count,
      start_url: r.first_url, size: r.size, chunks: r.chunks,
      person: ref?.uuid ? { id: ref.uuid, name: (ref.props.email ?? ref.props.name ?? r.distinct_id) as string } : null };
  }
  async listRecordings(o: { personId?: string | null; distinctId?: string | null; before?: number | null; limit?: number }) {
    const limit = Math.min(Math.max(o.limit ?? 50, 1), 200);
    let dids: string[] | null = null;
    if (o.personId) dids = this.engine().distinctIdsOfPerson(o.personId);
    if (o.distinctId) dids = [o.distinctId];
    const rows = this.all<any>(`SELECT * FROM session_recordings WHERE (? IS NULL OR distinct_id IN (SELECT value FROM json_each(?))) AND (? IS NULL OR start_ts < ?) ORDER BY start_ts DESC LIMIT ?`,
      dids ? 1 : null, JSON.stringify(dids ?? []), o.before ?? null, o.before ?? null, limit + 1);
    const page = rows.slice(0, limit); const people = this.engine().resolve(page.map(r => r.distinct_id));
    return { results: page.map(r => this.recordingOut(r, people.get(r.distinct_id))), next: rows.length > limit ? page[page.length - 1].start_ts : null };
  }
  async getRecording(sid: string) {
    const r = this.one<any>('SELECT * FROM session_recordings WHERE session_id = ?', sid);
    return r ? this.recordingOut(r, this.engine().resolve([r.distinct_id]).get(r.distinct_id)) : null;
  }
  async deleteRecording(sid: string) { return this.sql.exec('DELETE FROM session_recordings WHERE session_id = ? RETURNING session_id', sid).toArray().length > 0; }
  /** Drops recordings that ended before the cutoff; returns their session ids so the caller can delete the R2 chunks. */
  async expireRecordings(before: number): Promise<string[]> {
    return this.sql.exec('DELETE FROM session_recordings WHERE end_ts < ? RETURNING session_id', before).toArray().map(r => String(r.session_id));
  }
  async recordingIds(): Promise<string[]> { return this.all<{ s: string }>('SELECT session_id AS s FROM session_recordings').map(r => r.s); }

  // ---------- housekeeping ----------
  async stats() {
    const since = Date.now() - 86400_000;
    const parts = [this.hasLegacy() ? { ...X.eventStats(this.sql, since), bytes: 0 } : null,
      ...await Promise.all(this.all<{ key: string }>('SELECT key FROM shards').map(r => this.shardStub(r.key).stats(since)))].filter(Boolean) as { events: number; events_24h: number; last_event_at: number | null; bytes: number }[];
    return { events: parts.reduce((a, p) => a + p.events, 0), persons: this.one<{ c: number }>('SELECT COUNT(*) AS c FROM persons')!.c,
      events_24h: parts.reduce((a, p) => a + p.events_24h, 0),
      last_event_at: parts.reduce<number | null>((a, p) => p.last_event_at !== null && (a === null || p.last_event_at > a) ? p.last_event_at : a, null),
      database_bytes: this.sql.databaseSize + parts.reduce((a, p) => a + p.bytes, 0), shards: parts.length };
  }
  async firstEventAt(): Promise<number | null> {
    let m: number | null = this.hasLegacy() ? (this.one<{ m: number | null }>('SELECT MIN(timestamp) AS m FROM events')!.m) : null;
    for (const r of this.all<{ key: string }>('SELECT key FROM shards WHERE events > 0 ORDER BY start LIMIT 3')) {
      const s = await this.shardStub(r.key).stats(0); if (s.min_ts !== null && (m === null || s.min_ts < m)) m = s.min_ts; if (s.min_ts !== null) break;
    }
    return m;
  }
  /** Retention: whole shards before the cutoff are deleted; the boundary shard and the legacy table are trimmed. */
  async purge(beforeMs: number) {
    let total = X.purgeBefore(this.sql, beforeMs); this.legacyRows = null;
    for (const r of this.all<{ key: string; end: number; events: number }>('SELECT key, end, events FROM shards WHERE start < ?', beforeMs)) {
      const st = this.shardStub(r.key);
      if (r.end <= beforeMs) { await st.destroy(); this.sql.exec('DELETE FROM shards WHERE key = ?', r.key); total += r.events; }
      else { const n = await st.purge(beforeMs); total += n; this.sql.exec('UPDATE shards SET events = MAX(0, events - ?) WHERE key = ?', n, r.key); }
    }
    this.sql.exec('DELETE FROM ingest_log WHERE at < ?', Date.now() - 7 * 86400_000);
    return total;
  }
  async destroy() {
    for (const r of this.all<{ key: string }>('SELECT key FROM shards')) await this.shardStub(r.key).destroy();
    await this.ctx.storage.deleteAll();
  }
}

function personOut(r: any) {
  const props = parse(r.properties);
  const distinct_ids: string[] = r.dids ? String(r.dids).split('\u001f') : [];
  return { id: r.uuid, pk: r.id, name: props.email ?? props.name ?? distinct_ids[0] ?? r.uuid, distinct_ids, properties: props, is_identified: !!r.is_identified, created_at: r.created_at, last_seen_at: r.last_seen_at };
}
function insightOut(r: any) { return { id: r.id, short_id: r.short_id, name: r.name, description: r.description, query: parse(r.query), created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at }; }
function flagOut(r: any) { return { id: r.id, key: r.key, name: r.name, active: !!r.active, filters: parse(r.filters), version: r.version, created_at: r.created_at, updated_at: r.updated_at }; }
function validateFilters(f: any): string | null {
  if (!f || typeof f !== 'object') return 'filters must be an object';
  if (!Array.isArray(f.groups)) return 'filters.groups must be a list';
  for (const g of f.groups) {
    if (g.rollout_percentage !== undefined && g.rollout_percentage !== null && !(g.rollout_percentage >= 0 && g.rollout_percentage <= 100)) return 'rollout_percentage must be 0-100';
    if (g.properties !== undefined && !Array.isArray(g.properties)) return 'condition properties must be a list';
  }
  if (f.multivariate) {
    const v = f.multivariate.variants;
    if (!Array.isArray(v) || !v.length) return 'multivariate.variants must be a non-empty list';
    const sum = v.reduce((a: number, x: any) => a + Number(x.rollout_percentage || 0), 0);
    if (Math.round(sum) !== 100) return 'variant rollout percentages must add up to 100';
    if (v.some((x: any) => !/^[A-Za-z0-9_-]{1,100}$/.test(String(x.key)))) return 'variant keys: letters, numbers, - and _';
  }
  for (const [k, v] of Object.entries(f.payloads ?? {})) { try { JSON.parse(String(v)); } catch { return `payload for ${k} is not valid JSON`; } }
  return null;
}
