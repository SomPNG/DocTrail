import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db/client.js';

const app = createApp();

describe('Master Acceptance Test: Unified Golden Case for Judges', () => {
  let adminToken: string;
  let citizenToken: string;
  let pwdOfficerToken: string;
  let supervisorToken: string;

  let serviceKey: string;
  let applicationId: string;
  let requestedDocId: string;

  beforeAll(async () => {
    const login = (email: string) => request(app).post('/api/auth/login').send({ email, password: 'Password123!' });
    const [adminRes, citRes, supRes] = await Promise.all([login('admin@example.com'), login('citizen@example.com'), login('supervisor@example.com')]);
    adminToken = adminRes.body.data.token;
    citizenToken = citRes.body.data.token;
    supervisorToken = supRes.body.data.token;

    await prisma.department.upsert({
      where: { code: 'PWD_DEPT' },
      update: {},
      create: { code: 'PWD_DEPT', name: 'Public Works Department', description: 'Civil engineering & site surveys' },
    });

    // Staff accounts are provisioned by the administrator (public registration is citizen-only)
    const regOfficer = await request(app)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Er. Rajesh Kumar', email: `pwd.officer_${Date.now()}@example.com`, password: 'Password123!', role: 'OFFICER', departmentCode: 'PWD_DEPT' });
    expect(regOfficer.status).toBe(201);
    pwdOfficerToken = regOfficer.body.data.token;
  });

  it('Step 1 [Admin Studio]: AI workflow synthesis & version publication', async () => {
    const draftRes = await request(app)
      .post('/api/admin/workflows/draft-with-ai')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ prompt: 'Create an Industrial Groundwater Borewell Drilling Clearance involving PWD site survey, Pollution Control Board scrutiny, and DM sanction' });
    expect(draftRes.status).toBe(201);
    const draft = draftRes.body.data;
    expect(draft.stages.length).toBeGreaterThanOrEqual(2);

    serviceKey = `borewell_clearance_${Date.now()}`;
    draft.serviceKey = serviceKey;

    const pubRes = await request(app).post('/api/admin/workflows/publish').set('Authorization', `Bearer ${adminToken}`).send({ draft });
    expect(pubRes.status).toBe(201);
    expect(pubRes.body.data.versionNumber).toBe(1);
  });

  it('Step 2 [Citizen Intake]: intent matching & application submission', async () => {
    const matchRes = await request(app)
      .post('/api/services/match')
      .send({ intent: 'Industrial Groundwater Borewell Drilling and Water Table NOC for factory operation.' });
    expect(matchRes.status).toBe(200);
    expect(matchRes.body.data.bestMatch).toBeDefined();

    const createRes = await request(app)
      .post('/api/applications')
      .set('Authorization', `Bearer ${citizenToken}`)
      .send({ serviceKey, applicantName: 'Aarav Sharma', trackingNumber: `KL-DEMO-${Date.now()}`, applicantDetails: { plotNo: 42, depthFeet: 350 } });
    expect(createRes.status).toBe(201);
    applicationId = createRes.body.data.id;
    expect(createRes.body.data.currentStage.departmentCode).toBe('PWD_DEPT');
  });

  it('Step 3 [Citizen Portal]: citizen assistant answers from the diagnosis', async () => {
    const aiRes = await request(app)
      .post('/api/ai/citizen-assistant')
      .set('Authorization', `Bearer ${citizenToken}`)
      .send({ query: 'What is the current status of my borewell permit?', applicationId });
    expect(aiRes.status).toBe(200);
    expect(aiRes.body.data.reply).toBeDefined();
    expect(aiRes.body.data.context.currentStage).toBeDefined();
  });

  it('Step 4 [Officer]: copilot + document request pauses the SLA', async () => {
    const copilotRes = await request(app)
      .post('/api/ai/officer-assistant')
      .set('Authorization', `Bearer ${pwdOfficerToken}`)
      .send({ query: 'What site clearance checks do I need to conduct?', applicationId });
    expect(copilotRes.status).toBe(200);
    expect(copilotRes.body.data.checklistCompliance.length).toBeGreaterThanOrEqual(1);

    const reqDocRes = await request(app)
      .post(`/api/applications/${applicationId}/documents/request`)
      .set('Authorization', `Bearer ${pwdOfficerToken}`)
      .send({ documentType: 'site_layout', title: 'Certified Hydro-Geological Site Blueprint', reason: 'Scaled plot layout with GPS coordinates required' });
    expect(reqDocRes.status).toBe(201);
    requestedDocId = reqDocRes.body.data.id;

    const appRes = await request(app).get(`/api/applications/${applicationId}`).set('Authorization', `Bearer ${citizenToken}`);
    expect(appRes.body.data.status).toBe('ON_HOLD');
    expect(appRes.body.data.slaStatus).toBe('PAUSED');
  });

  it('Step 5 [Citizen Upload]: upload resumes the SLA', async () => {
    const upRes = await request(app)
      .post(`/api/applications/${applicationId}/documents/upload`)
      .set('Authorization', `Bearer ${citizenToken}`)
      .send({
        documentRequestId: requestedDocId,
        documentType: 'site_layout',
        title: 'Certified Hydro-Geological Site Blueprint',
        fileUrl: 'https://storage.example.gov.in/docs/site_layout_signed.pdf',
        fileHash: 'sha256:abc123789xyz',
      });
    expect(upRes.status).toBe(201);

    const appRes = await request(app).get(`/api/applications/${applicationId}`).set('Authorization', `Bearer ${citizenToken}`);
    expect(appRes.body.data.status).toBe('IN_PROGRESS');
    expect(appRes.body.data.slaStatus).toBe('ON_TRACK');
  });

  it('Step 6 [Officer]: intermediate stages are forwarded, not "approved"; wildcard checklists are refused', async () => {
    const wildcard = await request(app)
      .post(`/api/applications/${applicationId}/forward`)
      .set('Authorization', `Bearer ${pwdOfficerToken}`)
      .send({ checklistResponses: { '*': true } });
    expect(wildcard.status).toBe(400);

    const checklist = await request(app).get(`/api/applications/${applicationId}/checklists`).set('Authorization', `Bearer ${pwdOfficerToken}`);
    const ids = checklist.body.data.items.map((i: any) => i.id);

    const approveEarly = await request(app)
      .post(`/api/applications/${applicationId}/decision`)
      .set('Authorization', `Bearer ${pwdOfficerToken}`)
      .send({ decisionType: 'APPROVED', reason: 'Site inspection satisfied', checklistResponses: ids });
    expect(approveEarly.status).toBe(409);
    expect(approveEarly.body.message).toContain('not the final stage');

    const fwd = await request(app)
      .post(`/api/applications/${applicationId}/forward`)
      .set('Authorization', `Bearer ${pwdOfficerToken}`)
      .send({ remarks: 'Physical ground inspection satisfied.', checklistResponses: ids });
    expect(fwd.status).toBe(200);
    expect(fwd.body.data.nextStage).toBeDefined();

    const appRes = await request(app).get(`/api/applications/${applicationId}`).set('Authorization', `Bearer ${citizenToken}`);
    expect(appRes.body.data.status).toBe('IN_PROGRESS');
    expect(appRes.body.data.currentStage.departmentCode).not.toBe('PWD_DEPT');
  });

  it('Step 7 [SLA Watchdog]: scan flags files', async () => {
    const scanRes = await request(app).post('/api/sla/watchdog/scan').set('Authorization', `Bearer ${supervisorToken}`);
    expect(scanRes.status).toBe(200);
    expect(scanRes.body.data.scannedCount).toBeGreaterThanOrEqual(1);
  });

  it('Step 8 [Supervisor]: executive assistant summarises bottlenecks', async () => {
    const execRes = await request(app)
      .post('/api/ai/supervisor-assistant')
      .set('Authorization', `Bearer ${supervisorToken}`)
      .send({ query: 'Which department has the highest bottleneck score?' });
    expect(execRes.status).toBe(200);
    expect(execRes.body.data.insight).toBeDefined();
    expect(execRes.body.data.recommendedInterventions.length).toBeGreaterThanOrEqual(1);
  });
});
