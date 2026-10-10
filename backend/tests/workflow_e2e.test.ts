import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Clock, DAY_MS } from '../src/common/clock.js';

describe('DocTrail End-to-End Demo Scenario (Section 23)', () => {
  const app = createApp();

  let citizenToken: string;
  let dmToken: string;
  let policeToken: string;
  let supervisorToken: string;

  let applicationId: string;
  let qrCodeToken: string;
  let requestedDocId: string;
  const trackingNumber = `KL-E2E-${Date.now()}`;

  beforeAll(async () => {
    const [citizenLogin, dmLogin, policeLogin, supervisorLogin] = await Promise.all([
      request(app).post('/api/auth/login').send({ email: 'citizen@example.com', password: 'Password123!' }),
      request(app).post('/api/auth/login').send({ email: 'dm.officer@example.com', password: 'Password123!' }),
      request(app).post('/api/auth/login').send({ email: 'police.officer@example.com', password: 'Password123!' }),
      request(app).post('/api/auth/login').send({ email: 'supervisor@example.com', password: 'Password123!' }),
    ]);
    citizenToken = citizenLogin.body.data.token;
    dmToken = dmLogin.body.data.token;
    policeToken = policeLogin.body.data.token;
    supervisorToken = supervisorLogin.body.data.token;
  });

  afterAll(async () => {
    await Clock.reset();
  });

  it('Step 1: Citizen creates Gun License application', async () => {
    const res = await request(app)
      .post('/api/applications')
      .set('Authorization', `Bearer ${citizenToken}`)
      .send({
        serviceKey: 'gun_license',
        applicantName: 'Aarav Sharma',
        trackingNumber,
        applicantDetails: { occupation: 'Farmer / Self Defense', district: 'Kanpur Nagar' },
      });

    expect(res.status).toBe(201);
    applicationId = res.body.data.id;
    qrCodeToken = res.body.data.qrCodeToken;
    expect(res.body.data.trackingNumber).toBe(trackingNumber);
    expect(res.body.data.status).toBe('IN_PROGRESS');
    expect(res.body.data.slaStatus).toBe('ON_TRACK');
    expect(res.body.data.currentStage.name).toBe('DM / Initial Verification');
    expect(res.body.data.diagnosis.location.departmentCode).toBe('DM_OFFICE');
  });

  it('Step 2: DM Officer verifies and forwards application to Police Verification', async () => {
    const res = await request(app)
      .post(`/api/applications/${applicationId}/forward`)
      .set('Authorization', `Bearer ${dmToken}`)
      .send({
        remarks: 'DM initial documents verified. Forwarding for field inquiry.',
        checklistResponses: { dm_id_verify: true, dm_jurisdiction: true, dm_threat_validity: true, dm_age_threshold: true },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.nextStage.name).toBe('Police Verification');
    expect(res.body.data.nextStage.departmentCode).toBe('POLICE_DEPT');

    const appRes = await request(app).get(`/api/applications/${applicationId}`).set('Authorization', `Bearer ${dmToken}`);
    expect(appRes.body.data.currentStage.name).toBe('Police Verification');
    expect(appRes.body.data.slaStatus).toBe('ON_TRACK');
  });

  it('Step 3: Police Officer requests address proof -> SLA clock PAUSES', async () => {
    const res = await request(app)
      .post(`/api/applications/${applicationId}/documents/request`)
      .set('Authorization', `Bearer ${policeToken}`)
      .send({
        documentType: 'address_proof',
        title: 'Utility Bill or Ration Card',
        reason: 'Permanent address verification required for local station jurisdiction',
      });

    expect(res.status).toBe(201);
    requestedDocId = res.body.data.id;

    const appRes = await request(app).get(`/api/applications/${applicationId}`).set('Authorization', `Bearer ${citizenToken}`);
    expect(appRes.body.data.status).toBe('ON_HOLD');
    expect(appRes.body.data.slaStatus).toBe('PAUSED');
    expect(appRes.body.data.diagnosis.reasonCode).toBe('WAITING_ON_CITIZEN');
  });

  it('Step 4: Citizen uploads requested address proof -> SLA clock RESUMES', async () => {
    const res = await request(app)
      .post(`/api/applications/${applicationId}/documents/upload`)
      .set('Authorization', `Bearer ${citizenToken}`)
      .send({
        documentRequestId: requestedDocId,
        documentType: 'address_proof',
        title: 'Electricity Bill - October 2026',
        fileUrl: 'https://storage.gov.in/doctrail/uploads/elec_bill_kanpur.pdf',
        notes: 'Attached certified bill matching residence address',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.slaResumed).toBe(true);

    const appRes = await request(app).get(`/api/applications/${applicationId}`).set('Authorization', `Bearer ${citizenToken}`);
    expect(appRes.body.data.status).toBe('IN_PROGRESS');
    expect(appRes.body.data.slaStatus).not.toBe('PAUSED');
  });

  it('Step 5: Virtual clock moves 15 days ahead -> SLA BREACHED (no data back-dating)', async () => {
    await Clock.advance(15 * DAY_MS);

    const slaRes = await request(app).get(`/api/applications/${applicationId}/sla`).set('Authorization', `Bearer ${citizenToken}`);
    expect(slaRes.status).toBe(200);
    expect(slaRes.body.data.status).toBe('BREACHED');
    expect(slaRes.body.data.isBreached).toBe(true);
    expect(slaRes.body.data.overdueSeconds).toBeGreaterThan(0);
  });

  it('Step 6: Supervisor views breach in dashboard', async () => {
    const res = await request(app).get('/api/dashboard/breaches').set('Authorization', `Bearer ${supervisorToken}`);
    expect(res.status).toBe(200);
    const found = res.body.data.find((a: any) => a.id === applicationId);
    expect(found).toBeDefined();
    expect(found.slaStatus).toBe('BREACHED');
  });

  it('Step 7: Breach automatically created a pending compensation claim; supervisor approves it', async () => {
    const res = await request(app).get(`/api/applications/${applicationId}/compensation`).set('Authorization', `Bearer ${citizenToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.isEligible).toBe(true);
    expect(res.body.data.ratePerDay).toBe(250);
    expect(res.body.data.estimatedCompensationAmount).toBeGreaterThan(0);
    expect(res.body.data.record.status).toBe('ELIGIBLE_PENDING_APPROVAL');

    const reviewRes = await request(app)
      .post(`/api/applications/${applicationId}/compensation/review`)
      .set('Authorization', `Bearer ${supervisorToken}`)
      .send({ recordId: res.body.data.record.id, action: 'APPROVE', remarks: 'Police station workload delay' });
    expect(reviewRes.status).toBe(200);
    expect(reviewRes.body.data.status).toBe('APPROVED');

    const again = await request(app)
      .post(`/api/applications/${applicationId}/compensation/review`)
      .set('Authorization', `Bearer ${supervisorToken}`)
      .send({ recordId: res.body.data.record.id, action: 'REJECT' });
    expect(again.status).toBe(409);
  });

  it('Step 8: Complete timeline reconstructs every event, and the audit chain verifies', async () => {
    const res = await request(app).get(`/api/applications/${applicationId}/timeline`).set('Authorization', `Bearer ${citizenToken}`);
    expect(res.status).toBe(200);
    const eventTypes = res.body.data.map((e: any) => e.eventType);
    for (const t of ['APPLICATION_CREATED', 'STAGE_ENTERED', 'STAGE_COMPLETED', 'APPLICATION_FORWARDED', 'DOCUMENT_REQUESTED', 'SLA_PAUSED', 'DOCUMENT_SUBMITTED', 'SLA_RESUMED', 'SLA_BREACHED', 'ESCALATED']) {
      expect(eventTypes).toContain(t);
    }
    expect(eventTypes.filter((t: string) => t === 'SLA_BREACHED')).toHaveLength(1);

    const chain = await request(app).get(`/api/applications/${applicationId}/verify-audit-chain`).set('Authorization', `Bearer ${supervisorToken}`);
    expect(chain.body.data.isChainValid).toBe(true);
    expect(chain.body.data.legacyUnsealedEvents).toBe(0);
  });

  it('Step 9: Public QR lookup shows where the file is, with the applicant name masked', async () => {
    const res = await request(app).get(`/api/integrations/qr/${qrCodeToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.applicationId).toBe(applicationId);
    expect(res.body.data.currentDepartment).toBe('Police Department');
    expect(res.body.data.departmentCode).toBe('POLICE_DEPT');
    expect(res.body.data.slaStatus).toBe('BREACHED');
    expect(res.body.data.applicantName).toBe('A**** S*****');
  });

  it('Step 10: External system adapter requires the integration key and records EXTERNAL_UPDATE', async () => {
    const payload = {
      sourceSystem: 'POLICE_CCTNS',
      externalEventId: `CCTNS-UP-${Date.now()}`,
      trackingNumber,
      eventType: 'EXTERNAL_CRIMINAL_RECORD_CLEARANCE',
      status: 'CLEAR',
      officerRemarks: 'No adverse record found in State Crime Records Bureau',
    };

    const denied = await request(app).post('/api/integrations/events').send(payload);
    expect(denied.status).toBe(401);

    const res = await request(app)
      .post('/api/integrations/events')
      .set('x-integration-key', 'doctrail-dev-integration-key')
      .send(payload);
    expect(res.status).toBe(202);
    expect(res.body.data.status).toBe('PROCESSED');
    expect(res.body.data.trackingNumber).toBe(trackingNumber);

    const dup = await request(app)
      .post('/api/integrations/events')
      .set('x-integration-key', 'doctrail-dev-integration-key')
      .send(payload);
    expect(dup.body.data.status).toBe('DUPLICATE_IGNORED');
  });
});
