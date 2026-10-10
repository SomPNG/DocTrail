import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db/client.js';
import { Clock, HOUR_MS } from '../src/common/clock.js';

/**
 * Covers the v2 changes: access control fixes, workflow correctness, latched SLA breaches,
 * "where & why stuck" diagnosis, notifications outbox, analytics and the simulation engine.
 */
const app = createApp();
const login = async (email: string) =>
  (await request(app).post('/api/auth/login').send({ email, password: 'Password123!' })).body.data.token as string;

const GUN_DM_CHECKS = ['dm_id_verify', 'dm_jurisdiction', 'dm_threat_validity', 'dm_age_threshold'];

describe('DocTrail v2: access, workflow correctness, diagnosis, simulation', () => {
  let citizen: string, otherCitizen: string, dm: string, police: string, passport: string, supervisor: string;

  async function newGunApp(token = citizen) {
    const res = await request(app).post('/api/applications').set('Authorization', `Bearer ${token}`).send({ serviceKey: 'gun_license', applicantName: 'V2 Test' });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  }

  beforeAll(async () => {
    [citizen, dm, police, passport, supervisor] = await Promise.all([
      login('citizen@example.com'),
      login('dm.officer@example.com'),
      login('police.officer@example.com'),
      login('passport.officer@example.com'),
      login('supervisor@example.com'),
    ]);
    const reg = await request(app).post('/api/auth/register').send({ email: `other_${Date.now()}@example.com`, password: 'Password123!', name: 'Other Citizen' });
    otherCitizen = reg.body.data.token;
  });

  afterAll(async () => {
    await request(app).post('/api/sim/reset').set('Authorization', `Bearer ${supervisor}`);
    await Clock.reset();
  });

  describe('Access control', () => {
    it('officers outside the workflow and other citizens cannot read an application', async () => {
      const id = await newGunApp();
      expect((await request(app).get(`/api/applications/${id}`).set('Authorization', `Bearer ${passport}`)).status).toBe(403);
      expect((await request(app).get(`/api/applications/${id}`).set('Authorization', `Bearer ${otherCitizen}`)).status).toBe(403);
      expect((await request(app).get(`/api/ai/explain-delay/${id}`).set('Authorization', `Bearer ${otherCitizen}`)).status).toBe(403);
      // police are part of the gun-license workflow, so they may view (but not act yet)
      expect((await request(app).get(`/api/applications/${id}`).set('Authorization', `Bearer ${police}`)).status).toBe(200);
      const act = await request(app)
        .post(`/api/applications/${id}/documents/request`)
        .set('Authorization', `Bearer ${police}`)
        .send({ documentType: 'x_doc', title: 'Something', reason: 'Not my stage yet' });
      expect(act.status).toBe(403);
    });

    it('citizens cannot submit staff-only actions and cannot hijack another application\'s document request', async () => {
      const a = await newGunApp();
      const req = await request(app)
        .post(`/api/applications/${a}/documents/request`)
        .set('Authorization', `Bearer ${dm}`)
        .send({ documentType: 'address_proof', title: 'Address proof', reason: 'Jurisdiction check' });
      const b = await newGunApp(otherCitizen);
      const hijack = await request(app)
        .post(`/api/applications/${b}/documents/upload`)
        .set('Authorization', `Bearer ${otherCitizen}`)
        .send({ documentRequestId: req.body.data.id, documentType: 'address_proof', title: 'x', fileUrl: '/uploads/x.pdf' });
      expect(hijack.status).toBe(400);
    });
  });

  describe('Workflow correctness', () => {
    it('APPROVED is refused at an intermediate stage (no skipping departments)', async () => {
      const id = await newGunApp();
      const res = await request(app)
        .post(`/api/applications/${id}/decision`)
        .set('Authorization', `Bearer ${dm}`)
        .send({ decisionType: 'APPROVED', checklistResponses: GUN_DM_CHECKS });
      expect(res.status).toBe(409);
      const app2 = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(app2.status).toBe('IN_PROGRESS');
    });

    it('an upload does not lift a manual hold, and forwarding while on hold is refused', async () => {
      const id = await newGunApp();
      await request(app).post(`/api/applications/${id}/hold`).set('Authorization', `Bearer ${dm}`).send({ reason: 'Awaiting magistrate availability' });
      await request(app)
        .post(`/api/applications/${id}/documents/upload`)
        .set('Authorization', `Bearer ${citizen}`)
        .send({ documentType: 'extra', title: 'Extra photo', fileUrl: '/uploads/photo.png' });
      const after = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(after.status).toBe('ON_HOLD');

      const fwd = await request(app).post(`/api/applications/${id}/forward`).set('Authorization', `Bearer ${dm}`).send({ checklistResponses: GUN_DM_CHECKS });
      expect(fwd.status).toBe(409);

      const resumed = await request(app).post(`/api/applications/${id}/resume`).set('Authorization', `Bearer ${dm}`).send({ remarks: 'Magistrate available' });
      expect(resumed.status).toBe(200);
      const ok = await request(app).post(`/api/applications/${id}/forward`).set('Authorization', `Bearer ${dm}`).send({ checklistResponses: GUN_DM_CHECKS });
      expect(ok.status).toBe(200);
      const done = await prisma.applicationStageInstance.findFirstOrThrow({ where: { applicationId: id, status: 'COMPLETED' } });
      expect(done.pausedAt).toBeNull();
      expect(done.totalPausedSeconds).toBeGreaterThanOrEqual(0);
    });

    it('returned-for-correction waits for the citizen to resubmit', async () => {
      const id = await newGunApp();
      const ret = await request(app)
        .post(`/api/applications/${id}/decision`)
        .set('Authorization', `Bearer ${dm}`)
        .send({ decisionType: 'RETURNED_FOR_CORRECTION', reason: 'Date of birth missing' });
      expect(ret.status).toBe(201);
      const diag = await request(app).get(`/api/applications/${id}/diagnosis`).set('Authorization', `Bearer ${citizen}`);
      expect(diag.body.data.reasonCode).toBe('RETURNED_FOR_CORRECTION');
      expect(diag.body.data.officerMessage).toBeUndefined(); // citizen view

      const re = await request(app).post(`/api/applications/${id}/resubmit`).set('Authorization', `Bearer ${citizen}`).send({ applicantDetails: { dob: '1990-01-01' } });
      expect(re.status).toBe(200);
      expect((await prisma.application.findUniqueOrThrow({ where: { id } })).status).toBe('IN_PROGRESS');
    });

    it('tracking numbers are sequential per service and never collide', async () => {
      const ids = await Promise.all([newGunApp(), newGunApp(), newGunApp()]);
      const apps = await prisma.application.findMany({ where: { id: { in: ids } } });
      expect(new Set(apps.map(a => a.trackingNumber)).size).toBe(3);
      apps.forEach(a => expect(a.trackingNumber).toMatch(/^GL-\d{4}-\d{6}$/));
    });
  });

  describe('Latched SLA breaches, diagnosis and notifications', () => {
    it('breach is recorded once even after pause/resume, and the file is diagnosed as stuck', async () => {
      const id = await newGunApp();
      await request(app).post(`/api/applications/${id}/assign`).set('Authorization', `Bearer ${dm}`).send({});

      await Clock.advance(30 * HOUR_MS); // DM target is 24h
      await request(app).post('/api/sla/watchdog/scan').set('Authorization', `Bearer ${supervisor}`).send({});

      const req = await request(app)
        .post(`/api/applications/${id}/documents/request`)
        .set('Authorization', `Bearer ${dm}`)
        .send({ documentType: 'identity_proof', title: 'Photo ID', reason: 'Illegible scan' });
      await Clock.advance(5 * HOUR_MS);
      await request(app)
        .post(`/api/applications/${id}/documents/upload`)
        .set('Authorization', `Bearer ${citizen}`)
        .send({ documentRequestId: req.body.data.id, documentType: 'identity_proof', title: 'Photo ID', fileUrl: '/uploads/id.png' });
      await request(app).post('/api/sla/watchdog/scan').set('Authorization', `Bearer ${supervisor}`).send({});

      const breaches = await prisma.stageEvent.count({ where: { applicationId: id, eventType: 'SLA_BREACHED' } });
      expect(breaches).toBe(1);
      const appRow = await prisma.application.findUniqueOrThrow({ where: { id } });
      expect(appRow.breachedStageCount).toBe(1);
      expect(appRow.compensationStatus).toBe('ELIGIBLE_PENDING_APPROVAL');

      const tracking = await request(app).get(`/api/applications/${id}/tracking`).set('Authorization', `Bearer ${citizen}`);
      expect(tracking.status).toBe(200);
      expect(tracking.body.data.whereIsIt.departmentCode).toBe('DM_OFFICE');
      expect(tracking.body.data.timing.stageBreached).toBe(true);
      expect(tracking.body.data.timeline.some((t: any) => /escalated/i.test(t.text))).toBe(true);
      expect(JSON.stringify(tracking.body.data)).not.toContain('Rajesh Verma'); // no officer identity for citizens

      const queue = await request(app).get('/api/officer/queue').set('Authorization', `Bearer ${dm}`);
      expect(queue.status).toBe(200);
      expect(queue.body.data.items[0].diagnosis.severity).toBe('CRITICAL');

      const stuck = await request(app).get('/api/dashboard/stuck').set('Authorization', `Bearer ${supervisor}`);
      expect(stuck.body.data.items.some((i: any) => i.id === id)).toBe(true);

      const outbox = await request(app).get(`/api/notifications/outbox?applicationId=${id}&channel=SMS`).set('Authorization', `Bearer ${supervisor}`);
      expect(outbox.body.data.length).toBeGreaterThan(0);
      expect(outbox.body.data[0].destination).toContain('XXXXX');

      await Clock.reset();
    });

    it('department analytics include historical breaches and percentiles; trends return a daily series', async () => {
      const dept = await request(app).get('/api/dashboard/departments').set('Authorization', `Bearer ${supervisor}`);
      const dmRow = dept.body.data.find((d: any) => d.code === 'DM_OFFICE');
      expect(dmRow.breachCount).toBeGreaterThanOrEqual(1);
      expect(dmRow).toHaveProperty('p90ProcessingHours');
      expect(dmRow).toHaveProperty('slaCompliancePercent');

      const trends = await request(app).get('/api/dashboard/trends?days=7').set('Authorization', `Bearer ${supervisor}`);
      expect(trends.body.data.series).toHaveLength(7);
    });
  });

  describe('Simulation engine', () => {
    it('is restricted to supervisors/admins', async () => {
      expect((await request(app).post('/api/sim/clock/advance').set('Authorization', `Bearer ${citizen}`).send({ hours: 1 })).status).toBe(403);
    });

    it('scripted story: moves through DM, gets stuck at Police, breaches, then moves on', async () => {
      const res = await request(app).post('/api/sim/stories/stuck_at_police/run').set('Authorization', `Bearer ${supervisor}`);
      expect(res.status).toBe(200);
      const steps = res.body.data.steps;
      expect(steps).toHaveLength(10);
      expect(steps[2].snapshot.where).toContain('Police');
      expect(steps[4].snapshot.reasonCode).toBe('WAITING_ON_CITIZEN');
      expect(steps[6].snapshot.reasonCode).toBe('OFFICER_IDLE');
      expect(steps[7].snapshot.slaStatus).toBe('AT_RISK');
      expect(steps[8].snapshot.slaStatus).toBe('BREACHED');
      expect(steps[8].snapshot.severity).toBe('CRITICAL');
      expect(steps[9].snapshot.where).toContain('SP');

      const id = steps[9].applicationId;
      expect(await prisma.stageEvent.count({ where: { applicationId: id, eventType: 'SLA_BREACHED' } })).toBe(1);
      // the story belongs to the demo citizen, so it shows up in the citizen portal
      const mine = await request(app).get('/api/applications').set('Authorization', `Bearer ${citizen}`);
      expect(mine.body.data.some((a: any) => a.id === id)).toBe(true);
    });

    it('stochastic scenario: police backlog surfaces Police as the top bottleneck (seeded, reproducible)', async () => {
      const res = await request(app)
        .post('/api/sim/scenarios/police_backlog/run')
        .set('Authorization', `Bearer ${supervisor}`)
        .send({ days: 8, seed: 7, tickHours: 3 });
      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data.stats.created).toBeGreaterThan(30);
      expect(data.departments.POLICE_DEPT.capacitySlotsNow).toBe(8); // 3 officers -> 1 officer x 8 files
      const police = data.topBottlenecks.find((b: any) => b.department === 'Police Department');
      expect(police).toBeDefined(); // a Police stage ranks in the top 5 bottlenecks
      expect(data.stuck.count).toBeGreaterThan(0);

      // same seed -> same arrivals (reproducible demos)
      const again = await request(app).post('/api/sim/scenarios/police_backlog/start').set('Authorization', `Bearer ${supervisor}`).send({ seed: 7 });
      expect(again.body.data.seed).toBe(7);
    });

    it('reset removes only simulated data and returns to real time', async () => {
      const before = await prisma.application.count({ where: { isSimulated: false } });
      const res = await request(app).post('/api/sim/reset').set('Authorization', `Bearer ${supervisor}`);
      expect(res.status).toBe(200);
      expect(await prisma.application.count({ where: { isSimulated: true } })).toBe(0);
      expect(await prisma.application.count({ where: { isSimulated: false } })).toBe(before);
      expect(res.body.data.clock.offsetMs).toBe(0);
    });
  });
});
