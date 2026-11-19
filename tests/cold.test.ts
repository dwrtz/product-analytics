// 0.4: cold tier (design.md "Cold tier"): AST -> Basin SQL compiler, forced project and retention filters, records.
import { describe, it, expect } from 'vitest';
import { buildColdQuery, coldRecord, coldEnabled } from '../src/worker/cold';

const NOW = Date.parse('2026-11-19T00:00:00Z');
const q = (src: string, retentionDays = 365, projectId = 7) => buildColdQuery(src, { table: 'analytics.events', projectId, retentionDays, now: NOW });

describe('cold tier compiler', () => {
  it('always scopes to the project and the retention window', () => {
    const { sql } = q('SELECT event, count() FROM events GROUP BY event ORDER BY 2 DESC LIMIT 5');
    const cutoff = NOW - 365 * 86400_000;
    expect(sql).toBe(`SELECT event AS c0, COUNT(*) AS c1 FROM analytics.events WHERE project_id = 7 AND timestamp >= to_timestamp_millis(${cutoff}) AND ts >= ${cutoff} GROUP BY event ORDER BY c1 DESC LIMIT 6`);
  });
  it('keeps forever when retention is 0', () => {
    expect(q('SELECT count() FROM events', 0).sql).toBe('SELECT COUNT(*) AS c0 FROM analytics.events WHERE project_id = 7 LIMIT 101');
  });
  it('user WHERE is ANDed after the forced filters, so OR cannot escape them', () => {
    const { sql } = q("SELECT uuid FROM events WHERE event = 'a' OR 1 = 1", 0);
    expect(sql).toContain("WHERE project_id = 7 AND ((event = 'a') OR (1 = 1))");
  });
  it('quotes strings and property keys; nothing is spliced', () => {
    const { sql } = q("SELECT properties.$current_url FROM events WHERE properties['it''s'] = 'x''; DROP TABLE t; --'", 0);
    expect(sql).toContain("json_get_str(properties, '$current_url') AS c0");
    expect(sql).toContain("(json_get_str(properties, 'it''s') = 'x''; DROP TABLE t; --')");
  });
  it('numeric property comparisons use json_get_float; dates are epoch ms on ts', () => {
    const { sql } = q("SELECT toStartOfDay(timestamp) AS day, sum(properties.price) FROM events WHERE properties.price > 10 AND timestamp >= '2026-11-01' GROUP BY day", 0);
    expect(sql).toContain('((CAST(ts AS BIGINT) / 86400000) * 86400000) AS c0');
    expect(sql).toContain('SUM(json_get_float(properties, \'price\')) AS c1');
    expect(sql).toContain("(json_get_float(properties, 'price') > 10)");
    expect(sql).toContain(`(ts >= ${Date.parse('2026-11-01')})`);
    expect(sql).toContain('GROUP BY ((CAST(ts AS BIGINT) / 86400000) * 86400000)');
  });
  it('SELECT * expands to event columns; DateTime type for timestamp', () => {
    const r = q('SELECT * FROM events LIMIT 3', 0);
    expect(r.columns).toEqual(['uuid', 'event', 'distinct_id', 'timestamp', 'properties']);
    expect(r.types[3]).toBe('DateTime');
    expect(r.sql).toBe('SELECT uuid AS c0, event AS c1, distinct_id AS c2, ts AS c3, properties AS c4 FROM analytics.events WHERE project_id = 7 LIMIT 4');
  });
  it('rejects persons and person columns', () => {
    expect(() => q('SELECT id FROM persons')).toThrow(/only has events/);
    expect(() => q('SELECT person.properties.email FROM events')).toThrow(/person columns/);
  });
  it('countIf / uniq / ilike / week start', () => {
    const { sql } = q("SELECT countIf(event = 'x'), uniq(distinct_id), toStartOfWeek(timestamp) FROM events WHERE event ILIKE '%Page%' GROUP BY 3", 0);
    expect(sql).toContain("SUM(CASE WHEN (event = 'x') THEN 1 ELSE 0 END) AS c0");
    expect(sql).toContain('approx_distinct(distinct_id) AS c1');
    expect(sql).toContain("(lower(event) LIKE lower('%Page%'))");
    expect(sql).toContain('((CAST(ts AS BIGINT) / 86400000) - (((CAST(ts AS BIGINT) / 86400000) + 4) % 7)) * 86400000');
  });
  it('records and enablement', () => {
    const r = coldRecord(3, { uuid: 'u', event: 'e', distinct_id: 'd', ts: NOW, properties: { a: 1 }, person: true, received_at: NOW } as any);
    expect(r).toEqual({ project_id: 3, uuid: 'u', event: 'e', distinct_id: 'd', timestamp: '2026-11-19T00:00:00.000Z', ts: NOW, properties: '{"a":1}' });
    expect(coldEnabled({} as any)).toBe(false);
  });
});
