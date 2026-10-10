import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db/client.js';

const app = createApp();

describe('DocTrail AI Engine & Dynamic Workflow API', () => {
  let citizenToken: string;
  let officerToken: string;
  let supervisorToken: string;
  let adminToken: string;
  let dynamicAppId: string;

  beforeAll(async () => {
    const login = (email: string) => request(app).post('/api/auth/login').send({ email, password: 'Password123!' });
    citizenToken = (await login('citizen@example.com')).body.data.token;
    officerToken = (await login('dm.officer@example.com')).body.data.token;
    supervisorToken = (await login('supervisor@example.com')).body.data.token;
    adminToken = (await login('admin@example.com')).body.data.token;
  });

  it('Step 1: POST /api/ai/synthesize-service is ADMIN-only and persists only on request', async () => {
    const anon = await request(app).post('/api/ai/synthesize-service').send({ prompt: 'Agricultural Borewell Drilling Permission' });
    expect(anon.status).toBe(401);

    const res = await request(app)
      .post('/api/ai/synthesize-service')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ prompt: 'Agricultural Borewell Drilling Permission for farm irrigation in Palakkad', autoPersist: true });

    expect(res.status).toBe(201);
    const service = res.body.data.synthesized;
    expect(service.name).toContain('Borewell');
    expect(service.stages.length).toBeGreaterThanOrEqual(3);
    expect(service.stages[0].requiredDocuments.length).toBeGreaterThan(0);
    expect(res.body.data.isPersisted).toBe(true);

    const dbService = await prisma.service.findUnique({ where: { key: service.serviceKey }, include: { stages: true } });
    expect(dbService?.stages.filter(s => s.isActive).length).toBe(service.stages.length);
  });

  it('Step 2: POST /api/ai/apply provisions workflow and creates citizen application', async () => {
    const res = await request(app)
      .post('/api/ai/apply')
      .set('Authorization', `Bearer ${citizenToken}`)
      .send({
        intent: 'Commercial Food & Hospitality Cafe operation license in Fort Kochi',
        applicantName: 'Aarav Sharma',
        applicantDetails: { seatingCapacity: 40, district: 'Ernakulam' },
      });

    expect(res.status).toBe(201);
    const application = res.body.data.application;
    dynamicAppId = application.id;
    expect(application.trackingNumber).toMatch(/^[A-Z]{2}-\d{4}-\d{6}$/);
    expect(application.status).toBe('IN_PROGRESS');
    expect(application.slaStatus).toBe('ON_TRACK');
  });

  it('Step 3: evaluate-stage diagnoses missing documents (staff with jurisdiction only)', async () => {
    // The cafe workflow starts at FIRE_DEPT: the DM officer has no jurisdiction over it
    const denied = await request(app).get(`/api/ai/evaluate-stage/${dynamicAppId}`).set('Authorization', `Bearer ${officerToken}`);
    expect(denied.status).toBe(403);

    const res = await request(app).get(`/api/ai/evaluate-stage/${dynamicAppId}`).set('Authorization', `Bearer ${supervisorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('DOCUMENTS_MISSING');
    expect(res.body.data.missingDocuments.length).toBeGreaterThan(0);
    expect(res.body.data.officerSummary).toContain('Recommend issuing document request');
  });

  it('Step 4: auto-request-doc pauses the SLA', async () => {
    const res = await request(app).post(`/api/ai/auto-request-doc/${dynamicAppId}`).set('Authorization', `Bearer ${supervisorToken}`).send({});
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('PENDING');

    const appRes = await request(app).get(`/api/applications/${dynamicAppId}`).set('Authorization', `Bearer ${supervisorToken}`);
    expect(appRes.body.data.status).toBe('ON_HOLD');
    expect(appRes.body.data.slaStatus).toBe('PAUSED');
  });

  it('Step 5: explain-delay attributes the delay to the applicant', async () => {
    const res = await request(app).get(`/api/ai/explain-delay/${dynamicAppId}`).set('Authorization', `Bearer ${supervisorToken}`);
    expect(res.status).toBe(200);
    const diagnostic = res.body.data;
    expect(diagnostic.primaryDelayCause).toBe('APPLICANT_PENDING_DOCS');
    expect(diagnostic.reasonCode).toBe('WAITING_ON_CITIZEN');
    expect(diagnostic.citizenExplanation).toContain('paused');
    expect(diagnostic.supervisorActionRecommendation).toContain('applicant-attributable');
    expect(diagnostic.dwellTimeBreakdown.length).toBeGreaterThanOrEqual(1);
  });

  it('Step 6: GET /api/ai/catalog lists services with real document rules', async () => {
    const res = await request(app).get('/api/ai/catalog');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(3);
    const gun = res.body.data.find((s: any) => s.key === 'gun_license');
    expect(gun.compensationPerDay).toBe(250);
    expect(gun.stages[0].requiredDocuments.map((d: any) => d.documentType)).toContain('identity_proof');
  });
});
