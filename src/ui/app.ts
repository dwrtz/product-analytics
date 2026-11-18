// The owner web app (spec R13). No framework: small DOM helpers, history routing and SVG charts.
import settings from '../../spekkr.inputs.json';

const APP = settings.app_name;
type Project = { id: number; name: string; api_token: string; timezone: string; retention_days: number; anonymize_ips: boolean; autocapture_opt_out: boolean; created_at: string };
type Me = { id: number; email: string; name: string };
let me: Me | null = null;
let projects: Project[] = [];
let defs: { events: { name: string }[]; properties: { kind: string; name: string; type: string }[]; group_types: { idx: number; name: string }[] } | null = null;
let defsFor = 0;

// ---------- helpers ----------
type Child = Node | string | number | null | undefined | false;
function h(tag: string, attrs: Record<string, any> = {}, ...kids: (Child | Child[])[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') (el as HTMLInputElement).value = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const SVGNS = 'http://www.w3.org/2000/svg';
function s(tag: string, attrs: Record<string, any> = {}, ...kids: (Node | string)[]): SVGElement {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  for (const c of kids) el.append(c);
  return el;
}
class ApiError extends Error { constructor(public code: string, msg: string, public status = 0) { super(msg); } }
async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), credentials: 'same-origin',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? 'error', friendly(data.error, data.detail), res.status);
  return data;
}
function friendly(code: string, detail?: string) {
  const m: Record<string, string> = {
    email_not_allowed: 'This instance is private.', signup_closed: 'Sign-up is closed on this instance.', bad_credentials: 'Wrong email or password.',
    taken: 'That email already has an account.', weak_password: 'Use at least 10 characters.',
  };
  return m[code] ?? detail ?? code ?? 'Something went wrong.';
}
function nav(to: string) { history.pushState({}, '', to); render(); }
const link = (to: string, label: Child | Child[], cls = '') => h('a', { href: to, class: cls, onclick: (e: MouseEvent) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); nav(to); } }, label);
const fmt = (n: number | null | undefined) => n === null || n === undefined ? '–' : Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
const when = (t: string | number | null) => { if (t === null || t === undefined) return '–'; const d = new Date(t); return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }); };
const ago = (t: number | string | null) => { if (!t) return 'never'; const s = (Date.now() - new Date(t).getTime()) / 1000; if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ago`; return `${Math.floor(s / 86400)} d ago`; };
const errBox = () => h('p', { class: 'error', role: 'alert' });
function busy(btn: HTMLButtonElement, fn: () => Promise<void>, err: HTMLElement) {
  return async (e?: Event) => {
    e?.preventDefault(); btn.disabled = true; err.textContent = '';
    try { await fn(); } catch (x) { err.textContent = x instanceof Error ? x.message : String(x); } finally { btn.disabled = false; }
  };
}
const PALETTE = ['#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#0ea5e9', '#ec4899', '#84cc16', '#64748b', '#f97316'];
const color = (i: number) => i === 0 ? (getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#1d4ed8') : PALETTE[(i - 1) % PALETTE.length];
const eventLabel = (e: string | null | undefined) => e === null || e === undefined ? 'All events' : ({ $pageview: 'Pageview', $pageleave: 'Pageleave', $autocapture: 'Autocapture', $identify: 'Identify', $groupidentify: 'Group identify', $feature_flag_called: 'Feature flag called', $set: 'Set person properties', $create_alias: 'Alias' } as Record<string, string>)[e] ?? e;

// ---------- layout ----------
const root = document.getElementById('app')!;
let pid = 0;
const P = (p = '') => `/project/${pid}${p}`;
const project = () => projects.find(p => p.id === pid)!;
function shell(title: Child | Child[], actions: Child[], ...content: Child[]) {
  const here = location.pathname;
  const item = (to: string, label: string) => link(P(to), label, here === P(to) || (to !== '' && here.startsWith(P(to) + '/')) ? 'active' : '');
  const picker = h('select', { 'aria-label': 'Project', onchange: (e: Event) => nav(`/project/${(e.target as HTMLSelectElement).value}`) },
    projects.map(p => h('option', { value: p.id, selected: p.id === pid }, p.name)));
  root.replaceChildren(h('div', { class: 'layout' },
    h('nav', { class: 'side' },
      h('div', { class: 'brand' }, APP),
      h('div', { class: 'proj' }, picker),
      h('div', { class: 'side-links' },
        item('/dashboards', 'Dashboards'), item('/insights', 'Insights'), item('/events', 'Events'), item('/persons', 'Persons'),
        item('/feature_flags', 'Feature flags'), item('/settings', 'Settings'),
        link('/account', 'Account', here === '/account' ? 'active' : ''))),
    h('main', {}, h('header', { class: 'top' }, h('h1', {}, title), h('div', { class: 'row' }, actions)), ...content)));
}
function blank(...content: Child[]) { root.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'auth' }, ...content))); }
const loading = () => h('p', { class: 'muted' }, 'Loading…');

// ---------- auth ----------
async function authPage(mode: 'login' | 'signup') {
  const cfg = await api<{ signup_open: boolean }>('/api/config');
  const email = h('input', { type: 'email', autocomplete: 'email', required: true }) as HTMLInputElement;
  const pw = h('input', { type: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password', required: true, minlength: mode === 'signup' ? 10 : undefined }) as HTMLInputElement;
  const name = h('input', { autocomplete: 'name' }) as HTMLInputElement;
  const err = errBox(); const btn = h('button', { class: 'primary', type: 'submit' }, mode === 'login' ? 'Sign in' : 'Create account') as HTMLButtonElement;
  const form = h('form', { class: 'card' },
    mode === 'signup' ? h('label', {}, 'Name', name) : null,
    h('label', {}, 'Email', email), h('label', {}, 'Password', pw), err, btn);
  form.addEventListener('submit', busy(btn, async () => {
    await api(`/api/${mode}`, { body: { email: email.value, password: pw.value, name: name.value } });
    me = null; nav('/');
  }, err));
  blank(h('h1', {}, APP), h('p', { class: 'muted' }, mode === 'login' ? 'Sign in to your analytics.' : 'Create the first account on this instance.'), form,
    mode === 'login' ? (cfg.signup_open ? h('p', { class: 'small' }, 'No account? ', link('/signup', 'Sign up')) : null) : h('p', { class: 'small' }, 'Have an account? ', link('/login', 'Sign in')));
}

// ---------- projects ----------
function newProjectForm(onDone: (p: Project) => void) {
  const name = h('input', { placeholder: 'My website', required: true }) as HTMLInputElement;
  const tz = h('input', { value: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }) as HTMLInputElement;
  const err = errBox(); const btn = h('button', { class: 'primary', type: 'submit' }, 'Create project') as HTMLButtonElement;
  const f = h('form', { class: 'card' }, h('label', {}, 'Project name', name), h('label', {}, 'Time zone', tz, h('span', { class: 'muted small' }, 'Days, weeks and months in insights start in this zone.')), err, btn);
  f.addEventListener('submit', busy(btn, async () => { const p = await api<Project>('/api/projects', { body: { name: name.value, timezone: tz.value } }); projects.push(p); onDone(p); }, err));
  return f;
}
function onboarding() {
  blank(h('h1', {}, 'Create your first project'), h('p', { class: 'muted' }, 'A project holds one site or app: its events, people, insights and flags.'), newProjectForm(p => nav(`/project/${p.id}/settings`)));
}

// ---------- property filters ----------
type PF = { key: string; value?: unknown; operator?: string; type?: 'event' | 'person' };
const OPS: [string, string][] = [['exact', '='], ['is_not', '≠'], ['icontains', 'contains'], ['not_icontains', "doesn't contain"], ['gt', '>'], ['lt', '<'], ['is_set', 'is set'], ['is_not_set', 'is not set']];
function propOptions(kind: 'event' | 'person') {
  const names = (defs?.properties ?? []).filter(p => p.kind === kind).map(p => p.name);
  return h('datalist', { id: `props-${kind}` }, names.map(n => h('option', { value: n })));
}
function filterEditor(list: PF[], onChange: () => void): HTMLElement {
  const box = h('div', { class: 'filters' });
  const draw = () => {
    box.replaceChildren(...list.map((f, i) => {
      const type = h('select', { 'aria-label': 'Property type', onchange: (e: Event) => { f.type = (e.target as HTMLSelectElement).value as any; draw(); onChange(); } },
        h('option', { value: 'event', selected: f.type !== 'person' }, 'Event'), h('option', { value: 'person', selected: f.type === 'person' }, 'Person'));
      const key = h('input', { value: f.key, placeholder: 'property', list: `props-${f.type === 'person' ? 'person' : 'event'}`, 'aria-label': 'Property', onchange: (e: Event) => { f.key = (e.target as HTMLInputElement).value.trim(); onChange(); } });
      const op = h('select', { 'aria-label': 'Operator', onchange: (e: Event) => { f.operator = (e.target as HTMLSelectElement).value; draw(); onChange(); } }, OPS.map(([v, l]) => h('option', { value: v, selected: (f.operator ?? 'exact') === v }, l)));
      const needsValue = !['is_set', 'is_not_set'].includes(f.operator ?? 'exact');
      const val = needsValue ? h('input', { value: Array.isArray(f.value) ? f.value.join(', ') : (f.value ?? ''), placeholder: 'value', 'aria-label': 'Value', onchange: (e: Event) => {
        const v = (e.target as HTMLInputElement).value; f.value = ['exact', 'is_not'].includes(f.operator ?? 'exact') ? v.split(',').map(x => x.trim()).filter(Boolean) : v; onChange();
      } }) : null;
      return h('div', { class: 'filter' }, type, key, op, val, h('button', { class: 'link', type: 'button', 'aria-label': 'Remove filter', onclick: () => { list.splice(i, 1); draw(); onChange(); } }, '✕'));
    }), h('button', { class: 'link', type: 'button', onclick: () => { list.push({ key: '', operator: 'exact', type: 'event', value: [] }); draw(); } }, '+ Add filter'));
  };
  draw(); return box;
}
async function ensureDefs() {
  if (defs && defsFor === pid) return;
  defs = await api(P('/definitions').replace('/project/', '/api/projects/')); defsFor = pid;
}
const apiP = (p: string) => `/api/projects/${pid}${p}`;
function eventInput(value: string | null, onChange: (v: string | null) => void, allowAll = true) {
  const i = h('input', { value: value ?? (allowAll ? '' : '$pageview'), list: 'event-names', placeholder: allowAll ? 'All events' : 'event name', 'aria-label': 'Event', onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value.trim(); onChange(v ? v : allowAll ? null : '$pageview'); } });
  return i;
}
const eventList = () => h('datalist', { id: 'event-names' }, (defs?.events ?? []).map(e => h('option', { value: e.name }, eventLabel(e.name))));

// ---------- charts ----------
type Series = { action?: { id: string | null; custom_name: string | null; math: string; math_property?: string }; breakdown_label?: string; label: string; data: number[]; labels: string[]; count: number; aggregated_value?: number; breakdown_value?: unknown; compare_label?: string };
const MATH_SUFFIX: Record<string, string> = { dau: 'unique persons', unique_session: 'unique sessions', unique_group: 'unique groups', sum: 'sum', avg: 'average', min: 'min', max: 'max', median: 'median', p75: 'p75', p90: 'p90', p95: 'p95', p99: 'p99' };
function seriesName(sr: Series) {
  if (!sr.action) return sr.label;
  const base = sr.action.custom_name || eventLabel(sr.action.id);
  const m = MATH_SUFFIX[sr.action.math]; const mp = sr.action.math_property ? ` of ${sr.action.math_property}` : '';
  return `${base}${m ? ` · ${m}${mp}` : ''}${sr.breakdown_label !== undefined ? ` · ${sr.breakdown_label}` : ''}`;
}
function niceMax(v: number) { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }
function lineChart(series: Series[], bars = false): HTMLElement {
  const W = 720, H = 260, L = 44, R = 12, T = 12, B = 30;
  const labels = series[0]?.labels ?? [];
  const max = niceMax(Math.max(0, ...series.flatMap(x => x.data)));
  const n = Math.max(labels.length, 1);
  const x = (i: number) => L + (bars ? (i + 0.5) * (W - L - R) / n : n === 1 ? (W - L - R) / 2 : i * (W - L - R) / (n - 1));
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Chart' });
  for (let k = 0; k <= 4; k++) { const v = max * k / 4; svg.append(s('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' }), s('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis' }, fmt(v))); }
  const step = Math.ceil(n / 8);
  labels.forEach((l, i) => { if (i % step === 0) svg.append(s('text', { x: x(i), y: H - 10, 'text-anchor': 'middle', class: 'axis' }, l.length > 10 ? l.slice(5) : l)); });
  series.forEach((sr, si) => {
    const c = color(si);
    if (bars) {
      const bw = Math.max(2, (W - L - R) / n / (series.length + 1));
      sr.data.forEach((v, i) => svg.append(s('rect', { x: x(i) - bw * series.length / 2 + si * bw, y: y(v), width: bw - 1, height: Math.max(0, y(0) - y(v)), fill: c }, s('title', {}, `${seriesName(sr)} · ${labels[i]}: ${fmt(v)}`))));
    } else {
      svg.append(s('polyline', { points: sr.data.map((v, i) => `${x(i)},${y(v)}`).join(' '), fill: 'none', stroke: c, 'stroke-width': 2, 'stroke-dasharray': sr.compare_label === 'previous' ? '5 4' : undefined }));
      sr.data.forEach((v, i) => svg.append(s('circle', { cx: x(i), cy: y(v), r: n > 40 ? 0 : 3, fill: c }, s('title', {}, `${seriesName(sr)} · ${labels[i]}: ${fmt(v)}`))));
    }
  });
  return h('div', { class: 'chart-wrap' }, svg as unknown as Node, legend(series));
}
function legend(series: Series[]) {
  return h('ul', { class: 'legend' }, series.map((sr, i) => h('li', {}, h('span', { class: 'swatch', style: `background:${color(i)}` }), seriesName(sr), sr.compare_label ? ` (${sr.compare_label})` : '', h('b', {}, fmt(sr.aggregated_value ?? sr.count)))));
}
function barValue(series: Series[]) {
  const max = Math.max(1, ...series.map(x => x.aggregated_value ?? x.count));
  return h('div', { class: 'hbars' }, series.map((sr, i) => h('div', { class: 'hbar' }, h('span', { class: 'hl', title: seriesName(sr) }, sr.breakdown_label ?? seriesName(sr)), h('span', { class: 'track' }, h('span', { class: 'fill', style: `width:${100 * (sr.aggregated_value ?? sr.count) / max}%;background:${color(i)}` })), h('b', {}, fmt(sr.aggregated_value ?? sr.count)))));
}
function trendsView(res: { results: Series[] }, display: string) {
  const r = res.results;
  if (!r.length) return h('p', { class: 'muted empty' }, 'No data in this range.');
  if (display === 'BoldNumber') return h('div', { class: 'bold-number' }, r.slice(0, 2).map((x, i) => h('div', {}, h('div', { class: 'big', style: `color:${color(i)}` }, fmt(x.aggregated_value ?? x.count)), h('div', { class: 'muted' }, seriesName(x), x.compare_label ? ` (${x.compare_label})` : ''))));
  if (display === 'ActionsTable') return h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Series'), h('th', { class: 'num' }, 'Value'))), h('tbody', {}, r.map(x => h('tr', {}, h('td', {}, seriesName(x), x.compare_label ? ` (${x.compare_label})` : ''), h('td', { class: 'num' }, fmt(x.aggregated_value ?? x.count))))));
  if (display === 'ActionsBarValue' || display === 'ActionsPie') return barValue(r);
  return lineChart(r, display === 'ActionsBar');
}
type FunnelStep = { name: string; custom_name: string | null; count: number; average_conversion_time: number | null; median_conversion_time: number | null; breakdown_value?: unknown };
const dur = (sec: number | null) => sec === null ? '–' : sec < 60 ? `${Math.round(sec)}s` : sec < 3600 ? `${Math.round(sec / 60)}m` : sec < 86400 ? `${(sec / 3600).toFixed(1)}h` : `${(sec / 86400).toFixed(1)}d`;
function funnelView(res: { results: FunnelStep[] | FunnelStep[][] }) {
  const groups: FunnelStep[][] = Array.isArray(res.results[0]) ? res.results as FunnelStep[][] : [res.results as FunnelStep[]];
  if (!groups.length || !groups[0].length) return h('p', { class: 'muted empty' }, 'No data in this range.');
  return h('div', {}, groups.map((steps, gi) => {
    const first = steps[0]?.count || 0;
    return h('div', { class: 'funnel' },
      groups.length > 1 ? h('h3', {}, String(steps[0]?.breakdown_value ?? '')) : null,
      h('div', { class: 'summary' }, h('span', { class: 'big', style: `color:${color(gi)}` }, first ? `${(100 * (steps.at(-1)!.count) / first).toFixed(1)}%` : '0%'), h('span', { class: 'muted' }, ' total conversion')),
      steps.map((st, i) => {
        const pct = first ? 100 * st.count / first : 0; const prev = i ? steps[i - 1].count : st.count;
        return h('div', { class: 'fstep' },
          h('div', { class: 'fhead' }, h('b', {}, `${i + 1}. ${st.custom_name || eventLabel(st.name)}`), h('span', { class: 'muted small' }, i ? `${prev ? (100 * st.count / prev).toFixed(1) : 0}% from previous · median ${dur(st.median_conversion_time)}` : '')),
          h('div', { class: 'track tall' }, h('span', { class: 'fill', style: `width:${pct}%;background:${color(gi)}` })),
          h('div', { class: 'small' }, h('b', {}, fmt(st.count)), ` persons · ${pct.toFixed(1)}%`, i ? h('span', { class: 'muted' }, ` · ${fmt(prev - st.count)} dropped off`) : null));
      }));
  }));
}
type RetRow = { date: string; label: string; cohort_label?: string; values: { count: number }[] };
function retentionView(res: { results: RetRow[] }) {
  const rows = res.results;
  if (!rows.length) return h('p', { class: 'muted empty' }, 'No data in this range.');
  const cols = Math.max(...rows.map(r => r.values.length));
  return h('div', { class: 'scroll' }, h('table', { class: 'retention' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Cohort'), h('th', { class: 'num' }, 'Persons'), Array.from({ length: cols }, (_, i) => h('th', { class: 'num' }, `${i}`)))),
    h('tbody', {}, rows.map(r => { const base = r.values[0]?.count ?? 0; return h('tr', {}, h('td', { class: 'nowrap' }, r.cohort_label ?? r.date.slice(0, 10)), h('td', { class: 'num' }, fmt(base)),
      Array.from({ length: cols }, (_, i) => { const v = r.values[i]; if (!v) return h('td', {}); const p = base ? 100 * v.count / base : 0; return h('td', { class: 'num cell', style: `background:color-mix(in srgb, var(--accent) ${Math.round(p * 0.8)}%, white);color:${p > 55 ? '#fff' : 'inherit'}`, title: `${fmt(v.count)} persons` }, `${p.toFixed(1)}%`); })); }))));
}
function renderResult(q: any, res: any) {
  if (q.kind === 'FunnelsQuery') return funnelView(res);
  if (q.kind === 'RetentionQuery') return retentionView(res);
  return trendsView(res, q.trendsFilter?.display ?? 'ActionsLineGraph');
}
async function runInsight(q: any, into: HTMLElement) {
  into.replaceChildren(loading());
  try { const res = await api(apiP('/query'), { body: { query: q } }); into.replaceChildren(renderResult(q, res)); }
  catch (e) { into.replaceChildren(h('p', { class: 'error' }, e instanceof Error ? e.message : String(e))); }
}
const kindName = (k: string) => ({ TrendsQuery: 'Trends', FunnelsQuery: 'Funnel', RetentionQuery: 'Retention' } as Record<string, string>)[k] ?? k;

// ---------- dashboards ----------
async function dashboardsPage() {
  shell('Dashboards', [], loading());
  const list = await api<any[]>(apiP('/dashboards'));
  const name = h('input', { placeholder: 'New dashboard name', 'aria-label': 'New dashboard name' }) as HTMLInputElement;
  const err = errBox(); const btn = h('button', { class: 'primary', type: 'submit' }, 'New dashboard') as HTMLButtonElement;
  const f = h('form', { class: 'row card' }, name, btn);
  f.addEventListener('submit', busy(btn, async () => { const d = await api(apiP('/dashboards'), { body: { name: name.value || 'New dashboard' } }); nav(P(`/dashboards/${d.id}`)); }, err));
  shell('Dashboards', [], f, err, list.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Insights'), h('th', {}, 'Updated'))),
    h('tbody', {}, list.map(d => h('tr', {}, h('td', {}, link(P(`/dashboards/${d.id}`), d.name), d.pinned ? h('span', { class: 'tag' }, 'pinned') : null), h('td', {}, d.tiles), h('td', { class: 'muted' }, ago(d.updated_at))))))
    : h('p', { class: 'muted empty' }, 'No dashboards yet. Create one, then add saved insights to it.'));
}
const RANGES: [string, string][] = [['-24h', 'Last 24 hours'], ['-7d', 'Last 7 days'], ['-14d', 'Last 14 days'], ['-30d', 'Last 30 days'], ['-90d', 'Last 90 days'], ['mStart', 'This month'], ['-12m', 'Last 12 months'], ['all', 'All time']];
function rangeSelect(value: string | null | undefined, onChange: (v: string) => void, withDefault = false) {
  return h('select', { 'aria-label': 'Date range', onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value) },
    withDefault ? h('option', { value: '', selected: !value }, 'Each insight\'s range') : null,
    RANGES.map(([v, l]) => h('option', { value: v, selected: value === v }, l)));
}
async function dashboardPage(id: number) {
  shell('Dashboard', [], loading());
  const d = await api<any>(apiP(`/dashboards/${id}`));
  const all = await api<any[]>(apiP('/insights'));
  const grid = h('div', { class: 'tiles' });
  const draw = () => {
    grid.replaceChildren(...(d.insights.length ? d.insights.map((ins: any) => {
      const body = h('div', { class: 'tile-body' });
      const q = { ...ins.query, dateRange: d.date_from ? { date_from: d.date_from } : ins.query.dateRange };
      runInsight(q, body);
      return h('section', { class: 'card tile' }, h('header', { class: 'tile-head' }, link(P(`/insights/${ins.short_id}`), ins.name), h('span', { class: 'tag' }, kindName(ins.query.kind)),
        h('button', { class: 'link', title: 'Remove from dashboard', 'aria-label': `Remove ${ins.name}`, onclick: async () => { await api(apiP(`/dashboards/${id}/tiles/${ins.id}`), { method: 'DELETE' }); d.insights = d.insights.filter((x: any) => x.id !== ins.id); draw(); } }, '✕')), body);
    }) : [h('p', { class: 'muted empty' }, 'This dashboard is empty. Add a saved insight below.')]));
  };
  draw();
  const add = h('select', { 'aria-label': 'Add insight' }, h('option', { value: '' }, 'Add a saved insight…'), all.filter(i => !d.insights.some((x: any) => x.id === i.id)).map(i => h('option', { value: i.id }, `${i.name} (${kindName(i.query.kind)})`))) as HTMLSelectElement;
  add.addEventListener('change', async () => { if (!add.value) return; await api(apiP(`/dashboards/${id}/tiles`), { body: { insight_id: Number(add.value) } }); dashboardPage(id); });
  const range = rangeSelect(d.date_from, async v => { await api(apiP(`/dashboards/${id}`), { method: 'PATCH', body: { date_from: v || null } }); d.date_from = v || null; draw(); }, true);
  shell(d.name, [range, add, link(P('/insights/new'), 'New insight', 'button'),
    h('button', { class: 'link danger', onclick: async () => { if (!confirm(`Delete dashboard “${d.name}”? Insights stay saved.`)) return; await api(apiP(`/dashboards/${id}`), { method: 'DELETE' }); nav(P('/dashboards')); } }, 'Delete')],
    d.description ? h('p', { class: 'muted' }, d.description) : null, grid);
}

// ---------- insights ----------
async function insightsPage() {
  shell('Insights', [], loading());
  const list = await api<any[]>(apiP('/insights'));
  shell('Insights', [link(P('/insights/new?kind=TrendsQuery'), 'New trend', 'button primary'), link(P('/insights/new?kind=FunnelsQuery'), 'New funnel', 'button'), link(P('/insights/new?kind=RetentionQuery'), 'New retention', 'button')],
    list.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Type'), h('th', {}, 'Created by'), h('th', {}, 'Updated'))),
      h('tbody', {}, list.map(i => h('tr', {}, h('td', {}, link(P(`/insights/${i.short_id}`), i.name)), h('td', {}, kindName(i.query.kind)), h('td', { class: 'muted' }, i.created_by), h('td', { class: 'muted' }, ago(i.updated_at))))))
      : h('p', { class: 'muted empty' }, 'No saved insights yet.'));
}
function defaultQuery(kind: string): any {
  if (kind === 'FunnelsQuery') return { kind, series: [{ kind: 'EventsNode', event: '$pageview' }, { kind: 'EventsNode', event: '$pageview' }], funnelsFilter: { funnelWindowInterval: 14, funnelWindowIntervalUnit: 'day', funnelOrderType: 'ordered' }, dateRange: { date_from: '-7d' }, properties: [] };
  if (kind === 'RetentionQuery') return { kind, retentionFilter: { targetEntity: { id: '$pageview', type: 'events' }, returningEntity: { id: '$pageview', type: 'events' }, period: 'Day', totalIntervals: 8, retentionType: 'retention_recurring' }, dateRange: { date_from: '-7d' }, properties: [] };
  return { kind: 'TrendsQuery', series: [{ kind: 'EventsNode', event: '$pageview', math: 'total' }], interval: 'day', dateRange: { date_from: '-7d' }, trendsFilter: { display: 'ActionsLineGraph' }, properties: [] };
}
const MATH: [string, string][] = [['total', 'Total count'], ['dau', 'Unique persons'], ['unique_session', 'Unique sessions'], ['sum', 'Sum of property'], ['avg', 'Average of property'], ['min', 'Minimum of property'], ['max', 'Maximum of property'], ['median', 'Median of property'], ['p90', '90th percentile of property']];
const opt = (v: string, l: string, cur: unknown) => h('option', { value: v, selected: cur === v }, l);
async function insightPage(shortId: string | null) {
  shell('Insight', [], loading());
  await ensureDefs();
  const params = new URLSearchParams(location.search);
  let saved: any = null;
  if (shortId) saved = await api(apiP(`/insights/${shortId}`));
  const q: any = saved ? structuredClone(saved.query) : defaultQuery(params.get('kind') ?? 'TrendsQuery');
  q.properties ??= [];
  const name = h('input', { value: saved?.name ?? '', placeholder: 'Untitled insight', 'aria-label': 'Insight name', class: 'title-input' }) as HTMLInputElement;
  const result = h('div', { class: 'result' });
  let timer = 0;
  const refresh = () => { clearTimeout(timer); timer = window.setTimeout(() => runInsight(q, result), 150); };
  const editor = h('div', { class: 'editor card' });
  const drawEditor = () => {
    const parts: Child[] = [];
    const seriesBox = (title: string, nodes: any[], withMath: boolean, min: number) => h('div', { class: 'series' }, h('h3', {}, title), nodes.map((n, i) => h('div', { class: 'serie' },
      h('span', { class: 'swatch num', style: `background:${color(q.kind === 'FunnelsQuery' ? 0 : i)}` }, String(i + 1)),
      eventInput(n.event ?? null, v => { n.event = v; refresh(); }, q.kind === 'TrendsQuery'),
      withMath ? h('select', { 'aria-label': 'Measure', onchange: (e: Event) => { n.math = (e.target as HTMLSelectElement).value; drawEditor(); refresh(); } }, MATH.map(([v, l]) => opt(v, l, n.math ?? 'total'))) : null,
      withMath && ['sum', 'avg', 'min', 'max', 'median', 'p90'].includes(n.math) ? h('input', { value: n.math_property ?? '', placeholder: 'numeric property', list: 'props-event', 'aria-label': 'Math property', onchange: (e: Event) => { n.math_property = (e.target as HTMLInputElement).value.trim(); refresh(); } }) : null,
      nodes.length > min ? h('button', { class: 'link', type: 'button', 'aria-label': 'Remove', onclick: () => { nodes.splice(i, 1); drawEditor(); refresh(); } }, '✕') : null)),
      h('button', { class: 'link', type: 'button', onclick: () => { nodes.push({ kind: 'EventsNode', event: '$pageview', math: withMath ? 'total' : undefined }); drawEditor(); refresh(); } }, q.kind === 'FunnelsQuery' ? '+ Add step' : '+ Add series'));
    if (q.kind === 'TrendsQuery') {
      parts.push(seriesBox('Series', q.series, true, 1));
      q.trendsFilter ??= {};
      parts.push(h('div', { class: 'row opts' },
        h('label', {}, 'Interval', h('select', { onchange: (e: Event) => { q.interval = (e.target as HTMLSelectElement).value; refresh(); } }, [['hour', 'Hour'], ['day', 'Day'], ['week', 'Week'], ['month', 'Month']].map(([v, l]) => opt(v, l, q.interval)))),
        h('label', {}, 'Chart', h('select', { onchange: (e: Event) => { q.trendsFilter.display = (e.target as HTMLSelectElement).value; refresh(); } }, [['ActionsLineGraph', 'Line'], ['ActionsBar', 'Bars'], ['BoldNumber', 'Number'], ['ActionsBarValue', 'Total value bars'], ['ActionsTable', 'Table']].map(([v, l]) => opt(v, l, q.trendsFilter.display ?? 'ActionsLineGraph')))),
        h('label', {}, 'Breakdown', h('input', { value: q.breakdownFilter?.breakdown ?? '', placeholder: 'e.g. $browser', list: 'props-event', onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value.trim(); q.breakdownFilter = v ? { breakdown: v, breakdown_type: (defs?.properties ?? []).some(p => p.kind === 'person' && p.name === v) && !(defs?.properties ?? []).some(p => p.kind === 'event' && p.name === v) ? 'person' : 'event' } : undefined; refresh(); } })),
        h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: !!q.compareFilter?.compare, onchange: (e: Event) => { q.compareFilter = { compare: (e.target as HTMLInputElement).checked }; refresh(); } }), 'Compare to previous period')));
    } else if (q.kind === 'FunnelsQuery') {
      parts.push(seriesBox('Steps', q.series, false, 2));
      const ff = q.funnelsFilter ??= {};
      parts.push(h('div', { class: 'row opts' },
        h('label', {}, 'Conversion window', h('div', { class: 'row' }, h('input', { type: 'number', min: 1, value: ff.funnelWindowInterval ?? 14, class: 'narrow', onchange: (e: Event) => { ff.funnelWindowInterval = Number((e.target as HTMLInputElement).value) || 14; refresh(); } }),
          h('select', { onchange: (e: Event) => { ff.funnelWindowIntervalUnit = (e.target as HTMLSelectElement).value; refresh(); } }, ['minute', 'hour', 'day', 'week', 'month'].map(u => opt(u, u + 's', ff.funnelWindowIntervalUnit ?? 'day'))))),
        h('label', {}, 'Step order', h('select', { onchange: (e: Event) => { ff.funnelOrderType = (e.target as HTMLSelectElement).value; refresh(); } }, opt('ordered', 'Sequential', ff.funnelOrderType ?? 'ordered'), opt('unordered', 'Any order', ff.funnelOrderType))),
        h('label', {}, 'Breakdown', h('input', { value: q.breakdownFilter?.breakdown ?? '', placeholder: 'e.g. $browser', list: 'props-event', onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value.trim(); q.breakdownFilter = v ? { breakdown: v, breakdown_type: 'event' } : undefined; refresh(); } }))));
    } else {
      const rf = q.retentionFilter;
      parts.push(h('div', { class: 'row opts' },
        h('label', {}, 'Persons who did', eventInput(rf.targetEntity.id, v => { rf.targetEntity = { id: v ?? '$pageview', type: 'events' }; refresh(); }, false)),
        h('label', {}, 'and came back to do', eventInput(rf.returningEntity.id, v => { rf.returningEntity = { id: v ?? '$pageview', type: 'events' }; refresh(); }, false)),
        h('label', {}, 'Period', h('select', { onchange: (e: Event) => { rf.period = (e.target as HTMLSelectElement).value; refresh(); } }, ['Day', 'Week', 'Month'].map(p => opt(p, p, rf.period)))),
        h('label', {}, 'Periods', h('input', { type: 'number', min: 2, max: 31, value: rf.totalIntervals ?? 8, class: 'narrow', onchange: (e: Event) => { rf.totalIntervals = Number((e.target as HTMLInputElement).value) || 8; refresh(); } })),
        h('label', {}, 'Cohort', h('select', { onchange: (e: Event) => { rf.retentionType = (e.target as HTMLSelectElement).value; refresh(); } }, opt('retention_recurring', 'Recurring', rf.retentionType ?? 'retention_recurring'), opt('retention_first_time', 'First time', rf.retentionType)))));
    }
    // Retention counts back totalIntervals periods from today, so it has no date range.
    if (q.kind !== 'RetentionQuery') parts.push(h('div', { class: 'row opts' }, h('label', {}, 'Date range', rangeSelect(q.dateRange?.date_from ?? '-7d', v => { q.dateRange = { date_from: v }; refresh(); }))));
    parts.push(h('div', {}, h('h3', {}, 'Filters'), filterEditor(q.properties, refresh)));
    editor.replaceChildren(eventList(), propOptions('event'), propOptions('person'), ...parts.filter(Boolean) as Node[]);
  };
  drawEditor();
  const err = errBox(); const save = h('button', { class: 'primary' }, saved ? 'Save' : 'Save insight') as HTMLButtonElement;
  save.addEventListener('click', busy(save, async () => {
    const body = { name: name.value.trim() || 'Untitled insight', query: q };
    if (saved) { saved = await api(apiP(`/insights/${saved.short_id}`), { method: 'PATCH', body }); save.textContent = 'Saved'; setTimeout(() => (save.textContent = 'Save'), 1200); }
    else { saved = await api(apiP('/insights'), { body }); history.replaceState({}, '', P(`/insights/${saved.short_id}`)); insightPage(saved.short_id); }
  }, err));
  const actions: Child[] = [save];
  if (saved) {
    const dashes = await api<any[]>(apiP('/dashboards'));
    const add = h('select', { 'aria-label': 'Add to dashboard' }, h('option', { value: '' }, 'Add to dashboard…'), dashes.map(d => h('option', { value: d.id }, d.name))) as HTMLSelectElement;
    add.addEventListener('change', async () => { if (!add.value) return; await api(apiP(`/dashboards/${add.value}/tiles`), { body: { insight_id: saved.id } }); nav(P(`/dashboards/${add.value}`)); });
    actions.unshift(add);
    actions.push(h('button', { class: 'link danger', onclick: async () => { if (!confirm('Delete this insight?')) return; await api(apiP(`/insights/${saved.short_id}`), { method: 'DELETE' }); nav(P('/insights')); } }, 'Delete'));
  }
  shell(h('span', { class: 'row' }, h('span', { class: 'tag big-tag' }, kindName(q.kind)), name), actions, err, h('div', { class: 'insight' }, editor, h('div', { class: 'card' }, result)));
  runInsight(q, result);
}

// ---------- events ----------
function propTable(props: Record<string, unknown>) {
  const keys = Object.keys(props).sort((a, b) => (a.startsWith('$') ? 1 : 0) - (b.startsWith('$') ? 1 : 0) || a.localeCompare(b));
  return h('table', { class: 'props' }, h('tbody', {}, keys.map(k => h('tr', {}, h('th', {}, k), h('td', {}, typeof props[k] === 'object' && props[k] !== null ? JSON.stringify(props[k]) : String(props[k]))))));
}
async function eventsPage() {
  shell('Events', [], loading());
  await ensureDefs();
  const params = new URLSearchParams(location.search);
  const filters: PF[] = []; let event: string | null = params.get('event');
  const table = h('div', {}); let cursor: string | null = null;
  const more = h('button', {}, 'Load more') as HTMLButtonElement;
  const tbody = h('tbody', {});
  const load = async (reset: boolean) => {
    if (reset) { cursor = null; tbody.replaceChildren(); }
    const u = new URLSearchParams({ limit: '100' }); if (event) u.set('event', event); if (cursor) u.set('cursor', cursor);
    const valid = filters.filter(f => f.key); if (valid.length) u.set('properties', JSON.stringify(valid));
    const r = await api<any>(apiP(`/events?${u}`));
    for (const e of r.results) {
      const detail = h('tr', { class: 'detail', hidden: true }, h('td', { colspan: 4 }, propTable(e.properties)));
      tbody.append(h('tr', { class: 'clickable', onclick: () => { detail.hidden = !detail.hidden; } },
        h('td', {}, h('b', {}, eventLabel(e.event)), e.event === '$autocapture' && e.properties.$el_text ? h('span', { class: 'muted' }, ` “${String(e.properties.$el_text).slice(0, 40)}”`) : null),
        h('td', {}, e.person ? link(P(`/persons/${e.person.id}`), e.person.name) : h('span', { class: 'muted' }, e.distinct_id)),
        h('td', { class: 'muted url' }, String(e.properties.$current_url ?? e.properties.$lib ?? '')),
        h('td', { class: 'muted nowrap' }, when(e.timestamp))), detail);
    }
    cursor = r.next; more.hidden = !r.hasMore;
    if (!tbody.children.length) tbody.append(h('tr', {}, h('td', { colspan: 4, class: 'muted empty' }, 'No events yet. Add the snippet from Settings to your site.')));
  };
  more.addEventListener('click', () => load(false));
  table.append(h('table', { class: 'events' }, h('thead', {}, h('tr', {}, h('th', {}, 'Event'), h('th', {}, 'Person'), h('th', {}, 'URL / library'), h('th', {}, 'Time'))), tbody), more);
  shell('Events', [h('button', { onclick: () => load(true) }, 'Reload')], eventList(), propOptions('event'), propOptions('person'),
    h('div', { class: 'card' }, h('div', { class: 'row' }, h('label', { class: 'inline' }, 'Event ', eventInput(event, v => { event = v; load(true); }))), filterEditor(filters, () => load(true))), table);
  await load(true);
}

// ---------- persons ----------
async function personsPage() {
  shell('Persons', [], loading());
  const q = h('input', { type: 'search', placeholder: 'Search by email, name or distinct ID', 'aria-label': 'Search persons' }) as HTMLInputElement;
  const out = h('div', {});
  const load = async () => {
    const r = await api<any>(apiP(`/persons?search=${encodeURIComponent(q.value)}`));
    out.replaceChildren(h('p', { class: 'muted small' }, `${fmt(r.total)} ${r.total === 1 ? 'person' : 'persons'}`), r.results.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Person'), h('th', {}, 'Distinct IDs'), h('th', {}, 'First seen'), h('th', {}, 'Last seen'))),
      h('tbody', {}, r.results.map((p: any) => h('tr', {}, h('td', {}, link(P(`/persons/${p.id}`), p.name), p.is_identified ? null : h('span', { class: 'tag' }, 'anonymous')), h('td', { class: 'muted' }, p.distinct_ids.slice(0, 2).join(', ') + (p.distinct_ids.length > 2 ? ` +${p.distinct_ids.length - 2}` : '')), h('td', { class: 'muted nowrap' }, when(p.created_at)), h('td', { class: 'muted nowrap' }, ago(p.last_seen_at))))))
      : h('p', { class: 'muted empty' }, 'No persons found. Persons are created when your app calls identify() or sets person properties.'));
  };
  let t = 0; q.addEventListener('input', () => { clearTimeout(t); t = window.setTimeout(load, 250); });
  shell('Persons', [], h('div', { class: 'row card' }, q), out);
  await load();
}
async function personPage(id: string) {
  shell('Person', [], loading());
  const p = await api<any>(apiP(`/persons/${encodeURIComponent(id)}`));
  const ev = await api<any>(apiP(`/events?person_id=${encodeURIComponent(p.id)}&limit=50`));
  shell(p.name, [h('button', { class: 'link danger', onclick: async () => {
    const withEvents = confirm(`Delete ${p.name}? Press OK to also delete their events, or Cancel to keep everything.`);
    if (!withEvents) return; await api(apiP(`/persons/${encodeURIComponent(p.id)}?delete_events=1`), { method: 'DELETE' }); nav(P('/persons'));
  } }, 'Delete person and events')],
    h('div', { class: 'cols' },
      h('section', { class: 'card' }, h('h2', {}, 'Properties'), Object.keys(p.properties).length ? propTable(p.properties) : h('p', { class: 'muted' }, 'No properties.')),
      h('section', {}, h('div', { class: 'card' }, h('h2', {}, 'Details'), h('dl', { class: 'facts' }, h('dt', {}, 'Distinct IDs'), h('dd', {}, p.distinct_ids.join(', ')), h('dt', {}, 'First seen'), h('dd', {}, when(p.created_at)), h('dt', {}, 'Last seen'), h('dd', {}, when(p.last_seen_at)), h('dt', {}, 'Identified'), h('dd', {}, p.is_identified ? 'Yes' : 'No'))),
        h('div', { class: 'card' }, h('h2', {}, 'Recent events'), ev.results.length ? h('ul', { class: 'timeline' }, ev.results.map((e: any) => h('li', {}, h('b', {}, eventLabel(e.event)), h('span', { class: 'muted small' }, ` ${when(e.timestamp)}`), e.properties.$pathname ? h('div', { class: 'muted small' }, e.properties.$pathname) : null))) : h('p', { class: 'muted' }, 'No events.')))));
}

// ---------- feature flags ----------
async function flagsPage() {
  shell('Feature flags', [], loading());
  const list = await api<any[]>(apiP('/feature_flags'));
  const summary = (f: any) => { const g = f.filters.groups ?? []; const mv = f.filters.multivariate ? ` · ${f.filters.multivariate.variants.length} variants` : ''; return g.length === 1 && !(g[0].properties ?? []).length ? `${g[0].rollout_percentage ?? 100}% of users${mv}` : `${g.length} condition set${g.length === 1 ? '' : 's'}${mv}`; };
  shell('Feature flags', [link(P('/feature_flags/new'), 'New flag', 'button primary')],
    list.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Key'), h('th', {}, 'Release'), h('th', {}, 'Status'))),
      h('tbody', {}, list.map(f => h('tr', {}, h('td', {}, link(P(`/feature_flags/${f.id}`), f.key), f.name ? h('div', { class: 'muted small' }, f.name) : null), h('td', { class: 'muted' }, summary(f)),
        h('td', {}, h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: f.active, 'aria-label': `Enable ${f.key}`, onchange: async (e: Event) => { await api(apiP(`/feature_flags/${f.id}`), { method: 'PATCH', body: { active: (e.target as HTMLInputElement).checked } }); } }), f.active ? 'On' : 'Off'))))))
      : h('p', { class: 'muted empty' }, 'No feature flags yet. Flags you create here are returned to posthog-js by /flags.'));
}
async function flagPage(id: number | null) {
  shell('Feature flag', [], loading());
  await ensureDefs();
  const f: any = id ? await api(apiP(`/feature_flags/${id}`)) : { key: '', name: '', active: true, filters: { groups: [{ properties: [], rollout_percentage: 100 }] } };
  const filters = f.filters; filters.groups ??= [];
  const key = h('input', { value: f.key, required: true, pattern: '[A-Za-z0-9_\\-]+', placeholder: 'new-checkout' }) as HTMLInputElement;
  const name = h('input', { value: f.name, placeholder: 'What it controls' }) as HTMLInputElement;
  const active = h('input', { type: 'checkbox', checked: f.active }) as HTMLInputElement;
  const groupsBox = h('div', {}); const variantsBox = h('div', {});
  const drawGroups = () => groupsBox.replaceChildren(...filters.groups.map((g: any, i: number) => {
    g.properties ??= [];
    return h('div', { class: 'card inner' }, h('div', { class: 'row' }, h('b', {}, `Condition set ${i + 1}`), h('button', { class: 'link', type: 'button', onclick: () => { filters.groups.splice(i, 1); drawGroups(); } }, 'Remove')),
      h('p', { class: 'muted small' }, 'Match persons where all of these are true (no filters matches everyone):'),
      filterEditor(g.properties.map((p: PF) => { p.type ??= 'person'; return p; }) && g.properties, () => {}),
      h('label', {}, 'Roll out to ', h('div', { class: 'row' }, h('input', { type: 'number', min: 0, max: 100, value: g.rollout_percentage ?? 100, class: 'narrow', onchange: (e: Event) => { g.rollout_percentage = Number((e.target as HTMLInputElement).value); } }), h('span', {}, '% of matching persons'))));
  }), h('button', { type: 'button', onclick: () => { filters.groups.push({ properties: [], rollout_percentage: 100 }); drawGroups(); } }, '+ Add condition set'));
  const drawVariants = () => {
    const mv = filters.multivariate;
    variantsBox.replaceChildren(h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: !!mv, onchange: (e: Event) => { filters.multivariate = (e.target as HTMLInputElement).checked ? { variants: [{ key: 'control', rollout_percentage: 50 }, { key: 'test', rollout_percentage: 50 }] } : null; drawVariants(); } }), 'Multiple variants'),
      mv ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Variant key'), h('th', {}, 'Rollout %'), h('th', {}, 'Payload (JSON)'), h('th', {}))), h('tbody', {}, mv.variants.map((v: any, i: number) => h('tr', {},
        h('td', {}, h('input', { value: v.key, 'aria-label': 'Variant key', onchange: (e: Event) => { const old = v.key; v.key = (e.target as HTMLInputElement).value.trim(); if (filters.payloads?.[old] !== undefined) { filters.payloads[v.key] = filters.payloads[old]; delete filters.payloads[old]; } } })),
        h('td', {}, h('input', { type: 'number', min: 0, max: 100, value: v.rollout_percentage, class: 'narrow', 'aria-label': 'Variant rollout', onchange: (e: Event) => { v.rollout_percentage = Number((e.target as HTMLInputElement).value); } })),
        h('td', {}, h('input', { value: filters.payloads?.[v.key] ?? '', placeholder: '{"color":"green"}', 'aria-label': 'Variant payload', onchange: (e: Event) => { filters.payloads ??= {}; const val = (e.target as HTMLInputElement).value.trim(); if (val) filters.payloads[v.key] = val; else delete filters.payloads[v.key]; } })),
        h('td', {}, mv.variants.length > 2 ? h('button', { class: 'link', type: 'button', onclick: () => { mv.variants.splice(i, 1); drawVariants(); } }, '✕') : null))),
        h('tr', {}, h('td', { colspan: 4 }, h('button', { class: 'link', type: 'button', onclick: () => { mv.variants.push({ key: `variant-${mv.variants.length + 1}`, rollout_percentage: 0 }); drawVariants(); } }, '+ Add variant')))))
        : h('label', {}, 'Payload when enabled (JSON, optional)', h('input', { value: filters.payloads?.true ?? '', placeholder: '{"limit":10}', onchange: (e: Event) => { filters.payloads ??= {}; const val = (e.target as HTMLInputElement).value.trim(); if (val) filters.payloads.true = val; else delete filters.payloads.true; } })));
  };
  drawGroups(); drawVariants();
  const err = errBox(); const btn = h('button', { class: 'primary', type: 'submit' }, id ? 'Save flag' : 'Create flag') as HTMLButtonElement;
  const form = h('form', {}, propOptions('person'),
    h('div', { class: 'card' }, h('label', {}, 'Key', key, h('span', { class: 'muted small' }, 'Your code calls posthog.isFeatureEnabled(key).')), h('label', {}, 'Description', name), h('label', { class: 'switch' }, active, 'Enabled')),
    h('div', { class: 'card' }, h('h2', {}, 'Release conditions'), groupsBox),
    h('div', { class: 'card' }, h('h2', {}, 'Variants and payloads'), variantsBox), err, btn);
  form.addEventListener('submit', busy(btn, async () => {
    for (const g of filters.groups) g.properties = (g.properties ?? []).filter((p: PF) => p.key);
    const body = { key: key.value.trim(), name: name.value.trim(), active: active.checked, filters };
    if (id) await api(apiP(`/feature_flags/${id}`), { method: 'PATCH', body }); else await api(apiP('/feature_flags'), { body });
    nav(P('/feature_flags'));
  }, err));
  shell(id ? f.key : 'New feature flag', id ? [h('button', { class: 'link danger', onclick: async () => { if (!confirm(`Delete flag ${f.key}?`)) return; await api(apiP(`/feature_flags/${id}`), { method: 'DELETE' }); nav(P('/feature_flags')); } }, 'Delete')] : [], form);
}

// ---------- settings ----------
async function settingsPage() {
  const p = project();
  const stats = await api<any>(apiP('/stats')).catch(() => null);
  const snippet = `<script>
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures getActiveMatchingSurveys getSurveys onSessionId".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
  posthog.init('${p.api_token}', { api_host: '${location.origin}', person_profiles: 'identified_only' })
</script>`;
  const copy = (text: string) => h('button', { type: 'button', onclick: (e: Event) => { navigator.clipboard?.writeText(text); (e.target as HTMLElement).textContent = 'Copied'; } }, 'Copy');
  const name = h('input', { value: p.name }) as HTMLInputElement;
  const tz = h('input', { value: p.timezone }) as HTMLInputElement;
  const ret = h('input', { type: 'number', min: 0, value: p.retention_days, class: 'narrow' }) as HTMLInputElement;
  const anon = h('input', { type: 'checkbox', checked: p.anonymize_ips }) as HTMLInputElement;
  const ac = h('input', { type: 'checkbox', checked: p.autocapture_opt_out }) as HTMLInputElement;
  const err = errBox(); const btn = h('button', { class: 'primary', type: 'submit' }, 'Save settings') as HTMLButtonElement;
  const form = h('form', { class: 'card' }, h('h2', {}, 'Project'), h('label', {}, 'Name', name), h('label', {}, 'Time zone', tz),
    h('label', {}, 'Keep events for (days, 0 = forever)', ret), h('label', { class: 'switch' }, anon, 'Discard client IP addresses'), h('label', { class: 'switch' }, ac, 'Turn off autocapture for all clients'), err, btn);
  form.addEventListener('submit', busy(btn, async () => {
    const r = await api<Project>(apiP(''), { method: 'PATCH', body: { name: name.value, timezone: tz.value, retention_days: Number(ret.value), anonymize_ips: anon.checked, autocapture_opt_out: ac.checked } });
    projects = projects.map(x => x.id === r.id ? r : x); btn.textContent = 'Saved'; setTimeout(() => settingsPage(), 800);
  }, err));
  shell('Settings', [],
    h('section', { class: 'card' }, h('h2', {}, 'Install the snippet'), h('p', { class: 'muted small' }, 'Paste this in the <head> of every page. Any posthog-js or posthog-node SDK works: point api_host at this instance.'),
      h('pre', { class: 'code' }, snippet), copy(snippet),
      h('h3', {}, 'Project API key'), h('div', { class: 'row' }, h('code', { class: 'token' }, p.api_token), copy(p.api_token)),
      h('p', { class: 'muted small' }, 'This key is public: it can only send events and read flags.'),
      stats ? h('p', { class: 'small' }, h('b', {}, fmt(stats.events)), ' events · ', h('b', {}, fmt(stats.persons)), ' persons · last event ', ago(stats.last_event_at), ` · ${(stats.database_bytes / 1048576).toFixed(1)} MB stored`) : null),
    form,
    h('section', { class: 'card' }, h('h2', {}, 'Other projects'), h('ul', {}, projects.map(x => h('li', {}, link(`/project/${x.id}/settings`, x.name)))), newProjectForm(np => nav(`/project/${np.id}/settings`))),
    h('section', { class: 'card danger-zone' }, h('h2', {}, 'Danger zone'),
      h('div', { class: 'row' }, h('button', { onclick: async () => { if (!confirm('Reset the project API key? Sites using the old key stop sending events.')) return; const r = await api<Project>(apiP('/reset_token'), { body: {} }); projects = projects.map(x => x.id === r.id ? r : x); settingsPage(); } }, 'Reset project API key'),
        h('button', { class: 'danger', onclick: async () => { if (prompt(`Type the project name (${p.name}) to delete it and all its data.`) !== p.name) return; await api(apiP(''), { method: 'DELETE' }); projects = projects.filter(x => x.id !== p.id); nav('/'); } }, 'Delete project'))));
}

// ---------- account ----------
async function accountPage() {
  const keys = await api<any[]>('/api/personal_api_keys');
  const label = h('input', { placeholder: 'Label, e.g. reporting script', 'aria-label': 'Key label' }) as HTMLInputElement;
  const shown = h('div', {}); const err = errBox(); const btn = h('button', { class: 'primary', type: 'submit' }, 'Create key') as HTMLButtonElement;
  const f = h('form', { class: 'row' }, label, btn);
  f.addEventListener('submit', busy(btn, async () => { const r = await api<{ key: string }>('/api/personal_api_keys', { body: { label: label.value } }); shown.replaceChildren(h('div', { class: 'card ok' }, h('p', {}, 'Copy this key now. It is not shown again.'), h('code', { class: 'token' }, r.key))); label.value = ''; }, err));
  root.replaceChildren(h('div', { class: 'layout' }, h('nav', { class: 'side' }, h('div', { class: 'brand' }, APP), h('div', { class: 'side-links' }, projects.map(p => link(`/project/${p.id}/dashboards`, p.name)), link('/account', 'Account', 'active'))),
    h('main', {}, h('header', { class: 'top' }, h('h1', {}, 'Account'), h('div', { class: 'row' }, h('button', { onclick: async () => { await api('/api/logout', { body: {} }); me = null; nav('/login'); } }, 'Sign out'))),
      h('section', { class: 'card' }, h('p', {}, 'Signed in as ', h('b', {}, me!.email))),
      h('section', { class: 'card' }, h('h2', {}, 'Personal API keys'), h('p', { class: 'muted small' }, 'Use a personal key as a Bearer token to call /api from scripts. It acts as you.'), f, err, shown,
        keys.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Label'), h('th', {}, 'Key'), h('th', {}, 'Last used'), h('th', {}))), h('tbody', {}, keys.map(k => h('tr', {}, h('td', {}, k.label || '–'), h('td', {}, h('code', {}, k.mask)), h('td', { class: 'muted' }, ago(k.last_used_at)),
          h('td', {}, h('button', { class: 'link danger', onclick: async () => { if (!confirm('Revoke this key?')) return; await api(`/api/personal_api_keys/${k.id}`, { method: 'DELETE' }); accountPage(); } }, 'Revoke')))))) : null))));
}

// ---------- router ----------
async function render() {
  const path = location.pathname;
  try {
    if (path === '/login') return await authPage('login');
    if (path === '/signup') return await authPage('signup');
    if (!me) {
      try { me = await api('/api/me'); } catch (e) { if (e instanceof ApiError && e.status === 401) return nav('/login'); throw e; }
      projects = await api('/api/projects');
    }
    if (path === '/account') return await accountPage();
    if (!projects.length) return onboarding();
    const m = /^\/project\/(\d+)(\/.*)?$/.exec(path);
    if (!m || !projects.some(p => p.id === +m[1])) return nav(`/project/${projects[0].id}/dashboards`);
    pid = +m[1]; const sub = m[2] ?? '';
    let r: RegExpExecArray | null;
    if (sub === '' || sub === '/') return nav(P('/dashboards'));
    if (sub === '/dashboards') return await dashboardsPage();
    if ((r = /^\/dashboards\/(\d+)$/.exec(sub))) return await dashboardPage(+r[1]);
    if (sub === '/insights') return await insightsPage();
    if (sub === '/insights/new') return await insightPage(null);
    if ((r = /^\/insights\/([\w-]+)$/.exec(sub))) return await insightPage(r[1]);
    if (sub === '/events') return await eventsPage();
    if (sub === '/persons') return await personsPage();
    if ((r = /^\/persons\/([^/]+)$/.exec(sub))) return await personPage(decodeURIComponent(r[1]));
    if (sub === '/feature_flags') return await flagsPage();
    if (sub === '/feature_flags/new') return await flagPage(null);
    if ((r = /^\/feature_flags\/(\d+)$/.exec(sub))) return await flagPage(+r[1]);
    if (sub === '/settings') return await settingsPage();
    shell('Not found', [], h('p', {}, 'Nothing here. ', link(P('/dashboards'), 'Go to dashboards')));
  } catch (e) {
    root.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'auth card' }, h('p', { class: 'error' }, e instanceof Error ? e.message : String(e)), link('/', 'Reload'))));
  }
}
window.addEventListener('popstate', render);
render();
