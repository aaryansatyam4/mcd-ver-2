import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { db } from '../src/database/excelDb.js';

const app = createApp();

describe('Reports & Export Engine', () => {
  let adminToken = '';

  beforeAll(async () => {
    await db.init();
    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: '123456' });
    adminToken = login.body.token;
  });

  it('generates daily report with 24-hour breakdown and location totals', async () => {
    const res = await request(app)
      .get('/api/reports/daily?date=2026-10-21')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.type).toBe('daily');
    expect(res.body.hourlyData.length).toBe(24);
    expect(res.body.locations.length).toBe(3);
  });

  it('generates weekly report with 7-day movement chart and comparison', async () => {
    const res = await request(app)
      .get('/api/reports/weekly?startDate=2026-10-15&endDate=2026-10-21')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.type).toBe('weekly');
    expect(res.body.dailyBreakdown.length).toBe(7);
    expect(res.body.locationTotals.length).toBe(3);
  });

  it('generates monthly report with daily totals and average daily count', async () => {
    const res = await request(app)
      .get('/api/reports/monthly?month=2026-10')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.type).toBe('monthly');
    expect(res.body.daysInMonth).toBe(31);
    expect(res.body.averageDailyCount).toBeDefined();
  });

  it('generates yearly report with 12-month breakdown', async () => {
    const res = await request(app)
      .get('/api/reports/yearly?year=2026')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.type).toBe('yearly');
    expect(res.body.monthlyBreakdown.length).toBe(12);
  });

  it('exports report to CSV format', async () => {
    const res = await request(app)
      .get('/api/reports/export?format=csv&type=daily&date=2026-10-21')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('WHEELWASH MONITOR - DAILY REPORT');
  });

  it('exports report to Excel format', async () => {
    const res = await request(app)
      .get('/api/reports/export?format=excel&type=daily&date=2026-10-21')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(res.body).toBeDefined();
  });

  it('daily report includes vehiclePassages with exact crossing timings', async () => {
    const res = await request(app)
      .get('/api/reports/daily?date=2026-10-21')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.vehiclePassages).toBeDefined();
    expect(Array.isArray(res.body.vehiclePassages)).toBe(true);
  });

  describe('truck passage log pagination', () => {
    const DAY = '2025-03-14';
    beforeAll(() => {
      // 60 passages at Ghazipur one minute apart, plus one typed into the sheet by hand
      for (let i = 0; i < 60; i++) {
        const minute = String(i).padStart(2, '0');
        db.recordVehicleEvent({ location_id: 1, camera_id: 1, event_timestamp: `${DAY} 10:${minute}:00`, detection_source: 'automatic' });
      }
      db.recordVehicleEvent({ location_id: 2, camera_id: 2, event_timestamp: `${DAY} 12:00:00`, detection_source: 'manual' as any });
    });

    const daily = (query: string) =>
      request(app).get(`/api/reports/daily?date=${DAY}&${query}`).set('Authorization', `Bearer ${adminToken}`);

    it('returns one page with the totals for the whole period', async () => {
      const res = await daily('pageSize=25&page=2');
      expect(res.status).toBe(200);
      expect(res.body.vehiclePassages).toHaveLength(25);
      expect(res.body.passagesPagination).toEqual({ page: 2, pageSize: 25, total: 61, totalPages: 3, sort: 'newest' });
      // Newest first, numbered over the whole day
      expect(res.body.vehiclePassages[0].passageNumber).toBe(36);
      expect(res.body.totalTrucks).toBe(61);
    });

    it('sorts oldest first and clamps pages past the end', async () => {
      const res = await daily('pageSize=25&page=99&sort=oldest');
      expect(res.body.passagesPagination.page).toBe(3);
      expect(res.body.vehiclePassages.map((p: any) => p.passageNumber)).toEqual(Array.from({ length: 11 }, (_, i) => 51 + i));
    });

    it('falls back to 50 per page for unknown page sizes', async () => {
      const res = await daily('pageSize=100000');
      expect(res.body.passagesPagination.pageSize).toBe(50);
      expect(res.body.vehiclePassages).toHaveLength(50);
    });

    it('labels every passage as an automatic detection, also rows typed into the sheet', async () => {
      const res = await daily('pageSize=25');
      expect(res.body.vehiclePassages[0]).toMatchObject({ locationName: 'OKHLA', detectionSource: 'Live CCTV AI' });
    });

    it('exports every passage, not just one page', async () => {
      const res = await request(app)
        .get(`/api/reports/export?format=csv&type=daily&date=${DAY}&pageSize=25`)
        .set('Authorization', `Bearer ${adminToken}`);
      const logRows = res.text.split('--- INDIVIDUAL TRUCK PASSAGE TIMINGS LOG ---')[1].trim().split('\n');
      expect(logRows).toHaveLength(62); // header + 61 passages
    });

    it('weekly report uses the picked dates', async () => {
      const res = await request(app)
        .get('/api/reports/weekly?startDate=2025-03-10&endDate=2025-03-16&pageSize=25')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.body.startDate).toBe('2025-03-10');
      expect(res.body.endDate).toBe('2025-03-16');
      expect(res.body.grandTotal).toBe(61);
      expect(res.body.passagesPagination.total).toBe(61);
    });

    it('rejects ranges that are too long', async () => {
      const res = await request(app)
        .get('/api/reports/weekly?startDate=2025-01-01&endDate=2025-12-31')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/at most 92 days/);
    });
  });
});
