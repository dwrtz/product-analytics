// The owner web app (spec R13). No framework: small DOM helpers, history routing and SVG charts.
import settings from '../../spekkr.inputs.json';

const APP = settings.app_name;
type Project = { id: number; name: string; api_token: string; timezone: string; retention_days: number; anonymize_ips: boolean; autocapture_opt_out: boolean; session_recording: boolean; replay_config: any; heatmaps: boolean; created_at: string };
type Me = { id: number; email: string; name: string };
let me: Me | null = null;
let projects: Project[] = [];
let defs: { events: { name: string }[]; properties: { kind: string; name: string; type: string }[]; group_types: { idx: number; name: string }[] } | null = null;
let defsFor = 0;
let actionsList: { id: number; name: string; steps: any[] }[] = [];
let cohortsList: { id: number; name: string; is_static: boolean; count: number | null }[] = [];

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
        item('/dashboards', 'Dashboards'), item('/insights', 'Insights'), item('/sql', 'SQL'), item('/events', 'Events'), item('/actions', 'Actions'), item('/persons', 'Persons'), item('/cohorts', 'Cohorts'),
        item('/replay', 'Session replay'), item('/heatmaps', 'Heatmaps'), item('/feature_flags', 'Feature flags'), item('/experiments', 'Experiments'), item('/surveys', 'Surveys'), item('/settings', 'Settings'),
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
type PF = { key: string; value?: unknown; operator?: string; type?: 'event' | 'person' | 'cohort' };
const OPS: [string, string][] = [['exact', '='], ['is_not', '≠'], ['icontains', 'contains'], ['not_icontains', "doesn't contain"], ['gt', '>'], ['lt', '<'], ['is_set', 'is set'], ['is_not_set', 'is not set']];
function propOptions(kind: 'event' | 'person') {
  const names = (defs?.properties ?? []).filter(p => p.kind === kind).map(p => p.name);
  return h('datalist', { id: `props-${kind}` }, names.map(n => h('option', { value: n })));
}
function filterEditor(list: PF[], onChange: () => void, kinds: ('event' | 'person' | 'cohort')[] = ['event', 'person', 'cohort'], fixed = false): HTMLElement {
  const box = h('div', { class: 'filters' });
  const draw = () => {
    box.replaceChildren(...list.map((f, i) => {
      const type = h('select', { 'aria-label': 'Property type', onchange: (e: Event) => {
        const t = (e.target as HTMLSelectElement).value as any; f.type = t;
        if (t === 'cohort') { f.key = 'id'; f.operator = 'in'; f.value = cohortsList[0]?.id; } else if (f.key === 'id') { f.key = ''; f.operator = 'exact'; f.value = []; }
        draw(); onChange(); } },
        kinds.map(k => h('option', { value: k, selected: (f.type ?? 'event') === k }, k === 'event' ? 'Event' : k === 'person' ? 'Person' : 'Cohort')));
      if (f.type === 'cohort') return h('div', { class: 'filter' }, type,
        h('select', { 'aria-label': 'Cohort membership', onchange: (e: Event) => { f.operator = (e.target as HTMLSelectElement).value; onChange(); } }, opt('in', 'in', f.operator ?? 'in'), opt('not_in', 'not in', f.operator)),
        h('select', { 'aria-label': 'Cohort', onchange: (e: Event) => { f.value = Number((e.target as HTMLSelectElement).value); onChange(); } }, cohortsList.length ? cohortsList.map(c => h('option', { value: c.id, selected: Number(f.value) === c.id }, c.name)) : h('option', { value: '' }, 'No cohorts yet')),
        h('button', { class: 'link', type: 'button', 'aria-label': 'Remove filter', onclick: () => { list.splice(i, 1); draw(); onChange(); } }, '✕'));
      const key = h('input', { value: f.key, placeholder: 'property', list: `props-${f.type === 'person' ? 'person' : 'event'}`, 'aria-label': 'Property', onchange: (e: Event) => { f.key = (e.target as HTMLInputElement).value.trim(); onChange(); } });
      const op = h('select', { 'aria-label': 'Operator', onchange: (e: Event) => { f.operator = (e.target as HTMLSelectElement).value; draw(); onChange(); } }, OPS.map(([v, l]) => h('option', { value: v, selected: (f.operator ?? 'exact') === v }, l)));
      const needsValue = !['is_set', 'is_not_set'].includes(f.operator ?? 'exact');
      const val = needsValue ? h('input', { value: Array.isArray(f.value) ? f.value.join(', ') : (f.value ?? ''), placeholder: 'value', 'aria-label': 'Value', onchange: (e: Event) => {
        const v = (e.target as HTMLInputElement).value; f.value = ['exact', 'is_not'].includes(f.operator ?? 'exact') ? v.split(',').map(x => x.trim()).filter(Boolean) : v; onChange();
      } }) : null;
      return h('div', { class: 'filter' }, fixed ? null : type, key, op, val, fixed ? null : h('button', { class: 'link', type: 'button', 'aria-label': 'Remove filter', onclick: () => { list.splice(i, 1); draw(); onChange(); } }, '✕'));
    }), fixed ? '' : h('button', { class: 'link', type: 'button', onclick: () => { list.push({ key: '', operator: 'exact', type: kinds[0], value: [] }); draw(); } }, '+ Add filter'));
  };
  draw(); return box;
}
async function ensureDefs(force = false) {
  if (defs && defsFor === pid && !force) return;
  [defs, actionsList, cohortsList] = await Promise.all([api(P('/definitions').replace('/project/', '/api/projects/')), api<any[]>(`/api/projects/${pid}/actions`), api<any[]>(`/api/projects/${pid}/cohorts`)]); defsFor = pid;
}
/** Series/step picker: an event or a saved action (ActionsNode). */
function nodePicker(n: any, onChange: () => void, allowAll: boolean): HTMLElement {
  const wrap = h('span', { class: 'row node-picker' });
  const draw = () => {
    const isAction = n.kind === 'ActionsNode';
    const kind = h('select', { 'aria-label': 'Event or action', onchange: (e: Event) => {
      if ((e.target as HTMLSelectElement).value === 'action') { n.kind = 'ActionsNode'; n.id = actionsList[0]?.id; delete n.event; } else { n.kind = 'EventsNode'; delete n.id; n.event = allowAll ? null : '$pageview'; }
      draw(); onChange(); } }, opt('event', 'Event', isAction ? '' : 'event'), opt('action', 'Action', isAction ? 'action' : ''));
    const pick = isAction ? h('select', { 'aria-label': 'Action', onchange: (e: Event) => { n.id = Number((e.target as HTMLSelectElement).value); onChange(); } },
      actionsList.length ? actionsList.map(a => h('option', { value: a.id, selected: n.id === a.id }, a.name)) : h('option', { value: '' }, 'No actions yet'))
      : eventInput(n.event ?? null, v => { n.event = v; onChange(); }, allowAll);
    wrap.replaceChildren(kind, pick);
  };
  draw(); return wrap;
}
const apiP = (p: string) => `/api/projects/${pid}${p}`;
function eventInput(value: string | null, onChange: (v: string | null) => void, allowAll = true) {
  const i = h('input', { value: value ?? (allowAll ? '' : '$pageview'), list: 'event-names', placeholder: allowAll ? 'All events' : 'event name', 'aria-label': 'Event', onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value.trim(); onChange(v ? v : allowAll ? null : '$pageview'); } });
  return i;
}
const eventList = () => h('datalist', { id: 'event-names' }, (defs?.events ?? []).map(e => h('option', { value: e.name }, eventLabel(e.name))));

