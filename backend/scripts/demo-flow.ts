/**
 * DocTrail live demo (server must be running: npm run dev)
 *
 * Plays the "stuck_at_police" story step by step on the virtual clock and prints, after every
 * step, WHERE the application is and WHY - exactly what the citizen and officer views show.
 * Then shows the citizen tracking view, the mocked SMS/WhatsApp outbox and the bottleneck board.
 *
 *   npm run demo                # story only
 *   npm run demo -- --scenario  # also run the police_backlog scenario for 7 virtual days
 */
const BASE_URL = process.env.DOCTRAIL_URL || 'http://localhost:4000/api';

async function api(path: string, options: RequestInit = {}, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...((options.headers as Record<string, string>) || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  const data: any = await res.json();
  if (!res.ok) throw new Error(`API Error [${res.status}] ${path}: ${data.message || JSON.stringify(data)}`);
  return data.data;
}

const login = async (email: string) =>
  (await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'Password123!' }) })).token as string;

async function run() {
  console.log('\n=== DocTrail: where is the application stuck, and why? ===\n');
  const supervisor = await login('supervisor@example.com');
  const citizen = await login('citizen@example.com');

  await api('/sim/reset', { method: 'POST' }, supervisor);
  let step = await api('/sim/stories/stuck_at_police/start', { method: 'POST' }, supervisor);

  for (;;) {
    const s = step.snapshot;
    const clock = new Date(step.clock.now).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
    console.log(`[${step.stepIndex + 1}/${step.totalSteps}] ${clock}  (+${step.clock.offsetHours}h virtual)`);
    console.log(`   ${step.narration}`);
    if (s) {
      console.log(`   WHERE: ${s.where}   SLA: ${s.slaStatus}   active ${s.activeHours}h / target ${s.targetHours}h${s.overdueHours ? `   OVERDUE ${s.overdueHours}h` : ''}`);
      console.log(`   WHY:   ${s.reason} (${s.reasonCode}, severity ${s.severity})`);
      console.log(`   Citizen sees: "${s.citizenMessage}"`);
      if (s.officerMessage) console.log(`   Officer sees: "${s.officerMessage}"`);
    }
    console.log('');
    if (step.done) break;
    step = await api('/sim/stories/next', { method: 'POST' }, supervisor);
  }

  const tracking = await api(`/applications/${step.applicationId}/tracking`, {}, citizen);
  console.log(`--- Citizen tracking view for ${tracking.trackingNumber} ---`);
  tracking.pipeline.forEach((p: any) =>
    console.log(`   ${p.state.padEnd(8)} ${p.stageName.padEnd(28)} ${p.departmentName.padEnd(32)} ${p.activeHours}h / ${p.targetHours}h${p.breached ? '  BREACHED' : ''}`)
  );
  tracking.timeline.forEach((t: any) => console.log(`   ${new Date(t.at).toISOString().slice(0, 16)}  ${t.text}`));

  const outbox = await api(`/notifications/outbox?applicationId=${step.applicationId}&channel=SMS`, {}, supervisor);
  console.log(`\n--- Mock SMS sent to the citizen (${outbox.length}) ---`);
  outbox.slice().reverse().forEach((m: any) => console.log(`   -> ${m.destination}: ${m.body}`));

  if (process.argv.includes('--scenario')) {
    console.log('\n--- Running police_backlog scenario for 7 virtual days ---');
    const r = await api('/sim/scenarios/police_backlog/run', { method: 'POST', body: JSON.stringify({ days: 7, seed: 7 }) }, supervisor);
    console.log(`   created ${r.stats.created}, completed ${r.stats.completed}, stuck ${r.stuck.count} ${JSON.stringify(r.stuck.byReason)}`);
    r.topBottlenecks.forEach((b: any) => console.log(`   ${String(b.score).padStart(3)}  ${b.stage} @ ${b.department}  - ${b.explanation}`));
  }

  await api('/sim/clock/reset', { method: 'POST' }, supervisor);
  console.log('\nClock reset to real time. Done.\n');
}

run().catch(err => {
  console.error('\nDemo failed:', err.message);
  process.exit(1);
});
