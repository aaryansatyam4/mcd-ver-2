import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GoogleSheetsClient, GoogleSheetsSync } from '../src/services/googleSheetsStore.js';
import os from 'os';
import path from 'path';
import { ExcelDatabase } from '../src/database/excelDb.js';
import { TABLE_NAMES, normalizeDateText, type Tables } from '../src/database/schema.js';
import { loadAppsScript, type FakeSpreadsheet } from './helpers/fakeAppsScript.js';

const URL = 'https://script.google.com/macros/s/test/exec';

function sampleTables(): Tables {
  return {
    locations: [
      { id: 1, name: 'GHAZIPUR', active: 1 },
      { id: 2, name: 'OKHLA', active: 0 },
    ],
    users: [
      {
        id: 1,
        username: 'admin',
        password_hash: '$2a$10$abcdefghijklmnopqrstuv',
        role: 'admin',
        assigned_location_id: null,
        active: 1,
        must_change_password: 0,
        created_at: '2026-10-26 09:00:00',
        last_login: null,
      },
      {
        id: 2,
        username: 'ghazipur',
        password_hash: '$2a$10$zyxwvutsrqponmlkjihgfe',
        role: 'operator',
        assigned_location_id: 1,
        active: 1,
        must_change_password: 0,
        created_at: '2026-10-26 09:00:00',
        last_login: '2026-10-26 10:15:00',
      },
    ],
    cameras: [
      {
        id: 1,
        location_id: 1,
        connection_configuration: JSON.stringify({ rtspUrl: 'rtsp://cam/1', port: 554 }),
        detection_enabled: 1,
        status: 'online',
        detection_settings: JSON.stringify({ sensitivity: 65 }),
      },
    ],
    vehicle_events: [
      { id: 1, location_id: 1, camera_id: 1, event_timestamp: '2026-10-26 10:00:00', detection_source: 'automatic' },
      { id: 2, location_id: 1, camera_id: 1, event_timestamp: '2026-10-26 10:05:00', detection_source: 'demo_simulated' },
    ],
    count_adjustments: [
      {
        id: 1,
        location_id: 1,
        report_date: '2026-10-26',
        adjustment: -3,
        previous_total: 10,
        corrected_total: 7,
        reason: '=SUM(A1) duplicate trucks',
        modified_by: 1,
        created_at: '2026-10-26 11:00:00',
      },
    ],
    audit_logs: [{ id: 1, user_id: null, action: 'SYSTEM_INIT', details: 'seeded', created_at: '2026-10-26 09:00:00' }],
  };
}

describe('Google Sheet database (Apps Script + backend sync)', () => {
  let spreadsheet: FakeSpreadsheet;
  let tables: Tables;
  let client: GoogleSheetsClient;
  let sync: GoogleSheetsSync;

  beforeEach(() => {
    const script = loadAppsScript();
    spreadsheet = script.spreadsheet;
    vi.stubGlobal('fetch', vi.fn(script.fetchImpl));
    tables = sampleTables();
    client = new GoogleSheetsClient(URL, '');
    sync = new GoogleSheetsSync(client, () => tables, 10);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads nothing from an empty sheet', async () => {
    expect(await client.load()).toEqual({});
    expect(client.spreadsheetUrl).toContain('docs.google.com');
  });

  it('uploads every table and reads it back with the right types', async () => {
    sync.markMissing(TABLE_NAMES);
    await sync.flush();

    expect(sync.pendingChanges()).toBe(0);
    expect(spreadsheet.records('vehicle_events')).toHaveLength(2);
    expect(spreadsheet.records('users')[0].username).toBe('admin');

    const loaded = await client.load();
    expect(loaded).toEqual(tables);
  });

  it('creates tabs for tables that have no rows yet', async () => {
    tables.vehicle_events = [];
    sync.markMissing(TABLE_NAMES);
    await sync.flush();

    expect(spreadsheet.getSheetByName('vehicle_events')?.getLastRow()).toBe(1);
    expect((await client.load()).vehicle_events).toEqual([]);
  });

  it('keeps a Dashboard tab first in the sheet', async () => {
    sync.setDashboardProvider(() => ({ headers: ['Location', 'Trucks Today'], rows: [['GHAZIPUR', '2']] }));
    sync.markMissing(TABLE_NAMES);
    await sync.flush();

    expect(spreadsheet.sheets[0].name).toBe('Dashboard');
    expect(spreadsheet.records('Dashboard')).toEqual([{ Location: 'GHAZIPUR', 'Trucks Today': '2' }]);
  });

  it('appends only new rows and rewrites edited tables', async () => {
    sync.markMissing(TABLE_NAMES);
    await sync.flush();

    tables.vehicle_events.push({
      id: 3,
      location_id: 2,
      camera_id: 1,
      event_timestamp: '2026-10-26 12:00:00',
      detection_source: 'automatic',
    });
    sync.markDirty('vehicle_events');
    tables.users[1] = { ...tables.users[1], password_hash: 'changed' };
    sync.markDirty('users');
    await sync.flush();

    const saveCalls = vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    const last = saveCalls[saveCalls.length - 1];
    expect(Object.keys(last.replace)).toEqual(['users']);
    expect(last.append.vehicle_events.rows).toHaveLength(1);

    expect(await client.load()).toEqual(tables);
  });

  it('never duplicates rows when the same save is retried', async () => {
    sync.markMissing(TABLE_NAMES);
    await sync.flush();
    const retry = {
      append: { vehicle_events: { headers: ['id', 'location_id', 'camera_id', 'event_timestamp', 'detection_source'], rows: [['2', '1', '1', '2026-10-26 10:05:00', 'automatic']] } },
    };
    await client.save(retry);
    await client.save(retry);
    expect(spreadsheet.records('vehicle_events')).toHaveLength(2);
  });

  it('keeps changes while Google is unreachable and saves them once it is back', async () => {
    const working = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async () => new Response('<html>Sign in</html>', { status: 200 }));

    sync.markMissing(TABLE_NAMES);
    await expect(sync.flush()).rejects.toThrow(/Who has access: Anyone/);
    expect(sync.pendingChanges()).toBeGreaterThan(0);
    expect(sync.lastError).toMatch(/Apps Script/);

    vi.mocked(fetch).mockImplementation(working);
    await sync.flush();
    expect(sync.pendingChanges()).toBe(0);
    expect(sync.lastError).toBeNull();
    expect(await client.load()).toEqual(tables);
  });

  it('rejects requests with the wrong secret', async () => {
    const script = loadAppsScript('s3cret');
    vi.stubGlobal('fetch', vi.fn(script.fetchImpl));

    await expect(new GoogleSheetsClient(URL, 'wrong').load()).rejects.toThrow(/Wrong secret/);
    await expect(new GoogleSheetsClient(URL, 's3cret').load()).resolves.toEqual({});
  });
});