// ---------- charts ----------
type Series = { action?: { id: string | number | null; type?: string; name?: string; custom_name: string | null; math: string; math_property?: string }; breakdown_label?: string; label: string; data: number[]; labels: string[]; count: number; aggregated_value?: number; breakdown_value?: unknown; compare_label?: string };
const MATH_SUFFIX: Record<string, string> = { dau: 'unique persons', unique_session: 'unique sessions', unique_group: 'unique groups', sum: 'sum', avg: 'average', min: 'min', max: 'max', median: 'median', p75: 'p75', p90: 'p90', p95: 'p95', p99: 'p99' };
function seriesName(sr: Series) {
  if (!sr.action) return sr.label;
  const base = sr.action.custom_name || (sr.action.type === 'actions' ? sr.action.name ?? 'Action' : eventLabel(sr.action.id as string | null));
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
      nodePicker(n, refresh, q.kind === 'TrendsQuery'),
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
        h('td', { class: 'muted url' }, project().session_recording && e.properties.$session_id ? h('a', { href: P(`/replay/${encodeURIComponent(e.properties.$session_id)}`), class: 'replay-link', title: 'Watch this session', onclick: (ev: MouseEvent) => { ev.stopPropagation(); ev.preventDefault(); nav(P(`/replay/${encodeURIComponent(e.properties.$session_id)}`)); } }, '▶') : null, String(e.properties.$current_url ?? e.properties.$lib ?? '')),
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
  const recs = await api<any>(apiP(`/session_recordings?person_id=${encodeURIComponent(p.id)}&limit=20`)).catch(() => ({ results: [] }));
  shell(p.name, [h('button', { class: 'link danger', onclick: async () => {
    const withEvents = confirm(`Delete ${p.name}? Press OK to also delete their events, or Cancel to keep everything.`);
    if (!withEvents) return; await api(apiP(`/persons/${encodeURIComponent(p.id)}?delete_events=1`), { method: 'DELETE' }); nav(P('/persons'));
  } }, 'Delete person and events')],
    h('div', { class: 'cols' },
      h('section', { class: 'card' }, h('h2', {}, 'Properties'), Object.keys(p.properties).length ? propTable(p.properties) : h('p', { class: 'muted' }, 'No properties.')),
      h('section', {}, h('div', { class: 'card' }, h('h2', {}, 'Details'), h('dl', { class: 'facts' }, h('dt', {}, 'Distinct IDs'), h('dd', {}, p.distinct_ids.join(', ')), h('dt', {}, 'First seen'), h('dd', {}, when(p.created_at)), h('dt', {}, 'Last seen'), h('dd', {}, when(p.last_seen_at)), h('dt', {}, 'Identified'), h('dd', {}, p.is_identified ? 'Yes' : 'No'))),
        recs.results.length ? h('div', { class: 'card' }, h('h2', {}, 'Recordings'), recordingsTable(recs.results, false)) : null,
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
  const cont = h('input', { type: 'checkbox', checked: !!f.ensure_experience_continuity }) as HTMLInputElement;
  const groupsBox = h('div', {}); const variantsBox = h('div', {});
  const drawGroups = () => groupsBox.replaceChildren(...filters.groups.map((g: any, i: number) => {
    g.properties ??= [];
    return h('div', { class: 'card inner' }, h('div', { class: 'row' }, h('b', {}, `Condition set ${i + 1}`), h('button', { class: 'link', type: 'button', onclick: () => { filters.groups.splice(i, 1); drawGroups(); } }, 'Remove')),
      h('p', { class: 'muted small' }, 'Match persons where all of these are true (no filters matches everyone):'),
      filterEditor(g.properties.map((p: PF) => { p.type ??= 'person'; return p; }) && g.properties, () => {}, ['person', 'cohort']),
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
    h('div', { class: 'card' }, h('label', {}, 'Key', key, h('span', { class: 'muted small' }, 'Your code calls posthog.isFeatureEnabled(key).')), h('label', {}, 'Description', name), h('label', { class: 'switch' }, active, 'Enabled'),
      h('label', { class: 'switch' }, cont, 'Persist the flag value across authentication steps (experience continuity)')),
    h('div', { class: 'card' }, h('h2', {}, 'Release conditions'), groupsBox),
    h('div', { class: 'card' }, h('h2', {}, 'Variants and payloads'), variantsBox), err, btn);
  form.addEventListener('submit', busy(btn, async () => {
    for (const g of filters.groups) g.properties = (g.properties ?? []).filter((p: PF) => p.key);
    const body = { key: key.value.trim(), name: name.value.trim(), active: active.checked, ensure_experience_continuity: cont.checked, filters };
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
  const rec = h('input', { type: 'checkbox', checked: p.session_recording }) as HTMLInputElement;
  const hm = h('input', { type: 'checkbox', checked: p.heatmaps }) as HTMLInputElement;
  const err = errBox(); const btn = h('button', { class: 'primary', type: 'submit' }, 'Save settings') as HTMLButtonElement;
  const form = h('form', { class: 'card' }, h('h2', {}, 'Project'), h('label', {}, 'Name', name), h('label', {}, 'Time zone', tz),
    h('label', {}, 'Keep events for (days, 0 = forever)', ret), h('label', { class: 'switch' }, anon, 'Discard client IP addresses'), h('label', { class: 'switch' }, ac, 'Turn off autocapture for all clients'),
    h('label', { class: 'switch' }, rec, 'Record sessions (session replay; inputs are masked by posthog-js)'),
    h('label', { class: 'switch' }, hm, 'Collect heatmaps (clicks, rage clicks, dead clicks, mouse moves and scroll depth)'), err, btn);
  form.addEventListener('submit', busy(btn, async () => {
    const r = await api<Project>(apiP(''), { method: 'PATCH', body: { name: name.value, timezone: tz.value, retention_days: Number(ret.value), anonymize_ips: anon.checked, autocapture_opt_out: ac.checked, session_recording: rec.checked, heatmaps: hm.checked } });
    projects = projects.map(x => x.id === r.id ? r : x); btn.textContent = 'Saved'; setTimeout(() => settingsPage(), 800);
  }, err));
  shell('Settings', [],
    h('section', { class: 'card' }, h('h2', {}, 'Install the snippet'), h('p', { class: 'muted small' }, 'Paste this in the <head> of every page. Any posthog-js or posthog-node SDK works: point api_host at this instance.'),
      h('pre', { class: 'code' }, snippet), copy(snippet),
      h('h3', {}, 'Project API key'), h('div', { class: 'row' }, h('code', { class: 'token' }, p.api_token), copy(p.api_token)),
      h('p', { class: 'muted small' }, 'This key is public: it can only send events and read flags.'),
      stats ? h('p', { class: 'small' }, h('b', {}, fmt(stats.events)), ' events · ', h('b', {}, fmt(stats.persons)), ' persons · last event ', ago(stats.last_event_at), ` · ${(stats.database_bytes / 1048576).toFixed(1)} MB stored`) : null),
    form, replaySettings(p),
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

// ---------- session replay ----------
const secs = (n: number) => n < 60 ? `${n}s` : n < 3600 ? `${Math.floor(n / 60)}m ${n % 60}s` : `${Math.floor(n / 3600)}h ${Math.floor((n % 3600) / 60)}m`;
function recordingsTable(list: any[], showPerson = true) {
  if (!list.length) return h('p', { class: 'muted empty' }, project().session_recording ? 'No recordings yet. Sessions appear here a few seconds after a visitor loads a page with the snippet.' : 'Session recording is off. Turn it on in Settings.');
  return h('table', {}, h('thead', {}, h('tr', {}, showPerson ? h('th', {}, 'Person') : null, h('th', {}, 'Start'), h('th', { class: 'num' }, 'Duration'), h('th', { class: 'num' }, 'Clicks'), h('th', { class: 'num' }, 'Keys'), h('th', { class: 'num' }, 'Errors'), h('th', {}, 'Start URL'))),
    h('tbody', {}, list.map(r => h('tr', { class: 'clickable', onclick: () => nav(P(`/replay/${encodeURIComponent(r.id)}`)) },
      showPerson ? h('td', {}, r.person ? r.person.name : h('span', { class: 'muted' }, r.distinct_id || 'anonymous')) : null,
      h('td', { class: 'nowrap' }, link(P(`/replay/${encodeURIComponent(r.id)}`), when(r.start_time))), h('td', { class: 'num' }, secs(r.recording_duration)),
      h('td', { class: 'num' }, fmt(r.click_count)), h('td', { class: 'num' }, fmt(r.keypress_count)), h('td', { class: 'num' }, r.console_error_count ? h('span', { class: 'danger' }, fmt(r.console_error_count)) : '0'),
      h('td', { class: 'muted url' }, r.start_url ?? '')))));
}
async function replayListPage() {
  shell('Session replay', [], loading());
  const out = h('div', {}); const more = h('button', { hidden: true }, 'Load more') as HTMLButtonElement;
  let next: number | null = null; const all: any[] = [];
  const load = async () => {
    const r = await api<any>(apiP(`/session_recordings?limit=50${next ? `&before=${next}` : ''}`));
    all.push(...r.results); next = r.next; more.hidden = !next; out.replaceChildren(recordingsTable(all));
  };
  more.addEventListener('click', load);
  shell('Session replay', [h('button', { onclick: () => { all.length = 0; next = null; load(); } }, 'Reload')], out, more);
  await load();
}
let playerMod: Promise<any> | null = null;
function loadPlayer() {
  if (!playerMod) {
    const css = h('link', { rel: 'stylesheet', href: '/player.css' }); document.head.append(css);
    const url = '/player.js'; playerMod = import(url);
  }
  return playerMod;
}
async function replayPage(sid: string) {
  shell('Recording', [], loading());
  let rec: any;
  try { rec = await api<any>(apiP(`/session_recordings/${encodeURIComponent(sid)}`)); }
  catch (e) { if (e instanceof ApiError && e.status === 404) return shell('Recording', [], h('p', { class: 'muted empty' }, 'No recording for this session. Recording may be off, or the session had no snapshots.')); throw e; }
  const stage = h('div', { class: 'player', id: 'player' }, loading());
  const evBox = h('div', {}, loading());
  shell(rec.person ? `${rec.person.name} · ${when(rec.start_time)}` : `Recording · ${when(rec.start_time)}`,
    [h('button', { class: 'link danger', onclick: async () => { if (!confirm('Delete this recording?')) return; await api(apiP(`/session_recordings/${encodeURIComponent(sid)}`), { method: 'DELETE' }); nav(P('/replay')); } }, 'Delete recording')],
    h('div', { class: 'cols replay' }, h('section', { class: 'card' }, stage),
      h('section', {}, h('div', { class: 'card' }, h('h2', {}, 'Session'), h('dl', { class: 'facts' },
        h('dt', {}, 'Person'), h('dd', {}, rec.person ? link(P(`/persons/${rec.person.id}`), rec.person.name) : rec.distinct_id || '–'),
        h('dt', {}, 'Duration'), h('dd', {}, secs(rec.recording_duration)), h('dt', {}, 'Start URL'), h('dd', {}, rec.start_url ?? '–'),
        h('dt', {}, 'Clicks'), h('dd', {}, fmt(rec.click_count)), h('dt', {}, 'Key presses'), h('dd', {}, fmt(rec.keypress_count)), h('dt', {}, 'Console errors'), h('dd', {}, fmt(rec.console_error_count)),
        h('dt', {}, 'Session ID'), h('dd', {}, h('code', {}, rec.id)))), h('div', { class: 'card' }, h('h2', {}, 'Events in this session'), evBox))));
  const props = JSON.stringify([{ key: '$session_id', value: [sid], operator: 'exact', type: 'event' }]);
  api<any>(apiP(`/events?limit=200&properties=${encodeURIComponent(props)}`)).then(ev => {
    const start = new Date(rec.start_time).getTime();
    evBox.replaceChildren(ev.results.length ? h('ul', { class: 'timeline' }, [...ev.results].reverse().map((e: any) => h('li', {}, h('span', { class: 'muted small mono' }, secs(Math.max(0, Math.round((new Date(e.timestamp).getTime() - start) / 1000)))), ' ', h('b', {}, eventLabel(e.event)),
      e.properties.$pathname ? h('span', { class: 'muted small' }, ` ${e.properties.$pathname}`) : null))) : h('p', { class: 'muted' }, 'No events.'));
  }).catch(() => evBox.replaceChildren());
  // Snapshots arrive in pages (about 16 MB each); later pages are appended to the running player.
  const page = (cursor: string | null) => api<any>(apiP(`/session_recordings/${encodeURIComponent(sid)}/snapshots?paged=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
  const [first, mod] = await Promise.all([page(null), loadPlayer()]);
  const snapshots: any[] = first.snapshots;
  if (!snapshots.length || !snapshots.some((e: any) => e.type === 2)) { stage.replaceChildren(h('p', { class: 'muted empty' }, 'This recording has no full snapshot yet, so it cannot be played.')); return; }
  stage.replaceChildren();
  const width = Math.max(320, stage.clientWidth - 4);
  const hasCanvas = (evs: any[]) => evs.some(e => e.type === 3 && e.data?.source === 9);
  const player = new mod.default({ target: stage, props: { events: snapshots, width, height: Math.round(width * 0.6), autoPlay: false, showController: true, skipInactive: true, UNSAFE_replayCanvas: hasCanvas(snapshots) } });
  const t0 = snapshots[0].timestamp;
  const consoleBox = h('div', { class: 'devlog' }), netBox = h('div', { class: 'devlog' });
  const logs: any[] = [], reqs: any[] = [];
  const collect = (evs: any[]) => {
    for (const e of evs) {
      if (e.type !== 6) continue;
      if (e.data?.plugin === 'rrweb/console@1') logs.push({ t: e.timestamp, level: e.data.payload?.level ?? 'log', text: (e.data.payload?.payload ?? []).map((x: string) => { try { const v = JSON.parse(x); return typeof v === 'string' ? v : JSON.stringify(v); } catch { return x; } }).join(' ') });
      if (e.data?.plugin === 'rrweb/network@1') for (const r of e.data.payload?.requests ?? []) reqs.push({ t: r.timestamp ?? e.timestamp, method: r.method ?? 'GET', status: r.status ?? r.responseStatus ?? '', url: r.name ?? r.url ?? '', ms: r.duration != null ? Math.round(r.duration) : null, type: r.initiatorType ?? '', size: r.transferSize ?? r.encodedBodySize ?? null });
    }
  };
  const jump = (t: number) => { try { player.goto(Math.max(0, t - t0)); } catch { /* not ready */ } };
  const drawPanels = () => {
    consoleBox.replaceChildren(logs.length ? h('ul', { class: 'timeline' }, logs.slice(0, 1000).map(l => h('li', { class: `log-${l.level} clickable`, onclick: () => jump(l.t) }, h('span', { class: 'muted small mono' }, secs(Math.max(0, Math.round((l.t - t0) / 1000)))), ' ', h('span', { class: `tag lvl-${l.level}` }, l.level), ' ', h('span', { class: 'mono small' }, l.text.slice(0, 500))))) : h('p', { class: 'muted' }, 'No console logs captured.'));
    netBox.replaceChildren(reqs.length ? h('table', { class: 'small' }, h('thead', {}, h('tr', {}, h('th', {}, 'At'), h('th', {}, 'Method'), h('th', {}, 'Status'), h('th', {}, 'URL'), h('th', {}, 'Time'))),
      h('tbody', {}, reqs.slice(0, 1000).map(r => h('tr', { class: 'clickable', onclick: () => jump(r.t) }, h('td', { class: 'mono muted' }, secs(Math.max(0, Math.round((r.t - t0) / 1000)))), h('td', {}, r.method), h('td', { class: Number(r.status) >= 400 ? 'danger' : '' }, String(r.status)), h('td', { class: 'url mono' }, String(r.url).slice(0, 200)), h('td', { class: 'num' }, r.ms === null ? '–' : `${r.ms} ms`)))))
      : h('p', { class: 'muted' }, 'No network requests captured. Turn on network capture in Settings → Session replay.'));
  };
  collect(snapshots); drawPanels();
  stage.after(h('details', { class: 'devtools', open: true }, h('summary', {}, 'Console'), consoleBox), h('details', { class: 'devtools' }, h('summary', {}, 'Network'), netBox));
  let cursor: string | null = first.next;
  while (cursor) {
    const nx = await page(cursor);
    for (const e of nx.snapshots) player.addEvent(e);
    collect(nx.snapshots); drawPanels(); cursor = nx.next;
  }
}

// ---------- experiments ----------
const pct = (x: number | null | undefined, d = 1) => x === null || x === undefined ? '–' : `${(x * 100).toFixed(d)}%`;
const statusTag = (st: string) => h('span', { class: `tag status-${st}` }, st === 'draft' ? 'Draft' : st === 'running' ? 'Running' : 'Complete');
async function experimentsPage() {
  shell('Experiments', [], loading());
  const list = await api<any[]>(apiP('/experiments'));
  shell('Experiments', [link(P('/experiments/new'), 'New experiment', 'button primary')],
    list.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Flag'), h('th', {}, 'Variants'), h('th', {}, 'Status'), h('th', {}, 'Started'))),
      h('tbody', {}, list.map(e => h('tr', {}, h('td', {}, link(P(`/experiments/${e.id}`), e.name)), h('td', {}, h('code', {}, e.feature_flag_key)), h('td', { class: 'muted' }, e.variants.map((v: any) => v.key).join(', ')), h('td', {}, statusTag(e.status)), h('td', { class: 'muted' }, e.start_date ? when(e.start_date) : '–')))))
      : h('p', { class: 'muted empty' }, 'No experiments yet. An experiment splits persons with a multivariate feature flag and compares metrics after each person first sees the flag.'));
}
function metricEditor(metrics: any[]): HTMLElement {
  const box = h('div', {});
  const draw = () => box.replaceChildren(...metrics.map((m, i) => {
    const kind = h('select', { 'aria-label': 'Metric kind', onchange: (e: Event) => { const k = (e.target as HTMLSelectElement).value; metrics[i] = k === 'funnel' ? { kind: k, series: [{ event: '$pageview' }] } : k === 'count' ? { kind: k, event: { event: '$pageview' } } : { kind: k, event: { event: 'purchase' }, math_property: 'amount' }; draw(); } },
      opt('funnel', 'Conversion (funnel)', m.kind), opt('count', 'Event count per person', m.kind), opt('continuous', 'Sum of a property per person', m.kind));
    const body: HTMLElement[] = [];
    if (m.kind === 'funnel') {
      m.series.forEach((s: any, k: number) => body.push(h('div', { class: 'serie' }, h('span', { class: 'swatch num', style: `background:${color(k)}` }, String(k + 1)), nodePicker(s, () => {}, false),
        m.series.length > 1 ? h('button', { class: 'link', type: 'button', onclick: () => { m.series.splice(k, 1); draw(); } }, '✕') : null)));
      body.push(h('button', { class: 'link', type: 'button', onclick: () => { m.series.push({ event: null }); draw(); } }, '+ Add step'));
    } else {
      body.push(h('div', { class: 'serie' }, nodePicker(m.event, () => {}, true)));
      if (m.kind === 'continuous') body.push(h('label', {}, 'Property', h('input', { value: m.math_property, list: 'props-event', onchange: (e: Event) => { m.math_property = (e.target as HTMLInputElement).value.trim(); } })));
    }
    return h('div', { class: 'card inner editor' }, h('div', { class: 'row' }, h('b', {}, `Metric ${i + 1}`), kind, h('button', { class: 'link', type: 'button', onclick: () => { metrics.splice(i, 1); draw(); } }, 'Remove')), ...body);
  }), h('button', { type: 'button', onclick: () => { metrics.push({ kind: 'funnel', series: [{ event: '$pageview' }] }); draw(); } }, '+ Add metric'));
  draw(); return box;
}
async function experimentNewPage() {
  shell('New experiment', [], loading());
  await ensureDefs();
  const name = h('input', { placeholder: 'e.g. New checkout button' }) as HTMLInputElement;
  const key = h('input', { placeholder: 'checkout-button-test' }) as HTMLInputElement;
  const variants = [{ key: 'control', rollout_percentage: 50 }, { key: 'test', rollout_percentage: 50 }];
  const vbox = h('div', {});
  const drawV = () => vbox.replaceChildren(h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Variant'), h('th', {}, 'Split %'), h('th', {}))), h('tbody', {}, variants.map((v, i) => h('tr', {},
    h('td', {}, i === 0 ? h('code', {}, 'control') : h('input', { value: v.key, 'aria-label': 'Variant key', onchange: (e: Event) => { v.key = (e.target as HTMLInputElement).value.trim(); } })),
    h('td', {}, h('input', { type: 'number', min: 0, max: 100, value: v.rollout_percentage, class: 'narrow', 'aria-label': 'Split', onchange: (e: Event) => { v.rollout_percentage = Number((e.target as HTMLInputElement).value); } })),
    h('td', {}, i > 1 ? h('button', { class: 'link', type: 'button', onclick: () => { variants.splice(i, 1); drawV(); } }, '✕') : null))))),
    h('button', { class: 'link', type: 'button', onclick: () => { variants.push({ key: `test-${variants.length}`, rollout_percentage: 0 }); drawV(); } }, '+ Add variant'));
  drawV();
  const metrics: any[] = [{ kind: 'funnel', series: [{ event: '$pageview' }, { event: null }] }];
  const err = errBox(); const btn = h('button', { class: 'primary', type: 'submit' }, 'Save as draft') as HTMLButtonElement;
  const form = h('form', {}, eventList(), propOptions('event'),
    h('div', { class: 'card' }, h('label', {}, 'Name', name), h('label', {}, 'Feature flag key', key, h('span', { class: 'muted small' }, 'A new multivariate flag is created (off until you launch). An existing multivariate flag can be reused.'))),
    h('div', { class: 'card' }, h('h2', {}, 'Variants'), vbox),
    h('div', { class: 'card' }, h('h2', {}, 'Metrics'), h('p', { class: 'muted small' }, 'Only events at or after a person’s first exposure ($feature_flag_called) count.'), metricEditor(metrics)), err, btn);
  form.addEventListener('submit', busy(btn, async () => {
    if (variants.reduce((a, v) => a + v.rollout_percentage, 0) !== 100) throw new Error('Variant splits must add up to 100%.');
    const e = await api<any>(apiP('/experiments'), { body: { name: name.value, feature_flag_key: key.value.trim(), variants, metrics } });
    nav(P(`/experiments/${e.id}`));
  }, err));
  shell('New experiment', [], form);
}
function intervalBar(lo: number, hi: number, mean: number, min: number, max: number, c: string) {
  const W = 300, x = (v: number) => max > min ? ((v - min) / (max - min)) * W : W / 2;
  return s('svg', { viewBox: `0 0 ${W} 18`, class: 'ci', preserveAspectRatio: 'none', role: 'img', 'aria-label': `95% interval ${lo.toPrecision(3)} to ${hi.toPrecision(3)}` },
    s('rect', { x: x(lo), y: 4, width: Math.max(2, x(hi) - x(lo)), height: 10, rx: 3, fill: c, opacity: 0.35 }), s('rect', { x: x(mean) - 1, y: 1, width: 2, height: 16, fill: c }));
}
async function experimentPage(id: number) {
  shell('Experiment', [], loading());
  const [e, r] = await Promise.all([api<any>(apiP(`/experiments/${id}`)), api<any>(apiP(`/experiments/${id}/results`))]);
  const act = (action: string, msg: string) => h('button', { class: action === 'launch' ? 'primary' : '', onclick: async () => { if (!confirm(msg)) return; await api(apiP(`/experiments/${id}`), { method: 'PATCH', body: { action } }); experimentPage(id); } }, action === 'launch' ? 'Launch' : 'Stop experiment');
  const actions: Child[] = [];
  if (e.status === 'draft') actions.push(act('launch', `Launch ${e.name}? This turns on flag ${e.feature_flag_key}.`));
  if (e.status === 'running') actions.push(act('stop', 'Stop the experiment? Results freeze at this moment; the flag stays as it is.'));
  actions.push(h('button', { class: 'link danger', onclick: async () => { if (!confirm(`Delete experiment ${e.name}? The flag is kept.`)) return; await api(apiP(`/experiments/${id}`), { method: 'DELETE' }); nav(P('/experiments')); } }, 'Delete'));
  const metricCard = (m: any, i: number) => {
    const isConv = m.kind === 'funnel';
    const lo = Math.min(...m.variants.map((v: any) => v.credible_interval[0])), hi = Math.max(...m.variants.map((v: any) => v.credible_interval[1]));
    const val = (x: number) => isConv ? pct(x) : fmt(Math.round(x * 1000) / 1000);
    return h('section', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, `${i + 1}. ${m.name}`), m.significant ? h('span', { class: 'tag status-running' }, `Winner: ${m.winner}`) : h('span', { class: 'tag' }, 'Not significant')),
      m.reason ? h('p', { class: 'muted small' }, m.reason) : null,
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Variant'), h('th', { class: 'num' }, 'Exposures'), h('th', { class: 'num' }, isConv ? 'Conversions' : m.kind === 'count' ? 'Events' : 'Sum'),
        h('th', { class: 'num' }, isConv ? 'Rate' : 'Mean'), h('th', {}, '95% credible interval'), h('th', { class: 'num' }, 'Chance to be best'), h('th', { class: 'num' }, 'Uplift'))),
        h('tbody', {}, m.variants.map((v: any, k: number) => h('tr', {}, h('td', {}, h('span', { class: 'swatch', style: `background:${color(k)}` }), v.key),
          h('td', { class: 'num' }, fmt(v.exposures)), h('td', { class: 'num' }, fmt(isConv ? v.conversions : m.kind === 'count' ? v.count : v.sum)),
          h('td', { class: 'num' }, isConv ? pct(v.conversion_rate) : fmt(Math.round(v.mean * 100) / 100)),
          h('td', {}, h('div', { class: 'ci-cell' }, intervalBar(v.credible_interval[0], v.credible_interval[1], v.posterior_mean, lo, hi, color(k)), h('span', { class: 'muted small nowrap' }, `${val(v.credible_interval[0])} – ${val(v.credible_interval[1])}`))),
          h('td', { class: 'num' }, h('b', {}, pct(v.probability_to_be_best))), h('td', { class: 'num' }, v.uplift === null ? h('span', { class: 'muted' }, 'baseline') : h('span', { class: v.uplift >= 0 ? 'pos' : 'danger' }, `${v.uplift >= 0 ? '+' : ''}${pct(v.uplift)}`)))))));
  };
  shell(h('span', {}, e.name, ' ', statusTag(e.status)), actions,
    h('div', { class: 'card' }, h('dl', { class: 'facts' }, h('dt', {}, 'Feature flag'), h('dd', {}, e.feature_flag_id ? link(P(`/feature_flags/${e.feature_flag_id}`), e.feature_flag_key) : e.feature_flag_key),
      h('dt', {}, 'Variants'), h('dd', {}, e.variants.map((v: any) => `${v.key} ${v.rollout_percentage}%`).join(' · ')),
      h('dt', {}, 'Running'), h('dd', {}, e.start_date ? `${when(e.start_date)} → ${e.end_date ? when(e.end_date) : 'now'}` : 'Not launched'),
      h('dt', {}, 'Exposures'), h('dd', {}, (r.variants ?? []).map((v: any) => `${v.key}: ${fmt(v.exposures)}`).join(' · ') + (r.multiple_variant_persons ? ` (${r.multiple_variant_persons} persons saw several variants and are excluded)` : '')))),
    e.status === 'draft' ? h('p', { class: 'muted empty' }, 'Launch the experiment to start collecting exposures. Your code reads the variant with posthog.getFeatureFlag(key).') : null,
    ...(r.metrics ?? []).map(metricCard),
    h('p', { class: 'muted small' }, 'Bayesian analysis: Beta-Binomial for conversion, Gamma-Poisson for counts, Normal approximation for sums; 20,000 seeded Monte Carlo draws. A winner needs a 95% chance to be best and 50 exposures per variant.'));
}

// ---------- surveys ----------
const QTYPE: [string, string][] = [['open', 'Open text'], ['rating', 'Rating'], ['single_choice', 'Single choice'], ['multiple_choice', 'Multiple choice'], ['link', 'Link']];
async function surveysPage() {
  shell('Surveys', [], loading());
  const list = await api<any[]>(apiP('/surveys'));
  shell('Surveys', [link(P('/surveys/new'), 'New survey', 'button primary')],
    list.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Type'), h('th', {}, 'Questions'), h('th', {}, 'Status'), h('th', {}, 'Created'))),
      h('tbody', {}, list.map(sv => h('tr', {}, h('td', {}, link(P(`/surveys/${sv.id}`), sv.name)), h('td', { class: 'muted' }, sv.type), h('td', { class: 'num' }, fmt(sv.questions.length)), h('td', {}, statusTag(sv.status)), h('td', { class: 'muted' }, when(sv.created_at))))))
      : h('p', { class: 'muted empty' }, 'No surveys yet. posthog-js shows launched popover surveys to visitors and sends the answers back as events.'));
}
async function surveyEditPage(id: string | null) {
  shell('Survey', [], loading());
  await ensureDefs();
  const sv: any = id ? await api(apiP(`/surveys/${id}`)) : { name: '', type: 'popover', questions: [{ type: 'rating', question: 'How likely are you to recommend us to a friend?', display: 'number', scale: 10, lowerBoundLabel: 'Unlikely', upperBoundLabel: 'Very likely' }], conditions: null };
  const name = h('input', { value: sv.name, placeholder: 'e.g. NPS' }) as HTMLInputElement;
  const type = h('select', {}, opt('popover', 'Popover (posthog-js shows it)', sv.type), opt('api', 'API (your code renders it)', sv.type)) as HTMLSelectElement;
  const c0 = sv.conditions ?? {};
  const url = h('input', { value: c0.url ?? '', placeholder: 'e.g. /pricing (optional)' }) as HTMLInputElement;
  const urlMatch = h('select', { 'aria-label': 'URL match' }, [['icontains', 'contains'], ['exact', 'equals'], ['not_icontains', "doesn't contain"], ['is_not', "isn't"], ['regex', 'matches regex'], ['not_regex', "doesn't match regex"]].map(([v, l]) => opt(v, l, c0.urlMatchType ?? 'icontains'))) as HTMLSelectElement;
  const selector = h('input', { value: c0.selector ?? '', placeholder: 'Only when this CSS selector exists, e.g. #checkout (optional)' }) as HTMLInputElement;
  const devices = ['Desktop', 'Mobile', 'Tablet'].map(d => [d, h('input', { type: 'checkbox', checked: (c0.deviceTypes ?? []).includes(d) }) as HTMLInputElement] as const);
  const wait = h('input', { type: 'number', min: 0, value: c0.seenSurveyWaitPeriodInDays ?? '', class: 'narrow', placeholder: 'days' }) as HTMLInputElement;
  const trigger = h('input', { value: c0.events?.values?.map((v: any) => v.name).join(', ') ?? '', placeholder: 'Show after these events, comma separated (optional)', list: 'event-names' }) as HTMLInputElement;
  const repeated = h('input', { type: 'checkbox', checked: !!c0.events?.repeatedActivation }) as HTMLInputElement;
  const cancel = h('input', { value: c0.cancelEvents?.values?.map((v: any) => v.name).join(', ') ?? '', placeholder: 'Cancel a pending trigger on these events (optional)' }) as HTMLInputElement;
  const actionTrig = h('select', { 'aria-label': 'Action trigger' }, h('option', { value: '' }, 'No action trigger'), actionsList.map(a => h('option', { value: a.id, selected: c0.actions?.values?.[0]?.id === a.id }, a.name))) as HTMLSelectElement;
  const linked = h('input', { value: sv.linked_flag_key ?? '', placeholder: 'Only for persons with this flag (optional)' }) as HTMLInputElement;
  const linkedVariant = h('input', { value: c0.linkedFlagVariant ?? '', placeholder: 'variant (optional)' }) as HTMLInputElement;
  const targeting: PF[] = structuredClone(sv.targeting_flag_filters?.groups?.[0]?.properties ?? []);
  const rollout = h('input', { type: 'number', min: 0, max: 100, value: sv.targeting_flag_filters?.groups?.[0]?.rollout_percentage ?? 100, class: 'narrow' }) as HTMLInputElement;
  const iterCount = h('input', { type: 'number', min: 1, value: sv.iteration_count ?? '', class: 'narrow', placeholder: 'times' }) as HTMLInputElement;
  const iterDays = h('input', { type: 'number', min: 1, value: sv.iteration_frequency_days ?? '', class: 'narrow', placeholder: 'days' }) as HTMLInputElement;
  const partial = h('input', { type: 'checkbox', checked: !!sv.enable_partial_responses }) as HTMLInputElement;
  const schedule = h('select', { 'aria-label': 'Schedule' }, opt('once', 'Once per person', sv.schedule ?? 'once'), opt('always', 'Every time conditions match', sv.schedule)) as HTMLSelectElement;
  const qs: any[] = sv.questions; const qbox = h('div', {});
  const drawQ = () => qbox.replaceChildren(...qs.map((q, i) => {
    const extra: HTMLElement[] = [];
    if (q.type === 'rating') extra.push(h('div', { class: 'row' }, h('label', { class: 'inline' }, 'Scale ', h('select', { onchange: (e: Event) => { q.scale = Number((e.target as HTMLSelectElement).value); } }, [3, 5, 7, 10].map(n => h('option', { value: n, selected: q.scale === n }, n === 10 ? '0-10 (NPS)' : `1-${n}`)))),
      h('input', { value: q.lowerBoundLabel ?? '', placeholder: 'Low label', onchange: (e: Event) => { q.lowerBoundLabel = (e.target as HTMLInputElement).value; } }), h('input', { value: q.upperBoundLabel ?? '', placeholder: 'High label', onchange: (e: Event) => { q.upperBoundLabel = (e.target as HTMLInputElement).value; } })));
    if (q.type === 'single_choice' || q.type === 'multiple_choice') extra.push(h('label', {}, 'Choices, one per line', h('textarea', { rows: 3, onchange: (e: Event) => { q.choices = (e.target as HTMLTextAreaElement).value.split('\n').map(x => x.trim()).filter(Boolean); } }, (q.choices ?? []).join('\n'))));
    if (q.type === 'link') extra.push(h('label', {}, 'Link URL', h('input', { value: q.link ?? '', onchange: (e: Event) => { q.link = (e.target as HTMLInputElement).value; } })));
    return h('div', { class: 'card inner' }, h('div', { class: 'row' }, h('b', {}, `Question ${i + 1}`),
      h('select', { 'aria-label': 'Question type', onchange: (e: Event) => { q.type = (e.target as HTMLSelectElement).value; if (q.type === 'rating') { q.scale ??= 5; q.display ??= 'number'; } if (q.type.endsWith('choice')) q.choices ??= ['Yes', 'No']; drawQ(); } }, QTYPE.map(([v, l]) => opt(v, l, q.type))),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: !!q.optional, onchange: (e: Event) => { q.optional = (e.target as HTMLInputElement).checked; } }), 'Optional'),
      qs.length > 1 ? h('button', { class: 'link', type: 'button', onclick: () => { qs.splice(i, 1); drawQ(); } }, 'Remove') : null),
      h('label', {}, 'Question', h('input', { value: q.question, onchange: (e: Event) => { q.question = (e.target as HTMLInputElement).value; } })), ...extra);
  }), h('button', { type: 'button', onclick: () => { qs.push({ type: 'open', question: '' }); drawQ(); } }, '+ Add question'));
  drawQ();
  const err = errBox(); const btn = h('button', { class: 'primary', type: 'submit' }, id ? 'Save survey' : 'Create survey') as HTMLButtonElement;
  const names = (v: string) => v.split(',').map(x => x.trim()).filter(Boolean).map(name => ({ name }));
  const form = h('form', {}, eventList(), propOptions('person'), h('div', { class: 'card' }, h('label', {}, 'Name', name), h('label', {}, 'Type', type),
      h('label', { class: 'switch' }, partial, 'Save partial responses (each answered question is kept, even if the survey is not finished)')),
    h('div', { class: 'card' }, h('h2', {}, 'Questions'), qbox),
    h('div', { class: 'card' }, h('h2', {}, 'Who sees it'), h('p', { class: 'muted small' }, 'Persons matching all of these (person properties or cohorts). No filters means everyone.'),
      filterEditor(targeting, () => {}, ['person', 'cohort']), h('label', {}, 'Show to', h('div', { class: 'row' }, rollout, h('span', {}, '% of matching persons'))),
      h('label', {}, 'Linked feature flag', h('div', { class: 'row' }, linked, linkedVariant))),
    h('div', { class: 'card' }, h('h2', {}, 'Display conditions'),
      h('label', {}, 'URL', h('div', { class: 'row' }, urlMatch, url)), h('label', {}, 'CSS selector', selector),
      h('div', { class: 'row' }, h('span', {}, 'Devices: '), ...devices.map(([d, cb]) => h('label', { class: 'switch' }, cb, d)), h('span', { class: 'muted small' }, '(none = all)')),
      h('label', {}, 'Wait period', h('div', { class: 'row' }, wait, h('span', { class: 'muted small' }, 'days since the person last saw any survey'))),
      h('label', {}, 'Triggering events', trigger), h('label', { class: 'switch' }, repeated, 'Show again every time a triggering event happens'),
      h('label', {}, 'Cancel events', cancel), h('label', {}, 'Triggering action', actionTrig)),
    h('div', { class: 'card' }, h('h2', {}, 'Schedule'), h('label', {}, 'Show', schedule),
      h('label', {}, 'Repeat', h('div', { class: 'row' }, iterCount, h('span', {}, 'times, every'), iterDays, h('span', {}, 'days (optional; each iteration asks again)')))), err, btn);
  form.addEventListener('submit', busy(btn, async () => {
    const conditions: any = {};
    if (url.value.trim()) { conditions.url = url.value.trim(); conditions.urlMatchType = urlMatch.value; }
    if (selector.value.trim()) conditions.selector = selector.value.trim();
    const dt = devices.filter(([, cb]) => cb.checked).map(([d]) => d); if (dt.length) { conditions.deviceTypes = dt; conditions.deviceTypesMatchType = 'exact'; }
    if (wait.value !== '') conditions.seenSurveyWaitPeriodInDays = Number(wait.value);
    if (names(trigger.value).length) conditions.events = { repeatedActivation: repeated.checked, values: names(trigger.value) };
    if (names(cancel.value).length) conditions.cancelEvents = { values: names(cancel.value) };
    if (actionTrig.value) conditions.actions = { values: [{ id: Number(actionTrig.value) }] };
    if (linkedVariant.value.trim()) conditions.linkedFlagVariant = linkedVariant.value.trim();
    const props = targeting.filter(f => f.key || f.type === 'cohort');
    const tff = props.length || Number(rollout.value) < 100 ? { groups: [{ properties: props, rollout_percentage: Number(rollout.value) }] } : null;
    const body = { name: name.value, type: type.value, questions: qs, conditions: Object.keys(conditions).length ? conditions : null, targeting_flag_filters: tff,
      linked_flag_key: linked.value.trim() || null, enable_partial_responses: partial.checked, iteration_count: iterCount.value || null, iteration_frequency_days: iterDays.value || null, schedule: schedule.value };
    const r = id ? await api<any>(apiP(`/surveys/${id}`), { method: 'PATCH', body }) : await api<any>(apiP('/surveys'), { body });
    nav(P(`/surveys/${r.id}`));
  }, err));
  shell(id ? `Edit ${sv.name}` : 'New survey', [], form);
}
async function surveyPage(id: string, iteration: number | null = null) {
  shell('Survey', [], loading());
  const [sv, r] = await Promise.all([api<any>(apiP(`/surveys/${id}`)), api<any>(apiP(`/surveys/${id}/results${iteration ? `?iteration=${iteration}` : ''}`))]);
  const act = (action: string, label: string, cls = '') => h('button', { class: cls, onclick: async () => { await api(apiP(`/surveys/${id}`), { method: 'PATCH', body: { action } }); surveyPage(id); } }, label);
  const actions: Child[] = [link(P(`/surveys/${id}/edit`), 'Edit', 'button')];
  if (sv.status === 'draft') actions.push(act('launch', 'Launch', 'primary'));
  if (sv.status === 'running') actions.push(act('stop', 'Stop'));
  if (sv.status === 'complete') actions.push(act('resume', 'Resume'));
  actions.push(h('button', { class: 'link danger', onclick: async () => { if (!confirm(`Delete survey ${sv.name}? Responses stay in your events.`)) return; await api(apiP(`/surveys/${id}`), { method: 'DELETE' }); nav(P('/surveys')); } }, 'Delete'));
  const bars = (rows: { label: string; count: number }[], total: number) => h('div', { class: 'hbars' }, rows.map((x, k) => h('div', { class: 'hbar' }, h('span', { class: 'hl' }, x.label),
    h('span', { class: 'track' }, h('span', { class: 'fill', style: `width:${total ? (100 * x.count / total) : 0}%;background:${color(k % 2 ? 0 : 0)}` })), h('span', { class: 'small' }, `${fmt(x.count)} · ${total ? pct(x.count / total, 0) : '0%'}`))));
  const qcard = (q: any, i: number) => {
    let body: Child;
    if (q.type === 'rating') body = h('div', {}, q.nps !== undefined ? h('div', { class: 'bold-number' }, h('div', {}, h('div', { class: 'big' }, String(q.nps)), h('div', { class: 'muted' }, 'NPS')),
      h('div', {}, h('div', { class: 'big pos' }, fmt(q.promoters)), h('div', { class: 'muted' }, 'Promoters')), h('div', {}, h('div', { class: 'big muted' }, fmt(q.passives)), h('div', { class: 'muted' }, 'Passives')), h('div', {}, h('div', { class: 'big danger' }, fmt(q.detractors)), h('div', { class: 'muted' }, 'Detractors')))
      : h('p', {}, 'Average ', h('b', {}, q.average === null ? '–' : q.average.toFixed(2))), bars(q.distribution.map((d: any) => ({ label: String(d.value), count: d.count })), q.responses));
    else if (q.choices) body = bars(q.choices.map((c: any) => ({ label: c.choice, count: c.count })), q.responses);
    else body = q.latest?.length ? h('ul', { class: 'timeline' }, q.latest.slice(0, 12).map((a: any) => h('li', {}, h('div', {}, a.value), h('span', { class: 'muted small' }, `${a.person ? a.person.name : a.distinct_id} · ${when(a.timestamp)}`)))) : h('p', { class: 'muted' }, 'No answers yet.');
    return h('section', { class: 'card' }, h('h2', {}, `${i + 1}. ${q.question}`), h('p', { class: 'muted small' }, `${fmt(q.responses)} answers${q.latest?.length > 12 ? ' · latest 12 shown' : ''}`), body);
  };
  shell(h('span', {}, sv.name, ' ', statusTag(sv.status)), actions,
    h('div', { class: 'card' }, h('div', { class: 'bold-number' },
      h('div', {}, h('div', { class: 'big' }, fmt(r.shown.persons)), h('div', { class: 'muted' }, 'Shown (persons)')),
      h('div', {}, h('div', { class: 'big' }, fmt(r.sent.responses)), h('div', { class: 'muted' }, 'Responses')),
      h('div', {}, h('div', { class: 'big' }, fmt(r.dismissed.persons)), h('div', { class: 'muted' }, 'Dismissed')),
      h('div', {}, h('div', { class: 'big' }, r.response_rate === null ? '–' : pct(r.response_rate, 0)), h('div', { class: 'muted' }, 'Response rate'))),
      h('p', { class: 'small' }, h('b', {}, fmt(r.sent.completed)), ' completed · ', h('b', {}, fmt(r.sent.partial)), ' partial · ', h('b', {}, fmt(r.abandoned?.persons ?? 0)), ' abandoned',
        sv.iteration_count ? h('span', {}, ` · iteration ${sv.current_iteration ?? '–'} of ${sv.iteration_count} `,
          h('select', { 'aria-label': 'Iteration', onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; surveyPage(id, v ? Number(v) : null); } },
            h('option', { value: '' }, 'All iterations'), Array.from({ length: sv.iteration_count }, (_, k) => h('option', { value: k + 1, selected: iteration === k + 1 }, `Iteration ${k + 1}${r.iterations?.find((x: any) => x.iteration === k + 1) ? ` (${r.iterations.find((x: any) => x.iteration === k + 1).responses})` : ''}`)))) : null)),
    ...r.questions.map(qcard),
    h('p', { class: 'muted small' }, sv.status === 'running' ? 'posthog-js loads this survey from /api/surveys and shows it to matching visitors.' : 'Launch to show this survey to visitors.'));
}

// ---------- actions ----------
const MATCHING: [string, string][] = [['exact', 'equals'], ['contains', 'contains'], ['regex', 'matches regex']];
const stepSummary = (st: any) => [st.event ? eventLabel(st.event) : 'Any event', st.selector ? `matching ${st.selector}` : '', st.text ? `with text “${st.text}”` : '', st.href ? `link ${st.href}` : '', st.url ? `on ${st.url}` : '', (st.properties ?? []).length ? `${st.properties.length} filter(s)` : ''].filter(Boolean).join(' ');
async function actionsPage() {
  shell('Actions', [], loading());
  const list = await api<any[]>(apiP('/actions'));
  shell('Actions', [link(P('/actions/new'), 'New action', 'button primary')],
    h('p', { class: 'muted small' }, 'An action names one or more event patterns, such as clicks on a button found by CSS selector, text or link, or page views of a URL. Use actions in insights, cohorts, experiments and surveys.'),
    list.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Matches'), h('th', {}, 'Updated'))),
      h('tbody', {}, list.map(a => h('tr', {}, h('td', {}, link(P(`/actions/${a.id}`), a.name)), h('td', { class: 'muted small' }, a.steps.map(stepSummary).join(' · or ')), h('td', { class: 'muted' }, when(a.updated_at))))))
      : h('p', { class: 'muted empty' }, 'No actions yet.'));
}
async function actionPage(id: number | null) {
  shell('Action', [], loading());
  await ensureDefs();
  const a: any = id ? await api(apiP(`/actions/${id}`)) : { name: '', description: '', steps: [{ event: '$autocapture', selector: '', text: '', url: '', url_matching: 'contains' }] };
  const name = h('input', { value: a.name, placeholder: 'e.g. Clicked sign-up button', required: true }) as HTMLInputElement;
  const desc = h('input', { value: a.description ?? '', placeholder: 'Optional' }) as HTMLInputElement;
  const steps: any[] = a.steps; const box = h('div', {});
  const field = (st: any, k: string, label: string, ph: string, matchKey?: string) => h('label', {}, label, h('div', { class: 'row' },
    matchKey ? h('select', { 'aria-label': `${label} matching`, onchange: (e: Event) => { st[matchKey] = (e.target as HTMLSelectElement).value; } }, MATCHING.map(([v, l]) => opt(v, l, st[matchKey] ?? (k === 'url' ? 'contains' : 'exact')))) : null,
    h('input', { value: st[k] ?? '', placeholder: ph, 'aria-label': label, onchange: (e: Event) => { st[k] = (e.target as HTMLInputElement).value.trim(); } })));
  const draw = () => box.replaceChildren(...steps.map((st, i) => {
    st.properties ??= [];
    const auto = st.event === '$autocapture';
    return h('div', { class: 'card inner' }, h('div', { class: 'row' }, h('b', {}, i ? `OR match ${i + 1}` : 'Match'),
      h('select', { 'aria-label': 'Step kind', onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; st.event = v === 'auto' ? '$autocapture' : v === 'pageview' ? '$pageview' : ''; draw(); } },
        opt('auto', 'Autocapture (clicks, submits, changes)', auto ? 'auto' : st.event === '$pageview' ? 'pageview' : 'event'), opt('pageview', 'Page view', st.event === '$pageview' ? 'pageview' : ''), opt('event', 'Custom event', !auto && st.event !== '$pageview' ? 'event' : '')),
      steps.length > 1 ? h('button', { class: 'link', type: 'button', onclick: () => { steps.splice(i, 1); draw(); } }, 'Remove') : null),
      !auto && st.event !== '$pageview' ? h('label', {}, 'Event name', eventInput(st.event || null, v => { st.event = v ?? ''; }, true)) : null,
      auto ? field(st, 'selector', 'CSS selector', 'e.g. button.signup, [data-attr="cta"]') : null,
      auto ? field(st, 'text', 'Element text', 'e.g. Sign up', 'text_matching') : null,
      auto ? field(st, 'href', 'Link target (href)', 'e.g. /pricing', 'href_matching') : null,
      field(st, 'url', 'Page URL', 'e.g. /checkout', 'url_matching'),
      h('div', {}, h('span', { class: 'muted small' }, 'Event property filters'), filterEditor(st.properties, () => {}, ['event'])));
  }), h('button', { type: 'button', onclick: () => { steps.push({ event: '$autocapture', url_matching: 'contains' }); draw(); } }, '+ Add OR match'));
  draw();
  const count = h('div', {});
  if (id) runInsight({ kind: 'TrendsQuery', series: [{ kind: 'ActionsNode', id, math: 'total' }], interval: 'day', dateRange: { date_from: '-30d' }, trendsFilter: { display: 'ActionsLineGraph' }, properties: [] }, count);
  const err = errBox(); const btn = h('button', { class: 'primary', type: 'submit' }, id ? 'Save action' : 'Create action') as HTMLButtonElement;
  const form = h('form', {}, eventList(), propOptions('event'), h('div', { class: 'card' }, h('label', {}, 'Name', name), h('label', {}, 'Description', desc)),
    h('div', { class: 'card' }, h('h2', {}, 'Match events'), h('p', { class: 'muted small' }, 'An event matches when every filled-in field of any one match block holds. Selectors support tag, #id, .class, [attr=value], :nth-child(n), descendant and child (>) combinators.'), box), err, btn,
    id ? h('div', { class: 'card' }, h('h2', {}, 'Matching events, last 30 days'), count) : null);
  form.addEventListener('submit', busy(btn, async () => {
    const clean = steps.map(st => { const o: any = {}; for (const [k, v] of Object.entries(st)) if (v !== '' && v !== null && v !== undefined && !(Array.isArray(v) && !v.length)) o[k] = v; o.properties = (st.properties ?? []).filter((p: PF) => p.key); return o; });
    const body = { name: name.value.trim(), description: desc.value.trim(), steps: clean };
    const r = id ? await api<any>(apiP(`/actions/${id}`), { method: 'PATCH', body }) : await api<any>(apiP('/actions'), { body });
    await ensureDefs(true); nav(P(`/actions/${r.id}`));
  }, err));
  shell(id ? a.name : 'New action', id ? [h('button', { class: 'link danger', onclick: async () => { if (!confirm(`Delete action ${a.name}?`)) return; await api(apiP(`/actions/${id}`), { method: 'DELETE' }); await ensureDefs(true); nav(P('/actions')); } }, 'Delete')] : [], form);
}

// ---------- cohorts ----------
async function cohortsPage() {
  shell('Cohorts', [], loading());
  const list = await api<any[]>(apiP('/cohorts'));
  shell('Cohorts', [link(P('/cohorts/new'), 'New cohort', 'button primary')],
    list.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Type'), h('th', {}, 'Persons'), h('th', {}, 'Last calculated'))),
      h('tbody', {}, list.map(c => h('tr', {}, h('td', {}, link(P(`/cohorts/${c.id}`), c.name), c.description ? h('div', { class: 'muted small' }, c.description) : null), h('td', { class: 'muted' }, c.is_static ? 'Static' : 'Dynamic'), h('td', { class: 'num' }, fmt(c.count)), h('td', { class: 'muted' }, c.is_static ? '–' : ago(c.last_calculated_at))))))
      : h('p', { class: 'muted empty' }, 'No cohorts yet. Cohorts group persons by properties, behaviour or an uploaded list, and work as filters in insights, flags, surveys and experiments.'));
}
function criteriaEditor(root: any, cohortId: number | null): HTMLElement {
  const box = h('div', {});
  root.type ??= 'OR'; root.values ??= [];
  const draw = () => box.replaceChildren(...root.values.map((g: any, gi: number) => h('div', { class: 'card inner' },
    h('div', { class: 'row' }, h('b', {}, gi ? 'OR persons who match all of' : 'Persons who match all of'), root.values.length > 1 ? h('button', { class: 'link', type: 'button', onclick: () => { root.values.splice(gi, 1); draw(); } }, 'Remove group') : null),
    ...g.values.map((c: any, ci: number) => {
      const kind = c.type === 'behavioral' ? (c.event_type === 'actions' ? 'action' : 'event') : c.type;
      const kindSel = h('select', { 'aria-label': 'Criterion type', onchange: (e: Event) => {
        const v = (e.target as HTMLSelectElement).value;
        g.values[ci] = v === 'person' ? { type: 'person', key: '', operator: 'exact', value: [] } : v === 'cohort' ? { type: 'cohort', key: 'id', value: cohortsList.find(x => x.id !== cohortId)?.id }
          : { type: 'behavioral', event_type: v === 'action' ? 'actions' : 'events', key: v === 'action' ? actionsList[0]?.id : '$pageview', value: 'performed_event', time_value: 30, time_interval: 'day' };
        draw(); } }, opt('person', 'Person property', kind), opt('event', 'Performed event', kind), opt('action', 'Performed action', kind), opt('cohort', 'In cohort', kind));
      const neg = h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: !!c.negation, onchange: (e: Event) => { c.negation = (e.target as HTMLInputElement).checked; } }), 'not');
      let body: Child[] = [];
      if (c.type === 'person') {
        const tmp: PF[] = [{ key: c.key, value: c.value, operator: c.operator, type: 'person' }];
        const sync = () => { Object.assign(c, { key: tmp[0]?.key ?? '', value: tmp[0]?.value, operator: tmp[0]?.operator ?? 'exact' }); };
        body = [filterEditor(tmp, sync, ['person'], true)];
      } else if (c.type === 'cohort') {
        body = [h('select', { 'aria-label': 'Cohort', onchange: (e: Event) => { c.value = Number((e.target as HTMLSelectElement).value); } }, cohortsList.filter(x => x.id !== cohortId).map(x => h('option', { value: x.id, selected: Number(c.value) === x.id }, x.name)))];
      } else {
        const multi = c.value === 'performed_event_multiple';
        body = [c.event_type === 'actions'
          ? h('select', { 'aria-label': 'Action', onchange: (e: Event) => { c.key = Number((e.target as HTMLSelectElement).value); } }, actionsList.map(a => h('option', { value: a.id, selected: Number(c.key) === a.id }, a.name)))
          : eventInput(c.key || null, v => { c.key = v ?? '$pageview'; }, false),
          h('select', { 'aria-label': 'How often', onchange: (e: Event) => { c.value = (e.target as HTMLSelectElement).value; if (c.value === 'performed_event_multiple') { c.operator ??= 'gte'; c.operator_value ??= 3; } draw(); } }, opt('performed_event', 'at least once', c.value), opt('performed_event_multiple', 'a number of times', c.value)),
          multi ? h('select', { 'aria-label': 'Count operator', onchange: (e: Event) => { c.operator = (e.target as HTMLSelectElement).value; } }, [['gte', 'at least'], ['lte', 'at most'], ['exact', 'exactly'], ['gt', 'more than'], ['lt', 'fewer than']].map(([v, l]) => opt(v, l, c.operator ?? 'gte'))) : null,
          multi ? h('input', { type: 'number', min: 0, class: 'narrow', value: c.operator_value ?? 1, 'aria-label': 'Count', onchange: (e: Event) => { c.operator_value = Number((e.target as HTMLInputElement).value); } }) : null,
          h('span', {}, 'in the last'), h('input', { type: 'number', min: 1, class: 'narrow', value: c.time_value ?? 30, 'aria-label': 'Time value', onchange: (e: Event) => { c.time_value = Number((e.target as HTMLInputElement).value); } }),
          h('select', { 'aria-label': 'Time unit', onchange: (e: Event) => { c.time_interval = (e.target as HTMLSelectElement).value; } }, ['day', 'week', 'month', 'year'].map(u => opt(u, u + 's', c.time_interval ?? 'day')))];
      }
      return h('div', { class: 'row criterion' }, neg, kindSel, ...body, h('button', { class: 'link', type: 'button', 'aria-label': 'Remove criterion', onclick: () => { g.values.splice(ci, 1); draw(); } }, '✕'));
    }),
    h('button', { class: 'link', type: 'button', onclick: () => { g.values.push({ type: 'behavioral', event_type: 'events', key: '$pageview', value: 'performed_event', time_value: 30, time_interval: 'day' }); draw(); } }, '+ Add criterion'))),
    h('button', { type: 'button', onclick: () => { root.values.push({ type: 'AND', values: [{ type: 'person', key: '', operator: 'exact', value: [] }] }); draw(); } }, '+ Add OR group'));
  draw(); return box;
}
async function cohortPage(id: number | null) {
  shell('Cohort', [], loading());
  await ensureDefs();
  const c: any = id ? await api(apiP(`/cohorts/${id}`)) : { name: '', description: '', is_static: false, filters: { properties: { type: 'OR', values: [{ type: 'AND', values: [{ type: 'behavioral', event_type: 'events', key: '$pageview', value: 'performed_event', time_value: 30, time_interval: 'day' }] }] } } };
  const name = h('input', { value: c.name, required: true, placeholder: 'e.g. Power users' }) as HTMLInputElement;
  const desc = h('input', { value: c.description ?? '', placeholder: 'Optional' }) as HTMLInputElement;
  let isStatic = !!c.is_static;
  const root = c.filters?.properties ?? { type: 'OR', values: [] };
  const defBox = h('div', {});
  const csv = h('textarea', { rows: 5, placeholder: 'One distinct ID, email or person ID per line, or a CSV with a distinct_id, email or person_id column' }) as HTMLTextAreaElement;
  const file = h('input', { type: 'file', accept: '.csv,text/csv,text/plain', onchange: async (e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) csv.value = await f.text(); } }) as HTMLInputElement;
  const drawDef = () => defBox.replaceChildren(isStatic
    ? h('div', {}, h('p', { class: 'muted small' }, id ? 'Add more persons to this static cohort:' : 'Upload or paste the persons in this cohort:'), file, csv)
    : h('div', {}, h('p', { class: 'muted small' }, 'Membership is recalculated when you save, every hour, and on demand.'), criteriaEditor(root, id)));
  drawDef();
  const typeSel = id ? h('p', { class: 'muted' }, isStatic ? 'Static cohort (a fixed list of persons)' : 'Dynamic cohort')
    : h('label', {}, 'Type', h('select', { onchange: (e: Event) => { isStatic = (e.target as HTMLSelectElement).value === 'static'; drawDef(); } }, opt('dynamic', 'Dynamic (matching properties or behaviour)', 'dynamic'), opt('static', 'Static (uploaded list)', '')));
  const err = errBox(); const btn = h('button', { class: 'primary', type: 'submit' }, id ? 'Save cohort' : 'Create cohort') as HTMLButtonElement;
  const persons = h('div', {});
  const form = h('form', {}, eventList(), propOptions('person'), h('div', { class: 'card' }, h('label', {}, 'Name', name), h('label', {}, 'Description', desc), typeSel),
    h('div', { class: 'card' }, h('h2', {}, isStatic ? 'Persons' : 'Matching criteria'), defBox), err, btn);
  form.addEventListener('submit', busy(btn, async () => {
    const body: any = { name: name.value.trim(), description: desc.value.trim() };
    if (!id) body.is_static = isStatic;
    if (!isStatic) body.filters = { properties: root };
    if (isStatic && csv.value.trim()) body.csv = csv.value;
    let r: any;
    if (id) { r = await api<any>(apiP(`/cohorts/${id}`), { method: 'PATCH', body: isStatic ? { name: body.name, description: body.description } : body }); if (isStatic && csv.value.trim()) await api(apiP(`/cohorts/${id}/persons`), { body: { csv: csv.value } }); }
    else r = await api<any>(apiP('/cohorts'), { body });
    await ensureDefs(true); nav(P(`/cohorts/${r.id}`));
  }, err));
  const loadPersons = async () => {
    const r = await api<any>(apiP(`/cohorts/${id}/persons`));
    persons.replaceChildren(r.results.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Person'), h('th', {}, 'Distinct IDs'), h('th', {}, 'Last seen'), isStatic ? h('th', {}) : null)),
      h('tbody', {}, r.results.map((p: any) => h('tr', {}, h('td', {}, link(P(`/persons/${p.id}`), p.name)), h('td', { class: 'muted small' }, p.distinct_ids.slice(0, 3).join(', ')), h('td', { class: 'muted' }, ago(p.last_seen_at)),
        isStatic ? h('td', {}, h('button', { class: 'link danger', onclick: async () => { await api(apiP(`/cohorts/${id}/persons/${encodeURIComponent(p.id)}`), { method: 'DELETE' }); loadPersons(); } }, 'Remove')) : null))))
      : h('p', { class: 'muted' }, 'No persons in this cohort yet.'), r.next ? h('p', { class: 'muted small' }, 'Showing the first 100.') : '');
  };
  const actions: Child[] = [];
  if (id) {
    if (!isStatic) actions.push(h('button', { onclick: async (e: Event) => { (e.target as HTMLButtonElement).textContent = 'Calculating…'; await api(apiP(`/cohorts/${id}/calculate`), { body: {} }); cohortPage(id); } }, 'Recalculate now'));
    actions.push(h('button', { class: 'link danger', onclick: async () => { if (!confirm(`Delete cohort ${c.name}?`)) return; await api(apiP(`/cohorts/${id}`), { method: 'DELETE' }); await ensureDefs(true); nav(P('/cohorts')); } }, 'Delete'));
  }
  shell(id ? c.name : 'New cohort', actions, form,
    id ? h('section', { class: 'card' }, h('h2', {}, `${fmt(c.count)} persons`), h('p', { class: 'muted small' }, isStatic ? 'Static list.' : `Last calculated ${ago(c.last_calculated_at)}.`), persons) : null);
  if (id) loadPersons();
}

// ---------- SQL ----------
const SQL_EXAMPLES: [string, string][] = [
  ['Top events, last 7 days', "SELECT event, count() AS events, uniq(distinct_id) AS users\nFROM events\nWHERE timestamp > now() - INTERVAL 7 DAY\nGROUP BY event\nORDER BY events DESC\nLIMIT 20"],
  ['Pageviews by path', "SELECT properties.$pathname AS path, count() AS views\nFROM events\nWHERE event = '$pageview' AND timestamp > now() - INTERVAL 30 DAY\nGROUP BY path\nORDER BY views DESC\nLIMIT 50"],
  ['Daily active persons', "SELECT toDate(timestamp) AS day, count(DISTINCT person_id) AS persons\nFROM events\nWHERE timestamp > now() - INTERVAL 14 DAY\nGROUP BY day\nORDER BY day"],
  ['Persons by email domain', "SELECT person.properties.email AS email, count() AS events\nFROM events\nWHERE person.properties.email LIKE '%@%'\nGROUP BY email\nORDER BY events DESC\nLIMIT 20"],
  ['Latest persons', "SELECT id, properties.email, created_at FROM persons ORDER BY created_at DESC LIMIT 20"],
];
async function sqlPage() {
  const saved = sessionStorage.getItem(`sql:${pid}`) ?? SQL_EXAMPLES[0][1];
  const ta = h('textarea', { class: 'sql mono', rows: 10, spellcheck: false, 'aria-label': 'SQL query' }, saved) as HTMLTextAreaElement;
  const out = h('div', { class: 'result' }); const err = errBox(); const meta = h('p', { class: 'muted small' });
  const btn = h('button', { class: 'primary', type: 'button' }, 'Run') as HTMLButtonElement;
  // Cold tier (Basin SQL over the Iceberg copy of all events) when the instance has one configured.
  const cfg = await api<{ cold_tier?: boolean }>('/api/config').catch(() => ({ cold_tier: false }));
  const srcSel = h('select', { 'aria-label': 'Data source', onchange: () => sessionStorage.setItem(`sqlsrc:${pid}`, srcSel.value) },
    opt('hot', 'Hot: event shards + persons', sessionStorage.getItem(`sqlsrc:${pid}`) ?? 'hot'), opt('cold', 'Cold: Iceberg via Basin SQL (events only)', sessionStorage.getItem(`sqlsrc:${pid}`) ?? 'hot')) as HTMLSelectElement;
  const run = busy(btn, async () => {
    err.textContent = ''; sessionStorage.setItem(`sql:${pid}`, ta.value); const t = performance.now();
    out.replaceChildren(loading());
    try {
      const source = cfg.cold_tier ? srcSel.value : 'hot';
      const r = await api<any>(apiP('/sql'), { body: { query: ta.value, source } });
      const scanned = r.scanned && typeof r.scanned.bytes === 'number' ? ` · Basin SQL scanned ${fmt(r.scanned.bytes)} bytes in ${fmt(r.scanned.files ?? 0)} file${r.scanned.files === 1 ? '' : 's'}` : '';
      meta.textContent = `${fmt(r.results.length)} row${r.results.length === 1 ? '' : 's'}${r.hasMore ? ' (more available; add LIMIT/OFFSET)' : ''} · ${Math.round(performance.now() - t)} ms${source === 'cold' ? ' · cold tier' : ''}${scanned}`;
      out.replaceChildren(h('div', { class: 'scroll-x' }, h('table', { class: 'sql-result' }, h('thead', {}, h('tr', {}, r.columns.map((c: string) => h('th', {}, c)))),
        h('tbody', {}, r.results.map((row: unknown[]) => h('tr', {}, row.map(v => h('td', { class: typeof v === 'number' ? 'num' : 'mono small' }, v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v)))))))));
    } catch (e) { out.replaceChildren(); meta.textContent = ''; throw e; }
  }, err);
  btn.addEventListener('click', run);
  ta.addEventListener('keydown', (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); btn.click(); } });
  shell('SQL', [],
    h('section', { class: 'card' }, h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Examples:'), ...SQL_EXAMPLES.map(([l, q]) => h('button', { class: 'link', type: 'button', onclick: () => { ta.value = q; } }, l))),
      ta, h('div', { class: 'row' }, btn, cfg.cold_tier ? srcSel : null, h('span', { class: 'muted small' }, 'Ctrl/⌘ + Enter. Read-only SELECT over events and persons in this project. Times are UTC; results stop at 10,000 rows; queries time out after 25 s.')), err, meta),
    h('section', { class: 'card' }, out));
  if (location.hash === '#run') btn.click();
}

// ---------- heatmaps ----------
async function heatmapsPage() {
  shell('Heatmaps', [], loading());
  const p = project();
  const params = new URLSearchParams(location.search);
  const st = { url: params.get('url') ?? '', type: params.get('type') ?? 'click', agg: 'total_count', from: params.get('date_from') ?? '-7d', width: Number(params.get('width')) || 1280, bg: params.get('bg') ?? 'iframe', opacity: 0.7 };
  const urls = await api<any>(apiP(`/heatmaps/urls?date_from=${encodeURIComponent(st.from)}`)).catch(() => ({ results: [] }));
  if (!st.url && urls.results.length) st.url = urls.results[0].url;
  const urlIn = h('input', { value: st.url, list: 'heatmap-urls', placeholder: 'https://your-site/page', class: 'wide', 'aria-label': 'Page URL' }) as HTMLInputElement;
  const stage = h('div', { class: 'heatmap-stage' }); const side = h('div', {}); const err = errBox();
  const sel = (label: string, key: keyof typeof st, opts: [string, string][]) => h('label', {}, label, h('select', { onchange: (e: Event) => { (st as any)[key] = (e.target as HTMLSelectElement).value; draw(); } }, opts.map(([v, l]) => opt(v, l, String(st[key])))));
  const draw = async () => {
    err.textContent = ''; st.url = urlIn.value.trim();
    history.replaceState(null, '', `${location.pathname}?${new URLSearchParams({ url: st.url, type: st.type, date_from: st.from, width: String(st.width), bg: st.bg })}`);
    if (!st.url) { stage.replaceChildren(h('p', { class: 'muted empty' }, 'Pick a page. Pages appear here after posthog-js sends heatmap data (turn on “Collect heatmaps” in Settings).')); return; }
    stage.replaceChildren(loading());
    const pattern = st.url.includes('*');
    const qs = new URLSearchParams({ date_from: st.from, [pattern ? 'url_pattern' : 'url_exact']: st.url, aggregation: st.agg });
    try {
      if (st.type === 'scrolldepth') {
        const r = await api<any>(apiP(`/scroll_depth?${qs}`));
        return drawScroll(r);
      }
      qs.set('type', st.type);
      const r = await api<any>(apiP(`/heatmaps?${qs}`));
      drawHeat(r.results);
    } catch (e) { stage.replaceChildren(); err.textContent = e instanceof Error ? e.message : String(e); }
  };
  const background = async (W: number, H: number): Promise<HTMLElement> => {
    if (st.bg === 'iframe' && !st.url.includes('*')) {
      return h('iframe', { src: st.url, class: 'heatmap-bg', style: `width:${W}px;height:${H}px`, sandbox: 'allow-same-origin allow-scripts', referrerpolicy: 'no-referrer', title: 'Page preview', scrolling: 'no' });
    }
    if (st.bg === 'recording') {
      // The first full snapshot of the newest recording that started on this page.
      const recs = await api<any>(apiP('/session_recordings?limit=50'));
      const rec = recs.results.find((x: any) => x.start_url && (x.start_url === st.url || x.start_url.split('?')[0] === st.url.split('?')[0]));
      if (rec) {
        const [pg, mod] = await Promise.all([api<any>(apiP(`/session_recordings/${encodeURIComponent(rec.id)}/snapshots?paged=1`)), loadPlayer()]);
        const full = pg.snapshots.findIndex((e: any) => e.type === 2);
        if (full >= 0) {
          const holder = h('div', { class: 'heatmap-bg rec', style: `width:${W}px;height:${H}px` });
          const evs = pg.snapshots.slice(0, full + 1);
          setTimeout(() => { try { const r = new mod.Replayer(evs, { root: holder, skipInactive: true, mouseTail: false }); r.pause(evs[evs.length - 1].timestamp - evs[0].timestamp); const ifr = holder.querySelector('iframe'); if (ifr) { ifr.style.width = `${W}px`; ifr.style.height = `${H}px`; } } catch { /* plain background */ } }, 30);
          return holder;
        }
      }
      return h('div', { class: 'heatmap-bg blank', style: `width:${W}px;height:${H}px` }, h('p', { class: 'muted' }, 'No recording of this page with a full snapshot was found.'));
    }
    return h('div', { class: 'heatmap-bg blank', style: `width:${W}px;height:${H}px` });
  };
  const drawHeat = async (cells: any[]) => {
    const W = st.width; const maxY = cells.reduce((m, c) => Math.max(m, c.client_y), 0); const H = Math.max(800, maxY + 200);
    const canvas = h('canvas', { width: W, height: H, class: 'heatmap-canvas', style: `opacity:${st.opacity}` }) as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    const max = cells.reduce((m, c) => Math.max(m, c.count), 1);
    // Intensity pass in alpha, then colourize.
    const r = st.type === 'mousemove' ? 14 : 22;
    for (const c of cells) {
      const x = c.pointer_relative_x * W, y = c.client_y + 8;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r); const a = Math.min(1, 0.15 + c.count / max);
      g.addColorStop(0, `rgba(0,0,0,${a})`); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    const img = ctx.getImageData(0, 0, W, H); const d = img.data;
    for (let i = 0; i < d.length; i += 4) { const a = d[i + 3] / 255; if (!a) continue; const t = Math.min(1, a); const [R, G, B] = t < 0.33 ? [0, Math.round(255 * t * 3), 255] : t < 0.66 ? [Math.round(255 * (t - 0.33) * 3), 255, Math.round(255 * (1 - (t - 0.33) * 3))] : [255, Math.round(255 * (1 - (t - 0.66) * 3)), 0]; d[i] = R; d[i + 1] = G; d[i + 2] = B; d[i + 3] = Math.round(200 * Math.min(1, a * 1.4)); }
    ctx.putImageData(img, 0, 0);
    const scale = Math.min(1, (stage.clientWidth || W) / W);
    const inner = h('div', { class: 'heatmap-inner', style: `width:${W}px;height:${H}px;transform:scale(${scale});transform-origin:0 0` }, await background(W, H), canvas);
    stage.replaceChildren(h('div', { class: 'heatmap-frame', style: `height:${Math.round(H * scale)}px` }, inner));
    const total = cells.reduce((t, c) => t + c.count, 0);
    side.replaceChildren(h('p', { class: 'small' }, h('b', {}, fmt(total)), ` ${st.agg === 'unique_visitors' ? 'visitor-cells' : st.type === 'mousemove' ? 'moves' : 'clicks'} · ${fmt(cells.length)} hot spots · ${W}px wide`),
      st.bg === 'iframe' ? h('p', { class: 'muted small' }, 'The page is loaded live in a frame. If it stays blank, the site forbids framing: switch the background to a recording.') : '');
  };
  const drawScroll = (r: any) => {
    stage.replaceChildren(h('div', { class: 'hbars' }, r.results.filter((x: any) => x.percentage > 0).map((x: any) => h('div', { class: 'hbar' }, h('span', { class: 'hl' }, `${x.percentage}%`),
      h('span', { class: 'track' }, h('span', { class: 'fill', style: `width:${100 * x.share}%;background:${color(0)}` })), h('span', { class: 'small' }, `${fmt(x.count)} · ${pct(x.share, 0)}`)))));
    side.replaceChildren(h('p', { class: 'small' }, h('b', {}, fmt(r.pageviews)), ` page views of ${r.pathname ?? 'all pages'} reported how far they scrolled. Bars show the share that scrolled at least that far.`));
  };
  urlIn.addEventListener('change', draw);
  shell('Heatmaps', [],
    !p.heatmaps ? h('p', { class: 'muted small' }, 'Heatmap collection is off for this project. ', link(P('/settings'), 'Turn it on in Settings'), '.') : null,
    h('section', { class: 'card' }, h('datalist', { id: 'heatmap-urls' }, urls.results.map((u: any) => h('option', { value: u.url }, `${u.url} (${u.count})`))),
      h('div', { class: 'row opts' }, h('label', {}, 'Page (use * as a wildcard)', urlIn),
        sel('Type', 'type', [['click', 'Clicks'], ['rageclick', 'Rage clicks'], ['deadclick', 'Dead clicks'], ['mousemove', 'Mouse moves'], ['scrolldepth', 'Scroll depth']]),
        sel('Count', 'agg', [['total_count', 'Total'], ['unique_visitors', 'Unique visitors']]),
        sel('Dates', 'from', [['-24h', 'Last 24 hours'], ['-7d', 'Last 7 days'], ['-30d', 'Last 30 days'], ['-90d', 'Last 90 days']]),
        sel('Width', 'width', [['375', 'Mobile 375'], ['768', 'Tablet 768'], ['1024', '1024'], ['1280', '1280'], ['1440', '1440'], ['1920', '1920']]),
        sel('Background', 'bg', [['iframe', 'Live page'], ['recording', 'Recording snapshot'], ['none', 'None']])), side, err),
    h('section', { class: 'card' }, stage));
  draw();
}

// ---------- replay settings ----------
function replaySettings(p: Project): HTMLElement {
  const c = p.replay_config ?? {};
  const num = (v: unknown, attrs: any = {}) => h('input', { type: 'number', value: v ?? '', class: 'narrow', ...attrs }) as HTMLInputElement;
  const cb = (v: boolean) => h('input', { type: 'checkbox', checked: v }) as HTMLInputElement;
  const lines = (v: string[] | undefined, ph: string) => h('textarea', { rows: 2, placeholder: ph }, (v ?? []).join('\n')) as HTMLTextAreaElement;
  const sample = num(c.sample_rate != null ? Math.round(c.sample_rate * 100) : 100, { min: 0, max: 100 });
  const minDur = num(c.minimum_duration_ms != null ? c.minimum_duration_ms / 1000 : '', { min: 0, max: 3600, placeholder: 'seconds' });
  const flagKey = h('input', { value: c.linked_flag?.key ?? '', placeholder: 'flag key (optional)' }) as HTMLInputElement;
  const flagVar = h('input', { value: c.linked_flag?.variant ?? '', placeholder: 'variant (optional)' }) as HTMLInputElement;
  const consoleCb = cb(c.console !== false), netTiming = cb(!!c.network?.timing), netHeaders = cb(!!c.network?.headers), netBody = cb(!!c.network?.body);
  const canvasCb = cb(!!c.canvas?.enabled), fps = num(c.canvas?.fps ?? 4, { min: 0, max: 12 }), quality = num(c.canvas?.quality ?? 0.4, { min: 0, max: 1, step: 0.1 });
  const urlTrig = lines(c.url_triggers, 'Start recording only on URLs matching these regexes (one per line)');
  const urlBlock = lines(c.url_blocklist, 'Pause recording on URLs matching these regexes');
  const evTrig = lines(c.event_triggers, 'Start recording only after one of these events');
  const match = h('select', {}, opt('any', 'Any trigger starts recording', c.trigger_match ?? 'any'), opt('all', 'All triggers must match', c.trigger_match)) as HTMLSelectElement;
  const maskInputs = cb(c.masking?.mask_all_inputs !== false);
  const maskText = h('input', { value: c.masking?.mask_text_selector ?? '', placeholder: 'e.g. .private, [data-mask]' }) as HTMLInputElement;
  const block = h('input', { value: c.masking?.block_selector ?? '', placeholder: 'e.g. video, .no-record' }) as HTMLInputElement;
  const err = errBox(); const btn = h('button', { class: 'primary', type: 'submit' }, 'Save replay settings') as HTMLButtonElement;
  const split = (t: HTMLTextAreaElement) => t.value.split('\n').map(x => x.trim()).filter(Boolean);
  const form = h('form', { class: 'card', id: 'replay-settings' }, h('h2', {}, 'Session replay'),
    h('p', { class: 'muted small' }, 'Sent to posthog-js in its remote config; applies to new sessions. Recording itself is switched on above.'),
    h('div', { class: 'row opts' }, h('label', {}, 'Sample rate %', sample), h('label', {}, 'Minimum duration (s)', minDur), h('label', {}, 'Only with flag', h('div', { class: 'row' }, flagKey, flagVar))),
    h('div', { class: 'row' }, h('label', { class: 'switch' }, consoleCb, 'Console logs'), h('label', { class: 'switch' }, netTiming, 'Network requests'), h('label', { class: 'switch' }, netHeaders, 'Request headers'), h('label', { class: 'switch' }, netBody, 'Request bodies')),
    h('div', { class: 'row' }, h('label', { class: 'switch' }, canvasCb, 'Record canvas'), h('label', {}, 'FPS', fps), h('label', {}, 'Quality', quality)),
    h('label', {}, 'URL triggers', urlTrig), h('label', {}, 'URL blocklist', urlBlock), h('label', {}, 'Event triggers', evTrig), h('label', {}, 'Trigger matching', match),
    h('div', { class: 'row' }, h('label', { class: 'switch' }, maskInputs, 'Mask all inputs'), h('label', {}, 'Mask text', maskText), h('label', {}, 'Block elements', block)), err, btn);
  form.addEventListener('submit', busy(btn, async () => {
    const rc = { sample_rate: Number(sample.value) / 100, minimum_duration_ms: minDur.value === '' ? null : Math.round(Number(minDur.value) * 1000),
      linked_flag: flagKey.value.trim() ? { key: flagKey.value.trim(), variant: flagVar.value.trim() || null } : null, console: consoleCb.checked,
      network: { timing: netTiming.checked, headers: netHeaders.checked, body: netBody.checked }, canvas: { enabled: canvasCb.checked, fps: Number(fps.value), quality: Number(quality.value) },
      url_triggers: split(urlTrig), url_blocklist: split(urlBlock), event_triggers: split(evTrig), trigger_match: match.value,
      masking: { mask_all_inputs: maskInputs.checked, mask_text_selector: maskText.value.trim() || null, block_selector: block.value.trim() || null } };
    const r = await api<Project>(apiP(''), { method: 'PATCH', body: { replay_config: rc } });
    projects = projects.map(x => x.id === r.id ? r : x); btn.textContent = 'Saved';
  }, err));
  return form;
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
    if (sub === '/replay') return await replayListPage();
    if ((r = /^\/replay\/([^/]+)$/.exec(sub))) return await replayPage(decodeURIComponent(r[1]));
    if (sub === '/experiments') return await experimentsPage();
    if (sub === '/experiments/new') return await experimentNewPage();
    if ((r = /^\/experiments\/(\d+)$/.exec(sub))) return await experimentPage(+r[1]);
    if (sub === '/actions') return await actionsPage();
    if (sub === '/actions/new') return await actionPage(null);
    if ((r = /^\/actions\/(\d+)$/.exec(sub))) return await actionPage(+r[1]);
    if (sub === '/cohorts') return await cohortsPage();
    if (sub === '/cohorts/new') return await cohortPage(null);
    if ((r = /^\/cohorts\/(\d+)$/.exec(sub))) return await cohortPage(+r[1]);
    if (sub === '/sql') return await sqlPage();
    if (sub === '/heatmaps') return await heatmapsPage();
    if (sub === '/surveys') return await surveysPage();
    if (sub === '/surveys/new') return await surveyEditPage(null);
    if ((r = /^\/surveys\/([\w-]+)\/edit$/.exec(sub))) return await surveyEditPage(r[1]);
    if ((r = /^\/surveys\/([\w-]+)$/.exec(sub))) return await surveyPage(r[1]);
    shell('Not found', [], h('p', {}, 'Nothing here. ', link(P('/dashboards'), 'Go to dashboards')));
  } catch (e) {
    root.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'auth card' }, h('p', { class: 'error' }, e instanceof Error ? e.message : String(e)), link('/', 'Reload'))));
  }
}
window.addEventListener('popstate', render);
render();
