import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

describe('Authentication & RBAC Tests', () => {
  const app = createApp();

  it('returns welcome directory and seed credentials on GET / (demo mode)', async () => {
    const res = await request(app).get('/').set('Accept', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('DocTrail API');
    expect(res.body.endpoints).toBeDefined();
    expect(res.body.seedCredentials).toBeDefined();
  });

  it('successfully registers a new citizen', async () => {
    const email = `citizen_${Date.now()}@example.com`;
    const res = await request(app).post('/api/auth/register').send({ email, password: 'Password123!', name: 'New Citizen', role: 'CITIZEN' });

    expect(res.status).toBe(201);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.user.email).toBe(email);
    expect(res.body.data.user.role).toBe('CITIZEN');
  });

  it('refuses public self-registration as OFFICER / SUPERVISOR / ADMIN', async () => {
    for (const role of ['OFFICER', 'SUPERVISOR', 'ADMIN']) {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: `${role.toLowerCase()}_${Date.now()}@example.com`, password: 'Password123!', name: 'Attacker', role, departmentCode: 'DM_OFFICE' });
      expect(res.status).toBe(422);
    }
  });

  it('rejects registration with duplicate email', async () => {
    const email = `dup_${Date.now()}@example.com`;
    await request(app).post('/api/auth/register').send({ email, password: 'Password123!', name: 'User 1' });
    const res = await request(app).post('/api/auth/register').send({ email, password: 'Password123!', name: 'User 2' });
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  it('authenticates user and returns profile on /api/auth/me', async () => {
    const loginRes = await request(app).post('/api/auth/login').send({ email: 'supervisor@example.com', password: 'Password123!' });
    expect(loginRes.status).toBe(200);
    const meRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${loginRes.body.data.token}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.data.role).toBe('SUPERVISOR');
  });

  it('enforces RBAC: prevents citizen from accessing supervisor dashboard', async () => {
    const loginRes = await request(app).post('/api/auth/login').send({ email: 'citizen@example.com', password: 'Password123!' });
    const res = await request(app).get('/api/dashboard/overview').set('Authorization', `Bearer ${loginRes.body.data.token}`);
    expect(res.status).toBe(403);
  });
});