describe('Edits made by hand in the Google Sheet', () => {
  let spreadsheet: FakeSpreadsheet;
  let db: ExcelDatabase;

  beforeEach(async () => {
    const script = loadAppsScript();
    spreadsheet = script.spreadsheet;
    vi.stubGlobal('fetch', vi.fn(script.fetchImpl));
    db = new ExcelDatabase(path.join(os.tmpdir(), `wheelwash-reload-${process.pid}-${Date.now()}.xlsx`));
    await db.init(new GoogleSheetsClient(URL, ''));
    await db.flush();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const typeRow = (tab: string, cells: string[]) => spreadsheet.getSheetByName(tab)!.cells.push(cells);

  it('picks up rows added in the sheet without a restart', async () => {
    typeRow('vehicle_events', ['99', '1', '1', '2026/10/26 9:05', 'automatic']);

    expect(await db.reloadFromGoogleSheet()).toEqual(['vehicle_events']);
    expect(db.getVehicleEvents().find((e) => e.id === 99)?.event_timestamp).toBe('2026-10-26 09:05:00');
    expect(db.getEventsByLocationAndDate(1, '2026-10-26').map((e) => e.id)).toContain(99);

    // New local events continue after the highest id in the sheet
    expect(db.recordVehicleEvent({ location_id: 1, camera_id: 1, event_timestamp: '2026-10-26 10:00:00', detection_source: 'automatic' }).id).toBe(100);
  });

  it('reports nothing when the sheet was not edited', async () => {
    expect(await db.reloadFromGoogleSheet()).toEqual([]);
    db.recordVehicleEvent({ location_id: 1, camera_id: 1, event_timestamp: '2026-10-26 10:00:00', detection_source: 'automatic' });
    await db.flush();
    expect(await db.reloadFromGoogleSheet()).toEqual([]);
  });

  it('never drops a local change that the sheet does not have yet', async () => {
    typeRow('vehicle_events', ['50', '1', '1', '2026-10-26 08:00:00', 'automatic']);
    const reload = db.reloadFromGoogleSheet();
    const local = db.recordVehicleEvent({ location_id: 2, camera_id: 2, event_timestamp: '2026-10-26 08:30:00', detection_source: 'automatic' });

    expect(await reload).toEqual([]);
    expect(db.getVehicleEvents()).toContainEqual(local);

    // Once the local change is saved, the next reload brings in the sheet edit as well
    await db.flush();
    await db.reloadFromGoogleSheet();
    expect(db.getVehicleEvents().map((e) => e.id).sort((a, b) => a - b)).toEqual([local.id, 50].sort((a, b) => a - b));
  });
});

describe('normalizeDateText', () => {
  it('brings hand-typed dates into the stored format', () => {
    expect(normalizeDateText('2026-10-26 12:37:09')).toBe('2026-10-26 12:37:09');
    expect(normalizeDateText('2026/10/26 9:05')).toBe('2026-10-26 09:05:00');
    expect(normalizeDateText('2026-10-26T12:37:09.000')).toBe('2026-10-26 12:37:09');
    expect(normalizeDateText('2026-1-5')).toBe('2026-01-05');
    expect(normalizeDateText('duplicate trucks')).toBe('duplicate trucks');
  });
});
