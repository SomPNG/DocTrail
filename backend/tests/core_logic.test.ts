// Pure-logic unit tests (no database): SLA maths, checklist gate, audit seals, access policy,
// compensation, diagnosis rules, templates, simulation distributions and calibration.
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { SlaService } from '../src/modules/sla/sla.service.js';
import { ChecklistGate } from '../src/common/checklist.js';
import { SecurityEngine, stableStringify } from '../src/common/security.js';
import { DiagnosisService } from '../src/modules/diagnosis/diagnosis.service.js';
import { renderTemplate } from '../src/modules/notifications/notification.templates.js';
import { Rng } from '../src/modules/simulation/rng.js';
import { profileFor, SCENARIOS } from '../src/modules/simulation/scenarios.js';
import { STORIES } from '../src/modules/simulation/stories.js';
import { CompensationService } from '../src/modules/compensation/compensation.service.js';
import { trackingPrefixForService, percentile } from '../src/common/utils.js';
import { ServiceConfig } from '../src/config/serviceConfig.js';
import { GUN_LICENSE_CONFIG } from '../src/config/workflowConfig.js';
import { AccessPolicy } from '../src/common/access.js';


describe('Core logic (no database)', () => {
  it('passes all pure-logic checks', () => {
    const H = 3600 * 1000;
    let n = 0;
    const ok = (name: string) => console.log(`  ✓ ${++n}. ${name}`);

    // --- SLA maths (same cases as tests/sla.test.ts) + overdue
    const stage = { stageKey: 'p', name: 'Police', slaHours: 24, slaDays: 1 };
    const t0 = new Date('2026-01-01T00:00:00Z');
    const base = { id: 'i', stage, completedAt: null, totalPausedSeconds: 0, slaDeadline: null, status: 'ACTIVE' };
    let r = SlaService.calculateStageSla({ ...base, startedAt: t0, pausedAt: null }, new Date(t0.getTime() + 20 * H));
    assert.equal(r.status, 'AT_RISK');
    r = SlaService.calculateStageSla({ ...base, startedAt: t0, pausedAt: null }, new Date(t0.getTime() + 25 * H));
    assert.equal(r.status, 'BREACHED'); assert.equal(r.overdueSeconds, 3600);
    r = SlaService.calculateStageSla({ ...base, startedAt: t0, pausedAt: new Date(t0.getTime() + 2 * H) }, new Date(t0.getTime() + 12 * H));
    assert.equal(r.status, 'PAUSED'); assert.equal(r.elapsedActiveSeconds, 7200); assert.equal(r.pausedSeconds, 36000);
    ok('SLA: at-risk, breached (+overdue), paused excludes pause time');

    // --- Checklist gate: no wildcard bypass any more
    const cl = JSON.stringify(GUN_LICENSE_CONFIG.stages[0].checklists);
    assert.throws(() => ChecklistGate.assertComplete(cl, { '*': true } as any, 'advance'), /unverified/);
    assert.throws(() => ChecklistGate.assertComplete(cl, { all: true } as any, 'advance'), /unverified/);
    assert.throws(() => ChecklistGate.assertComplete(cl, undefined, 'advance'), /verification checks/);
    assert.doesNotThrow(() => ChecklistGate.assertComplete(cl, ChecklistGate.allIds(cl), 'advance'));
    assert.doesNotThrow(() => ChecklistGate.assertComplete(JSON.stringify(['a', 'b']), ['check_0', 'check_1'], 'x'));
    ok('Checklist: wildcard {"*":true}/{all:true} rejected; full id list accepted; string checklists supported');

    // --- Hash chain: payload is fully covered (old replacer bug dropped nested keys)
    const a = SecurityEngine.computeChainHash('0', { payload: { reason: 'A', nested: { x: 1 } } });
    const b = SecurityEngine.computeChainHash('0', { payload: { reason: 'B', nested: { x: 1 } } });
    const c = SecurityEngine.computeChainHash('0', { payload: { nested: { x: 1 }, reason: 'A' } });
    assert.notEqual(a, b); assert.equal(a, c);
    const legacy = (p: any) => JSON.stringify(p, Object.keys(p).sort());
    assert.equal(legacy({ userPayload: { reason: 'A' } }), legacy({ userPayload: { reason: 'B' } })); // the old bug
    assert.equal(stableStringify({ d: new Date(0), u: undefined, arr: [1, { z: 1, a: 2 }] }), '{"arr":[1,{"a":2,"z":1}],"d":"1970-01-01T00:00:00.000Z"}');
    ok('Audit seal: nested payload changes alter the hash (legacy sealing ignored them); key order irrelevant');

    // --- PII masking
    assert.equal(SecurityEngine.maskPii('+91 98765 43210'), '+91 XXXXX-43210');
    assert.equal(SecurityEngine.maskPii('9876543210'), '+91 XXXXX-43210');
    assert.equal(SecurityEngine.maskPii('1234 5678 9012'), 'XXXX-XXXX-9012');
    assert.equal(SecurityEngine.maskName('Aarav Sharma'), 'A**** S*****');
    assert.equal(SecurityEngine.maskEmail('aarav@example.com'), 'aa****@example.com');
    const tok = SecurityEngine.generateExpiringFileToken('/uploads/x.pdf', 60);
    assert.equal(SecurityEngine.verifyExpiringFileToken(tok).valid, true);
    const forged = JSON.parse(Buffer.from(tok, 'base64url').toString()); forged.sig = 'abcd';
    assert.equal(SecurityEngine.verifyExpiringFileToken(Buffer.from(JSON.stringify(forged)).toString('base64url')).valid, false);
    ok('PII masking + signed file tokens (short forged signature no longer throws in timingSafeEqual)');

    // --- Access policy
    const app = { citizenId: 'c1', service: { stages: [{ departmentCode: 'DM_OFFICE' }, { departmentCode: 'POLICE_DEPT' }] } };
    const u = (role: any, dept?: string, id = 'x') => ({ id, email: '', name: '', role, departmentCode: dept });
    assert.equal(AccessPolicy.canView(u('CITIZEN', undefined, 'c1'), app), true);
    assert.equal(AccessPolicy.canView(u('CITIZEN', undefined, 'c2'), app), false);
    assert.equal(AccessPolicy.canView(u('OFFICER', 'POLICE_DEPT'), app), true);
    assert.equal(AccessPolicy.canView(u('OFFICER', 'PASSPORT_OFFICE'), app), false);
    assert.equal(AccessPolicy.canView(u('OFFICER'), app), false);
    assert.throws(() => AccessPolicy.assertCanActOnStage(u('OFFICER'), 'DM_OFFICE'), /not linked/);
    assert.throws(() => AccessPolicy.assertCanActOnStage(u('OFFICER', 'SP_OFFICE'), 'DM_OFFICE'), /Only officers from DM_OFFICE/);
    assert.doesNotThrow(() => AccessPolicy.assertCanActOnStage(u('SUPERVISOR'), 'DM_OFFICE'));
    ok('Access policy: own-only citizens, department-scoped officers, no-dept officers blocked');

    // --- Service config reads BOTH config shapes (old bug: registered services had no required docs)
    const regDocs = ServiceConfig.requiredDocuments(JSON.stringify(GUN_LICENSE_CONFIG), 'dm_verification');
    assert.deepEqual(regDocs.map(d => d.documentType), ['identity_proof', 'address_proof']);
    assert.equal(ServiceConfig.compensationRatePerDay(JSON.stringify(GUN_LICENSE_CONFIG)), 250);
    assert.equal(ServiceConfig.compensationRatePerDay(JSON.stringify({ compensationPerDay: 300 })), 300);
    ok('ServiceConfig: required docs + per-service compensation rate from either config shape');

    // --- Compensation: per-stage overruns, fast stages don't cancel slow ones, completed pause not double counted
    const now = new Date(t0.getTime() + 400 * H);
    const est = CompensationService.estimate(
      [
        { startedAt: t0, completedAt: new Date(t0.getTime() + 2 * H), pausedAt: null, totalPausedSeconds: 0, status: 'COMPLETED', stage: { name: 'DM', slaHours: 24 } },
        { startedAt: new Date(t0.getTime() + 2 * H), completedAt: null, pausedAt: null, totalPausedSeconds: 0, status: 'ACTIVE', stage: { name: 'Police', slaHours: 240 } },
      ],
      JSON.stringify(GUN_LICENSE_CONFIG),
      now
    );
    assert.equal(est.isEligible, true); assert.equal(Math.round(est.breachDurationSeconds / 3600), 158); assert.equal(est.breachDays, 7); assert.equal(est.estimatedCompensationAmount, 7 * 250);
    const est2 = CompensationService.estimate(
      [{ startedAt: t0, completedAt: new Date(t0.getTime() + 10 * H), pausedAt: new Date(t0.getTime() + 5 * H), totalPausedSeconds: 0, status: 'COMPLETED', stage: { name: 'DM', slaHours: 24 } }],
      '{}', now);
    assert.equal(est2.isEligible, false);
    ok('Compensation: stage overrun 158h -> 7 days x Rs.250; stale pausedAt on a completed stage ignored');

    // --- Diagnosis engine
    const dmStage = { id: 's1', name: 'DM Verification', departmentCode: 'DM_OFFICE', slaHours: 24, stageKey: 'dm', slaDays: 1, department: { name: 'District Magistrate Office' } };
    const polStage = { id: 's2', name: 'Police Verification', departmentCode: 'POLICE_DEPT', slaHours: 240, stageKey: 'pol', slaDays: 10, department: { name: 'Police Department' } };
    const mkApp = (inst: any) => ({
      id: 'a1', trackingNumber: 'GL-2026-000001', status: inst.pausedAt ? 'ON_HOLD' : 'IN_PROGRESS', slaStatus: 'ON_TRACK',
      service: { name: 'Gun License', stages: [dmStage, polStage] },
      stageInstances: [
        { stageId: 's1', status: 'COMPLETED', startedAt: t0, completedAt: new Date(t0.getTime() + 10 * H), pausedAt: null, totalPausedSeconds: 0, stage: dmStage, documentRequests: [] },
        { id: 'i2', stageId: 's2', status: 'ACTIVE', startedAt: new Date(t0.getTime() + 10 * H), completedAt: null, totalPausedSeconds: 0, slaDeadline: null, stage: polStage, documentRequests: [], ...inst },
      ],
    });
    const q = (ahead: number, tput: number) => new Map([['POLICE_DEPT', { departmentCode: 'POLICE_DEPT', activeCount: ahead + 1, waitingCount: ahead + 1, pausedCount: 0, queueOrder: [...Array(ahead).keys()].map(k => `x${k}`).concat('i2'), completedLast7Days: tput * 7, throughputPerDay: tput }]]);

    let d: any = DiagnosisService.diagnose(mkApp({ pausedAt: new Date(t0.getTime() + 20 * H), holdType: 'CITIZEN_DOCS', documentRequests: [{ status: 'PENDING', title: 'Address proof', documentType: 'address_proof', requestedAt: new Date(t0.getTime() + 20 * H) }] }), q(0, 2), new Date(t0.getTime() + 80 * H));
    assert.equal(d.reasonCode, 'WAITING_ON_CITIZEN'); assert.equal(d.responsibleParty, 'CITIZEN'); assert.match(d.citizenMessage, /Address proof/);
    d = DiagnosisService.diagnose(mkApp({ pausedAt: null, assignedOfficerId: 'o1', lastActivityAt: new Date(t0.getTime() + 30 * H) }), q(0, 2), new Date(t0.getTime() + 270 * H));
    assert.equal(d.reasonCode, 'OFFICER_IDLE'); assert.equal(d.severity, 'CRITICAL'); assert.equal(d.timing.overdueHours, 20);
    d = DiagnosisService.diagnose(mkApp({ pausedAt: null, assignedOfficerId: null, lastActivityAt: new Date(t0.getTime() + 10 * H) }), q(25, 1), new Date(t0.getTime() + 230 * H));
    assert.equal(d.reasonCode, 'DEPARTMENT_BACKLOG'); assert.equal(d.queue.position, 26); assert.match(d.citizenMessage, /25 file\(s\) are ahead/);
    d = DiagnosisService.diagnose(mkApp({ pausedAt: null, assignedOfficerId: null, lastActivityAt: new Date(t0.getTime() + 10 * H) }), q(0, 3), new Date(t0.getTime() + 70 * H));
    assert.equal(d.reasonCode, 'UNASSIGNED');
    d = DiagnosisService.diagnose(mkApp({ pausedAt: null, assignedOfficerId: 'o1', lastActivityAt: new Date(t0.getTime() + 60 * H) }), q(0, 3), new Date(t0.getTime() + 70 * H));
    assert.equal(d.reasonCode, 'IN_REVIEW'); assert.equal(d.isStuck, false);
    assert.deepEqual(d.pipeline.map((p: any) => p.state), ['DONE', 'CURRENT']);
    const cit = DiagnosisService.diagnose(mkApp({ pausedAt: null, assignedOfficerId: 'o1', assignedOfficer: { name: 'Insp. X' } }), q(0, 3), new Date(t0.getTime() + 70 * H), 'CITIZEN');
    assert.equal(cit.location?.assignedOfficer, undefined); assert.equal((cit as any).officerMessage, undefined);
    ok('Diagnosis: WAITING_ON_CITIZEN / OFFICER_IDLE (critical, 20h overdue) / DEPARTMENT_BACKLOG (pos 26) / UNASSIGNED / IN_REVIEW; citizen view hides officer');

    // --- Plain-language templates
    const t = renderTemplate('DOCUMENT_NEEDED', { trackingNumber: 'GL-2026-000001', departmentName: 'Police Department', documentTitle: 'Address proof', reason: 'residence check' });
    assert.ok(t.sms.length <= 160); assert.match(t.message, /Police Department needs "Address proof"/);
    ok('Templates: plain language, SMS <= 160 chars');

    // --- RNG / distributions
    const rng = new Rng(42);
    const xs = Array.from({ length: 20000 }, () => rng.lognormal(60, 160));
    const med = percentile(xs, 50), p90 = percentile(xs, 90);
    assert.ok(Math.abs(med - 60) / 60 < 0.06, `median ${med}`); assert.ok(Math.abs(p90 - 160) / 160 < 0.08, `p90 ${p90}`);
    const pois = Array.from({ length: 20000 }, () => rng.poisson(0.5)); const mean = pois.reduce((s, v) => s + v, 0) / pois.length;
    assert.ok(Math.abs(mean - 0.5) < 0.03);
    const r1 = new Rng(7), r2 = Rng.fromState(new Rng(7).getState());
    assert.equal(r1.next(), r2.next());
    ok(`RNG: log-normal median ${med.toFixed(1)}h (target 60), p90 ${p90.toFixed(1)}h (target 160); Poisson mean ${mean.toFixed(3)}; reproducible from state`);

    // --- Queue model sanity: police_backlog really overloads Police
    const pol = profileFor('POLICE_DEPT');
    const meanService = Math.exp(Math.log(pol.medianHours) + ((Math.log(pol.p90Hours) - Math.log(pol.medianHours)) / 1.2816) ** 2 / 2) + pol.pickupDelayHours;
    const capPerDayNormal = (pol.officers * pol.parallelFilesPerOfficer * 24) / meanService;
    const capPerDayDisrupted = (Math.round(pol.officers * 0.25) * pol.parallelFilesPerOfficer * 24) / meanService;
    const arrivals = SCENARIOS.police_backlog.arrivalsPerDay.gun_license + SCENARIOS.police_backlog.arrivalsPerDay.passport_reissue;
    assert.ok(capPerDayDisrupted < arrivals);
    // every department must be stable (rho < 1) in the normal week
    const nw = SCENARIOS.normal_week.arrivalsPerDay;
    const load: Record<string, number> = { DM_OFFICE: 2 * nw.gun_license, POLICE_DEPT: nw.gun_license + nw.passport_reissue, SP_OFFICE: nw.gun_license, PASSPORT_OFFICE: 2 * nw.passport_reissue, MUNICIPAL_CORP: 2 * nw.trade_license, HEALTH_DEPT: nw.trade_license };
    const rhos: string[] = [];
    for (const [dept, arr] of Object.entries(load)) {
      const p = profileFor(dept); const sig = (Math.log(p.p90Hours) - Math.log(p.medianHours)) / 1.2816;
      const ms = p.medianHours * Math.exp(sig * sig / 2) + p.pickupDelayHours;
      const rho = arr / ((p.officers * p.parallelFilesPerOfficer * 24) / ms);
      assert.ok(rho < 0.9, `${dept} rho ${rho}`); rhos.push(`${dept} ${rho.toFixed(2)}`);
    }
    console.log('    normal_week utilisation:', rhos.join(', '));
    ok(`Scenario police_backlog: Police capacity ${capPerDayNormal.toFixed(2)}/day -> ${capPerDayDisrupted.toFixed(2)}/day vs ${arrivals} arrivals/day (queue must grow)`);

    // --- Story timings produce the intended SLA states
    const story = STORIES.stuck_at_police.steps; let tt = 0; const at: number[] = [];
    for (const s of story) { tt += s.afterHours; at.push(tt); }
    const policeStart = at[2];
    const pauseStart = at[4], pauseEnd = at[5];
    const activeAt = (k: number) => at[k] - policeStart - (pauseEnd - pauseStart);
    assert.ok(activeAt(6) < 0.8 * 240 && activeAt(7) >= 0.8 * 240 && activeAt(7) <= 240 && activeAt(8) > 240,
      `police active hours: ${activeAt(6)}, ${activeAt(7)}, ${activeAt(8)}`);
    ok(`Story stuck_at_police: Police active ${activeAt(6)}h (ON_TRACK) -> ${activeAt(7)}h (AT_RISK) -> ${activeAt(8)}h (BREACHED)`);

    assert.equal(trackingPrefixForService('gun_license'), 'GL'); assert.equal(trackingPrefixForService('x', 'pp'), 'PP');
    ok('Tracking prefixes');

  });
});
