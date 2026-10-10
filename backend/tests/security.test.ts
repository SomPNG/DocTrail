import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { SecurityEngine } from '../src/common/security.js';
import { EventService } from '../src/modules/events/event.service.js';
import { prisma } from '../src/db/client.js';

describe('GovTech Security & Data Protection Engine', () => {
  const app = createApp();
  let citizenToken: string;
  let testAppId: string;

  beforeAll(async () => {
    citizenToken = (await request(app).post('/api/auth/login').send({ email: 'citizen@example.com', password: 'Password123!' })).body.data.token;
    const created = await request(app)
      .post('/api/applications')
      .set('Authorization', `Bearer ${citizenToken}`)
      .send({ serviceKey: 'passport_reissue', applicantName: 'Security Test Applicant' });
    testAppId = created.body.data.id;
  });

  describe('1. PII Masking (DPDP Act / UIDAI)', () => {
    it('masks Aadhaar, mobile, PAN, passport, names and emails', () => {
      expect(SecurityEngine.maskPii('1234 5678 9012')).toBe('XXXX-XXXX-9012');
      expect(SecurityEngine.maskPii('987654321098')).toBe('XXXX-XXXX-1098');
      expect(SecurityEngine.maskPii('+91 9876543210')).toBe('+91 XXXXX-43210');
      expect(SecurityEngine.maskPii('9876543210')).toBe('+91 XXXXX-43210');
      expect(SecurityEngine.maskPii('ABCDE1234F')).toBe('ABC****4F');
      expect(SecurityEngine.maskPii('Z8912341')).toBe('Z****341');
      expect(SecurityEngine.maskName('Aarav Sharma')).toBe('A**** S*****');
      expect(SecurityEngine.maskEmail('citizen@example.com')).toBe('ci****@example.com');
    });

    it('officers see masked citizen contact details', async () => {
      const passportToken = (await request(app).post('/api/auth/login').send({ email: 'passport.officer@example.com', password: 'Password123!' })).body.data.token;
      const res = await request(app).get(`/api/applications/${testAppId}`).set('Authorization', `Bearer ${passportToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.citizen.email).toContain('****');
    });
  });

  describe('2. Expiring Signed Document Tokens', () => {
    it('allows access before expiry, rejects expired and tampered tokens', () => {
      const token = SecurityEngine.generateExpiringFileToken('/uploads/demo_doc.pdf', 60);
      expect(SecurityEngine.verifyExpiringFileToken(token).valid).toBe(true);
      expect(SecurityEngine.verifyExpiringFileToken(SecurityEngine.generateExpiringFileToken('/uploads/x.pdf', -5)).error).toContain('expired');
      const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
      decoded.fileUrl = '/uploads/unauthorized_admin_file.pdf';
      expect(SecurityEngine.verifyExpiringFileToken(Buffer.from(JSON.stringify(decoded)).toString('base64url')).error).toContain('mismatch');
    });

    it('generate-token requires login', async () => {
      const res = await request(app).post('/api/documents/generate-token').send({ fileUrl: '/uploads/anything.pdf' });
      expect(res.status).toBe(401);
    });
  });

  describe('3. Tamper-evident audit chain', () => {
    it('links sequential events through their seals', async () => {
      const e1 = await EventService.recordEvent({ applicationId: testAppId, eventType: 'EXTERNAL_UPDATE', metadata: { note: 'first' } });
      const e2 = await EventService.recordEvent({ applicationId: testAppId, eventType: 'EXTERNAL_UPDATE', metadata: { note: 'second' } });
      const s1 = JSON.parse(e1.metadataJson).cryptographicSeal;
      const s2 = JSON.parse(e2.metadataJson).cryptographicSeal;
      expect(s1.algorithm).toBe('SHA-256');
      expect(s1.chainHash).toHaveLength(64);
      expect(s2.prevHash).toBe(s1.chainHash);
      expect(e2.seq).toBe(e1.seq + 1);
    });

    it('verifies an intact chain and detects edited content', async () => {
      const ok = await request(app).get(`/api/applications/${testAppId}/verify-audit-chain`).set('Authorization', `Bearer ${citizenToken}`);
      expect(ok.body.data.isChainValid).toBe(true);
      expect(ok.body.data.legacyUnsealedEvents).toBe(0);

      // Tamper with a stored event payload directly in the database
      const victim = await prisma.stageEvent.findFirstOrThrow({ where: { applicationId: testAppId, eventType: 'APPLICATION_CREATED' } });
      const meta = JSON.parse(victim.metadataJson);
      meta.applicantName = 'Someone Else';
      await prisma.stageEvent.update({ where: { id: victim.id }, data: { metadataJson: JSON.stringify(meta) } });

      const bad = await request(app).get(`/api/applications/${testAppId}/verify-audit-chain`).set('Authorization', `Bearer ${citizenToken}`);
      expect(bad.body.data.isChainValid).toBe(false);
      expect(bad.body.data.compromisedEventId).toBe(victim.id);
    });
  });

  describe('4. Security headers', () => {
    it('returns strict headers on API responses', async () => {
      const res = await request(app).get('/api/health');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['strict-transport-security']).toContain('max-age=');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['x-server-now']).toBeDefined();
    });
  });
});
