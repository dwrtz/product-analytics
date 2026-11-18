// Screenshots of the 0.2 screens. Usage: node scripts/shots-02.mjs <site> <email> <password> <projectId> <outDir>
import { chromium } from 'playwright';
const [site, email, password, pid, out] = process.argv.slice(2);
const b = await chromium.launch();
const desk = await b.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 1 });
const lp = await desk.newPage(); await lp.goto(site + '/login'); await lp.fill('input[type=email]', email); await lp.fill('input[type=password]', password); await lp.click('button[type=submit]'); await lp.waitForURL(/project/); await lp.close();
const shoot = async (path, file, wait = 1200, act, full = false) => {
  const p = await desk.newPage(); await p.goto(site + path); await p.waitForLoadState('networkidle'); if (act) await act(p); await p.waitForTimeout(wait);
  await p.screenshot({ path: `${out}/${file}`, fullPage: full }); await p.close(); console.log('shot', file);
};
const get = async (path) => (await desk.request.get(`${site}/api/projects/${pid}${path}`)).json();
const recs = (await get('/session_recordings')).results;
const rec = recs.find(r => r.person) ?? recs[0];
const exps = await get('/experiments'); const surveys = await get('/surveys');
await shoot(`/project/${pid}/replay`, 'replay-list.png');
await shoot(`/project/${pid}/replay/${encodeURIComponent(rec.id)}`, 'replay-player.png', 1500, async (p) => {
  await p.waitForSelector('.rr-player iframe', { timeout: 15000 });
  await p.locator('.rr-controller__btns button').first().click().catch(() => {}); await p.waitForTimeout(3500);
  await p.locator('.rr-controller__btns button').first().click().catch(() => {});
});
await shoot(`/project/${pid}/persons/${rec.person.id}`, 'person-recordings.png');
await shoot(`/project/${pid}/events`, 'events-replay-link.png', 800);
await shoot(`/project/${pid}/experiments`, 'experiments.png');
await shoot(`/project/${pid}/experiments/${exps[0].id}`, 'experiment-results.png', 1500, null, true);
await shoot(`/project/${pid}/experiments/new`, 'experiment-new.png');
await shoot(`/project/${pid}/surveys`, 'surveys.png');
await shoot(`/project/${pid}/surveys/${surveys[0].id}`, 'survey-results.png', 1500, null, true);
await shoot(`/project/${pid}/surveys/${surveys[0].id}/edit`, 'survey-edit.png', 800, null, true);
await shoot(`/project/${pid}/settings`, 'settings-replay.png', 800, async (p) => { await p.locator('text=Record sessions').scrollIntoViewIfNeeded(); });
const st = await desk.storageState();
const mob = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, storageState: st });
const mp = await mob.newPage(); await mp.goto(`${site}/project/${pid}/experiments/${exps[0].id}`); await mp.waitForLoadState('networkidle'); await mp.waitForTimeout(1500); await mp.screenshot({ path: `${out}/experiment-mobile.png` }); console.log('shot experiment-mobile.png');
await mp.goto(`${site}/project/${pid}/surveys/${surveys[0].id}`); await mp.waitForLoadState('networkidle'); await mp.waitForTimeout(1500); await mp.screenshot({ path: `${out}/survey-mobile.png` }); console.log('shot survey-mobile.png');
await b.close();
