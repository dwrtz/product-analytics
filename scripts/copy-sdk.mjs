// Copies the posthog-js browser bundles into public/static so the snippet and lazy-loaded extensions load from this instance.
import fs from 'node:fs';
const src = 'node_modules/posthog-js/dist';
// Every browser bundle: posthog-js lazy-loads extensions (surveys.js, etc.) even when the feature is off in remote config.
const want = fs.readdirSync(src).filter((f) => f.endsWith('.js'));
fs.mkdirSync('public/static', { recursive: true });
let n = 0;
for (const f of want) if (fs.existsSync(`${src}/${f}`)) { fs.copyFileSync(`${src}/${f}`, `public/static/${f}`); n++; }
fs.copyFileSync('node_modules/posthog-js/LICENSE', 'public/static/posthog-js.LICENSE.txt');
const v = JSON.parse(fs.readFileSync('node_modules/posthog-js/package.json', 'utf8')).version;
fs.writeFileSync('public/static/VERSION.txt', `posthog-js ${v}\n`);
console.log(`sdk: copied ${n} files from posthog-js ${v}`);
