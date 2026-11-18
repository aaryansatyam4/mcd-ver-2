import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { db } from '../src/database/excelDb.js';

const app = createApp();

describe('Authentication & Role-Based Permissions', () => {
  let adminToken = '';
  let ghazipurToken = '';
  let monitoringToken = '';

  beforeAll(async () => {
    await db.init();
  });

  it('allows Master Admin to log in with initial default password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: '123456' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.role).toBe('admin');
    expect(res.body.user.must_change_password).toBe(0);
    adminToken = res.body.token;
  });

  it('swaps a valid token for a fresh one, and refuses without a valid token', async () => {
    const res = await request(app).post('/api/auth/refresh').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');

    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe('admin');

    expect((await request(app).post('/api/auth/refresh')).status).toBe(401);
    expect((await request(app).post('/api/auth/refresh').set('Authorization', 'Bearer not-a-token')).status).toBe(403);
  });

  it('rejects invalid password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'wrongpassword' });

    expect(res.status).toBe(401);
  });

  it('allows Ghazipur Operator to log in and access only Ghazipur', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'ghazipur', password: '123456' });

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('operator');
    expect(res.body.user.assigned_location_id).toBe(1);
    ghazipurToken = res.body.token;

    // Operator can access Ghazipur (location 1)
    const loc1 = await request(app)
      .get('/api/counts/1')
      .set('Authorization', `Bearer ${ghazipurToken}`);
    expect(loc1.status).toBe(200);

    // Operator is BLOCKED from accessing Okhla (location 2)
    const loc2 = await request(app)
      .get('/api/counts/2')
      .set('Authorization', `Bearer ${ghazipurToken}`);
    expect(loc2.status).toBe(403);
  });

  it('prevents Operator from editing counts', async () => {
    const res = await request(app)
      .post('/api/counts/adjust')
      .set('Authorization', `Bearer ${ghazipurToken}`)
      .send({
        locationId: 1,
        reportDate: '2026-10-21',
        newCount: 50,
        reason: 'Operator attempting edit',
      });

    expect(res.status).toBe(403);
  });

  it('allows Central Monitoring to view all locations but NOT edit', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'monitoring', password: '123456' });

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('monitoring');
    monitoringToken = res.body.token;

    // Monitoring can view Ghazipur, Okhla, Bhalaswa
    const summary = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', `Bearer ${monitoringToken}`);
    expect(summary.status).toBe(200);
    expect(summary.body.locations.length).toBe(3);

    // Monitoring is BLOCKED from manual adjustments
    const adj = await request(app)
      .post('/api/counts/adjust')
      .set('Authorization', `Bearer ${monitoringToken}`)
      .send({
        locationId: 1,
        reportDate: '2026-10-21',
        newCount: 80,
        reason: 'Monitoring trying to adjust',
      });
    expect(adj.status).toBe(403);

    // Monitoring is BLOCKED from user management
    const users = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${monitoringToken}`);
    expect(users.status).toBe(403);
  });
});
