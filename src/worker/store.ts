// ProjectStore: one SQLite-backed Durable Object per project (design.md "Event store").
// Holds events, persons, groups, definitions, insights, dashboards and feature flags.
import { DurableObject } from 'cloudflare:workers';
import type { Env, NormEvent } from './env';
import { isIllegalDistinctId, uuidv7 } from '../shared/ids';
import { evaluateFlag, FlagDef, FlagResult } from '../shared/flags';
import { runQuery, QueryContext } from './query';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS events (
     id INTEGER PRIMARY KEY, uuid TEXT NOT NULL UNIQUE, event TEXT NOT NULL, distinct_id TEXT NOT NULL,
     timestamp INTEGER NOT NULL, properties TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS events_ts ON events (timestamp)`,
  `CREATE INDEX IF NOT EXISTS events_event_ts ON events (event, timestamp)`,
  `CREATE INDEX IF NOT EXISTS events_did_ts ON events (distinct_id, timestamp)`,
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

  // ---------- ingestion ----------
  async ingest(events: NormEvent[]): Promise<{ inserted: number; duplicates: number }> {
    let inserted = 0, duplicates = 0;
    this.ctx.storage.transactionSync(() => {
      const lastSeen = new Map<string, number>();
      for (const ev of events) {
        const r = this.sql.exec('INSERT OR IGNORE INTO events (uuid, event, distinct_id, timestamp, properties, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          ev.uuid, ev.event, ev.distinct_id, ev.ts, JSON.stringify(ev.properties), ev.received_at);
        if (r.rowsWritten === 0) { duplicates++; continue; }
        inserted++;
        this.define(ev);
        if (ev.event === '$groupidentify') this.groupIdentify(ev);
        if (ev.person) this.processPerson(ev);
        lastSeen.set(ev.distinct_id, Math.max(lastSeen.get(ev.distinct_id) ?? 0, ev.ts));
      }
      for (const [did, ts] of lastSeen) this.sql.exec('UPDATE persons SET last_seen_at = MAX(COALESCE(last_seen_at, 0), ?) WHERE id = (SELECT person_id FROM person_distinct_ids WHERE distinct_id = ?)', ts, did);
    });
    return { inserted, duplicates };
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
  async query(q: unknown, qc: QueryContext): Promise<unknown> { return runQuery(this.sql, q, qc); }

  async definitions() {
    return {
      events: this.all('SELECT name, first_seen_at, last_seen_at FROM event_definitions ORDER BY last_seen_at DESC LIMIT 1000'),
      properties: this.all('SELECT kind, name, type FROM property_definitions ORDER BY kind, name LIMIT 5000'),
      group_types: this.all('SELECT idx, name FROM group_types ORDER BY idx'),
    };
  }
  async propertyValues(kind: string, key: string): Promise<string[]> {
    const path = '$.' + JSON.stringify(key);
    const rows = kind === 'person'
      ? this.all<{ v: string }>('SELECT DISTINCT CAST(json_extract(properties, ?) AS TEXT) AS v FROM persons WHERE json_extract(properties, ?) IS NOT NULL LIMIT 50', path, path)
      : this.all<{ v: string }>('SELECT DISTINCT CAST(json_extract(properties, ?) AS TEXT) AS v FROM (SELECT properties FROM events ORDER BY timestamp DESC LIMIT 5000) WHERE json_extract(properties, ?) IS NOT NULL LIMIT 50', path, path);
    return rows.map(r => r.v);
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
  async deletePerson(id: string, deleteEvents: boolean) {
    const p = this.one<{ id: number }>('SELECT id FROM persons WHERE uuid = ? OR CAST(id AS TEXT) = ?', id, id);
    if (!p) return false;
    this.ctx.storage.transactionSync(() => {
      if (deleteEvents) this.sql.exec('DELETE FROM events WHERE distinct_id IN (SELECT distinct_id FROM person_distinct_ids WHERE person_id = ?)', p.id);
      this.sql.exec('DELETE FROM person_distinct_ids WHERE person_id = ?', p.id);
      this.sql.exec('DELETE FROM persons WHERE id = ?', p.id);
    });
    return true;
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

  // ---------- housekeeping ----------
  async stats() {
    const c = (q: string) => this.one<{ c: number }>(q)!.c;
    return { events: c('SELECT COUNT(*) AS c FROM events'), persons: c('SELECT COUNT(*) AS c FROM persons'),
      events_24h: this.one<{ c: number }>('SELECT COUNT(*) AS c FROM events WHERE timestamp > ?', Date.now() - 86400_000)!.c,
      last_event_at: this.one<{ m: number | null }>('SELECT MAX(created_at) AS m FROM events')!.m, database_bytes: this.sql.databaseSize };
  }
  async firstEventAt(): Promise<number | null> { return this.one<{ m: number | null }>('SELECT MIN(timestamp) AS m FROM events')!.m; }
  async purge(beforeMs: number) {
    let total = 0;
    for (;;) { const n = this.sql.exec('DELETE FROM events WHERE id IN (SELECT id FROM events WHERE timestamp < ? LIMIT 5000)', beforeMs).rowsWritten; total += n; if (n < 5000) break; }
    return total;
  }
  async destroy() { await this.ctx.storage.deleteAll(); }
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
