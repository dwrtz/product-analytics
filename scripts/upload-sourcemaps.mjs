#!/usr/bin/env node
// Uploads source maps to a Product Analytics project so error stack traces are symbolicated (design.md "Source maps").
// For every *.js file under --dir that has a map (a sibling <file>.map, or a sourceMappingURL comment pointing to a
// local file), PUTs the map to /api/projects/<id>/symbol_sets?url=<url-prefix + path relative to --dir>.
// Node 18+, no dependencies. The personal API key comes from PA_PERSONAL_API_KEY (or --key, which shows in `ps`).
//
//   PA_PERSONAL_API_KEY=phx_... node upload-sourcemaps.mjs --host https://analytics.example.com --project 1 \
//     --dir dist/assets --url-prefix https://www.example.com/assets/ [--release 1.4.2] [--dry-run]
// --release scopes the maps to exceptions whose $release / release / $app_version / app_version equals it (0.6); without
// it a map applies to any release. Uploading re-symbolicates matching exceptions from the last 30 days.
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => {
  if (x.startsWith('--')) a.push([x.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return a;
}, []));
const need = k => { if (!args[k] || args[k] === true) { console.error(`missing --${k}\nusage: upload-sourcemaps.mjs --host <url> --project <id> --dir <build dir> --url-prefix <public URL of that dir> [--release <version>] [--dry-run]`); process.exit(2); } return String(args[k]); };
const host = need('host').replace(/\/+$/, ''); const project = need('project'); const dir = path.resolve(need('dir'));
const prefix = need('url-prefix').replace(/\/?$/, '/');
const release = typeof args.release === 'string' ? args.release.trim() : '';
if (args.release === true || release.length > 200) { console.error('--release needs a value (at most 200 characters)'); process.exit(2); }
const key = process.env.PA_PERSONAL_API_KEY || (typeof args.key === 'string' ? args.key : '');
if (!key && !args['dry-run']) { console.error('set PA_PERSONAL_API_KEY to a personal API key (Account page)'); process.exit(2); }

function* walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') yield* walk(p); } else if (/\.(c|m)?js$/.test(e.name)) yield p;
  }
}
function mapFor(js) {
  const tail = fs.readFileSync(js, 'utf8').slice(-2000);
  const m = /\/\/# sourceMappingURL=([^\s'"]+)\s*$/.exec(tail);
  if (m && !m[1].startsWith('data:') && !/^[a-z]+:\/\//i.test(m[1])) { const p = path.resolve(path.dirname(js), decodeURIComponent(m[1])); if (fs.existsSync(p)) return p; }
  return fs.existsSync(js + '.map') ? js + '.map' : null;
}
let ok = 0, failed = 0;
for (const js of walk(dir)) {
  const map = mapFor(js); if (!map) continue;
  const url = prefix + path.relative(dir, js).split(path.sep).map(encodeURIComponent).join('/');
  if (args['dry-run']) { console.log(`would upload ${path.relative(process.cwd(), map)} for ${url}${release ? ` (release ${release})` : ''}`); ok++; continue; }
  const res = await fetch(`${host}/api/projects/${encodeURIComponent(project)}/symbol_sets?url=${encodeURIComponent(url)}${release ? `&release=${encodeURIComponent(release)}` : ''}`, {
    method: 'PUT', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: fs.readFileSync(map),
  });
  const body = await res.text();
  if (res.ok) { ok++; const b = JSON.parse(body); console.log(`uploaded ${url}${release ? ` @ ${release}` : ''}${b.replaced ? ' (replaced)' : ''}${b.resymbolicated?.symbolicated ? `, re-symbolicated ${b.resymbolicated.symbolicated} recent exception(s)` : ''}`); }
  else { failed++; console.error(`failed ${url}: HTTP ${res.status} ${body.slice(0, 300)}`); }
}
console.log(`${ok} source map(s) ${args['dry-run'] ? 'found' : 'uploaded'}${failed ? `, ${failed} failed` : ''}`);
process.exit(failed ? 1 : 0);
