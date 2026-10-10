import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

describe('Real File Upload, AI Analysis, Auto-Routing & Demo Reset', () => {
  const app = createApp();
  let citizenToken: string;
  let supervisorToken: string;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctrail-'));
  const tempFilePath = path.join(tmpDir, 'test_application_doc.txt');

  beforeAll(async () => {
    citizenToken = (await request(app).post('/api/auth/login').send({ email: 'citizen@example.com', password: 'Password123!' })).body.data.token;
    supervisorToken = (await request(app).post('/api/auth/login').send({ email: 'supervisor@example.com', password: 'Password123!' })).body.data.token;
    fs.writeFileSync(
      tempFilePath,
      `GOVERNMENT APPLICATION FOR ARMS & GUN LICENSE
Applicant Name: Vikramaditya Singhania
Address: Civil Lines, Kanpur
Purpose: Crop protection from wild boars and personal family security.
Document: Aadhaar Identity Proof 9876 5432 1098`
    );
  });

  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('POST /api/documents/upload requires login and returns an internal URL', async () => {
    const anon = await request(app).post('/api/documents/upload');
    expect(anon.status).toBe(401);

    const res = await request(app)
      .post('/api/documents/upload')
      .set('Authorization', `Bearer ${citizenToken}`)
      .attach('file', tempFilePath);
    expect(res.status).toBe(201);
    expect(res.body.data.fileUrl).toContain('/uploads/');
    expect(res.body.data.fileHash).toHaveLength(64);
  });

  it('rejects dangerous file types (e.g. HTML)', async () => {
    const htmlPath = path.join(tmpDir, 'evil.html');
    fs.writeFileSync(htmlPath, '<script>alert(1)</script>');
    const res = await request(app).post('/api/documents/upload').set('Authorization', `Bearer ${citizenToken}`).attach('file', htmlPath);
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('File type not allowed');
  });

  it('upload-and-route analyses the document, creates the application and routes it to the entry department', async () => {
    const anon = await request(app).post('/api/documents/upload-and-route');
    expect(anon.status).toBe(401);

    const res = await request(app)
      .post('/api/documents/upload-and-route')
      .set('Authorization', `Bearer ${citizenToken}`)
      .attach('file', tempFilePath)
      .field('notes', 'Priority citizen self-defense application');

    expect(res.status).toBe(201);
    const data = res.body.data;
    expect(data.application.trackingNumber).toMatch(/^GL-\d{4}-\d{6}$/);
    expect(data.application.status).toBe('IN_PROGRESS');
    expect(data.analysis.applicantName).toBeDefined();
    expect(data.targetDepartment.code).toBe('DM_OFFICE');
    expect(data.activeStage.name).toBe('DM / Initial Verification');
    expect(data.verificationChecklists.length).toBeGreaterThanOrEqual(3);
    expect(data.document.fileUrl).toContain('/uploads/');
  });

  it('upload-and-route REJECTS non-governmental documents with 400', async () => {
    const randomFilePath = path.join(tmpDir, 'random_recipe.txt');
    fs.writeFileSync(randomFilePath, `Grandma's Chocolate Chip Cookie Recipe: 2 cups flour, 1 cup sugar, bake at 350F for 12 minutes.`);
    const res = await request(app).post('/api/documents/upload-and-route').set('Authorization', `Bearer ${citizenToken}`).attach('file', randomFilePath);
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('could not be identified as a valid statutory government application');
  });

  it('POST /api/demo/reset is protected and wipes all applications', async () => {
    expect((await request(app).post('/api/demo/reset')).status).toBe(401);
    expect((await request(app).post('/api/demo/reset').set('Authorization', `Bearer ${citizenToken}`)).status).toBe(403);

    const res = await request(app).post('/api/demo/reset').set('Authorization', `Bearer ${supervisorToken}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.totalApplications).toBe(0);

    const appRes = await request(app).get('/api/applications').set('Authorization', `Bearer ${citizenToken}`);
    expect(appRes.body.data.length).toBe(0);
  });
});
