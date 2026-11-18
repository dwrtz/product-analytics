// Sends 30 days of made-up traffic to a project through the public /batch endpoint (for demos and screenshots).
// Usage: node scripts/seed-demo.mjs <api_host> <project_token> [users]
const [host, token, nUsers = '400'] = process.argv.slice(2);
if (!host || !token) { console.error('usage: node scripts/seed-demo.mjs <api_host> <project_token> [users]'); process.exit(2); }
let seed = 42; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const DAY = 86400_000, now = Date.now();
const browsers = ['Chrome', 'Chrome', 'Chrome', 'Safari', 'Safari', 'Firefox', 'Edge'];
const countries = [['US', 'United States'], ['IN', 'India'], ['DE', 'Germany'], ['GB', 'United Kingdom'], ['BR', 'Brazil']];
const paths = ['/', '/', '/pricing', '/docs', '/blog/launch', '/features'];
const events = [];
for (let u = 0; u < Number(nUsers); u++) {
  const anon = `anon-${u}-${Math.floor(rnd() * 1e9).toString(36)}`;
  const browser = pick(browsers), [cc, cn] = pick(countries), session0 = Math.floor(rnd() * 1e9).toString(36);
  const first = now - Math.floor(rnd() * 58 * DAY) - 3600_000;
  const base = { $browser: browser, $os: browser === 'Safari' ? 'Mac OS X' : pick(['Windows', 'Mac OS X', 'Linux']), $lib: 'web', $geoip_country_code: cc, $geoip_country_name: cn, $device_type: rnd() < 0.3 ? 'Mobile' : 'Desktop' };
  let t = first, did = anon, identified = false;
  const visits = 1 + Math.floor(rnd() * rnd() * 8);
  for (let v = 0; v < visits && t < now; v++) {
    const sid = `${session0}-${v}`;
    const pages = 1 + Math.floor(rnd() * 4);
    for (let p = 0; p < pages; p++) {
      const path = p === 0 ? '/' : pick(paths);
      events.push({ event: '$pageview', distinct_id: did, timestamp: new Date(t).toISOString(), properties: { ...base, $current_url: `https://shop.example${path}`, $pathname: path, $session_id: sid, $process_person_profile: identified } });
      t += 20_000 + rnd() * 90_000;
    }
    if (!identified && rnd() < 0.45) {
      events.push({ event: 'signed_up', distinct_id: did, timestamp: new Date(t).toISOString(), properties: { ...base, plan: rnd() < 0.7 ? 'free' : 'pro', $session_id: sid, $process_person_profile: false } });
      t += 5_000;
      const user = `user-${u}@example.com`;
      events.push({ event: '$identify', distinct_id: user, timestamp: new Date(t).toISOString(), properties: { ...base, $anon_distinct_id: anon, $session_id: sid }, $set: { email: user, plan: rnd() < 0.7 ? 'free' : 'pro' }, $set_once: { first_country: cn } });
      did = user; identified = true; t += 5_000;
    }
    if (identified && rnd() < 0.35) {
      events.push({ event: 'purchase', distinct_id: did, timestamp: new Date(t).toISOString(), properties: { ...base, amount: Math.round(10 + rnd() * 140), currency: 'USD', $session_id: sid } });
    }
    t += DAY * (0.5 + rnd() * 4);
  }
}
events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
let sent = 0;
for (let i = 0; i < events.length; i += 500) {
  const batch = events.slice(i, i + 500).map(e => ({ ...e, uuid: crypto.randomUUID() }));
  const r = await fetch(`${host.replace(/\/$/, '')}/batch/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: token, historical_migration: true, batch }) });
  if (!r.ok) { console.error('batch failed', r.status, await r.text()); process.exit(1); }
  sent += batch.length;
}
console.log(`seeded ${sent} events for ${nUsers} visitors`);
