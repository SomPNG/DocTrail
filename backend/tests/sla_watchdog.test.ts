import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

const app = createApp();

describe('Background SLA Watchdog & Proactive Breach Monitoring', () => {
  let supervisorToken: string;

  beforeAll(async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'supervisor@example.com', password: 'Password123!' });
    supervisorToken = res.body.data.token;

    const citRes = await request(app).post('/api/auth/login').send({ email: 'citizen@example.com', password: 'Password123!' });
    await request(app)
      .post('/api/applications')
      .set('Authorization', `Bearer ${citRes.body.data.token}`)
      .send({ serviceKey: 'gun_license', applicantName: 'Watchdog Test Citizen', applicantDetails: { purpose: 'Audit scan verification' } });
  });

  it('GET /api/sla/watchdog/status reports the real daemon state', async () => {
    const res = await request(app).get('/api/sla/watchdog/status').set('Authorization', `Bearer ${supervisorToken}`);
    expect(res.status).toBe(200);
    expect(['ACTIVE', 'STOPPED']).toContain(res.body.data.status); // tests run with SLA_WATCHDOG_ENABLED=false
    expect(res.body.data.daemon).toContain('Watchdog');
    expect(res.body.data.serverNow).toBeDefined();
  });

  it('POST /api/sla/watchdog/scan executes a LIVE scan and returns diagnostic metrics', async () => {
    const res = await request(app).post('/api/sla/watchdog/scan').set('Authorization', `Bearer ${supervisorToken}`).send({});
    expect(res.status).toBe(200);
    const report = res.body.data;
    expect(report.mode).toBe('LIVE');
    expect(report.scannedCount).toBeGreaterThan(0);
    expect(Array.isArray(report.newlyBreached)).toBe(true);
    expect(Array.isArray(report.stuckInactive)).toBe(true);
  });

  it('referenceTime gives a read-only PROJECTION (breaches 30 days out) without changing stored state', async () => {
    const futureTime = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const res = await request(app).post('/api/sla/watchdog/scan').set('Authorization', `Bearer ${supervisorToken}`).send({ referenceTime: futureTime });

    expect(res.status).toBe(200);
    const report = res.body.data;
    expect(report.mode).toBe('PROJECTION');
    expect(report.breachedCount).toBeGreaterThan(0);
    expect(report.stuckInactive.length).toBeGreaterThan(0);
    expect(report.stuckInactive[0].daysInactive).toBeGreaterThanOrEqual(3);

    // nothing was persisted: a live scan right now still sees the same file as not yet breached
    const live = await request(app).post('/api/sla/watchdog/scan').set('Authorization', `Bearer ${supervisorToken}`).send({});
    expect(live.body.data.breachedCount).toBeLessThan(report.breachedCount);
  });

  it('the React portal alias /api/sla/trigger-watchdog works', async () => {
    const res = await request(app).post('/api/sla/trigger-watchdog').set('Authorization', `Bearer ${supervisorToken}`).send({});
    expect(res.status).toBe(200);
  });
});
