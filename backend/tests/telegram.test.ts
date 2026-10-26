import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../src/database/excelDb.js';
import {
  TelegramClient,
  TelegramDailyReport,
  TELEGRAM_DAILY_REPORT,
  buildDailyMessage,
} from '../src/services/telegramService.js';

const DAY = '2025-06-01';
const at = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);

describe('Telegram daily truck count', () => {
  let sent: Array<{ method: string; body: any }>;
  let telegramOk: boolean;

  beforeAll(async () => {
    await db.init();
    const passages: Array<[number, string]> = [[1, '08:00'], [1, '09:30'], [2, '10:15'], [1, '23:10']];
    for (const [location_id, time] of passages) {
      db.recordVehicleEvent({ location_id, camera_id: location_id, event_timestamp: `${DAY} ${time}:00`, detection_source: 'automatic' });
    }
  });

  beforeEach(() => {
    sent = [];
    telegramOk = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const method = String(url).split('/').pop()!;
        sent.push({ method, body: JSON.parse(String(init.body)) });
        const payload = telegramOk ? { ok: true, result: method === 'getUpdates' ? [] : {} } : { ok: false, description: 'Unauthorized' };
        return new Response(JSON.stringify(payload), { status: telegramOk ? 200 : 401 });
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds the message: date, total and one line per site, nothing else', () => {
    expect(buildDailyMessage(DAY, DAY)).toBe(
      ['🚛 WheelWash – 1 Jun 2025', '', 'Total trucks today: 4', '', 'GHAZIPUR: 3', 'OKHLA: 1', 'BHALASWA: 0'].join('\n')
    );
    expect(buildDailyMessage(DAY, '2025-06-02')).toContain('Total trucks on this day: 4');
  });

  it('is due from the report time, and a missed report is still sent until 06:00 the next day', () => {
    const report = new TelegramDailyReport(new TelegramClient('token', ['111']), '23:55');
    expect(report.dueDate(at(DAY, '23:54'))).toBeNull();
    expect(report.dueDate(at(DAY, '23:55'))).toBe(DAY);
    expect(report.dueDate(at('2025-06-02', '00:30'))).toBe(DAY);
    expect(report.dueDate(at('2025-06-02', '06:00'))).toBeNull();
  });

  it('sends the day once to every chat, also across restarts', async () => {
    const report = new TelegramDailyReport(new TelegramClient('token', ['111', '-222']), '23:55');
    await report.tick(at(DAY, '23:56'));
    await report.tick(at(DAY, '23:58'));
    // A restarted server reads the audit log and does not send it again
    await new TelegramDailyReport(new TelegramClient('token', ['111', '-222']), '23:55').tick(at('2025-06-02', '00:10'));

    expect(sent.map((s) => [s.method, s.body.chat_id])).toEqual([
      ['sendMessage', '111'],
      ['sendMessage', '-222'],
    ]);
    expect(sent[0].body.text).toContain('Total trucks today: 4');
    expect(db.auditLogs.filter((l) => l.action === TELEGRAM_DAILY_REPORT && l.details.includes(`[date ${DAY}]`))).toHaveLength(1);
  });

  it('does not mark the day as sent when Telegram refuses, and waits before retrying', async () => {
    telegramOk = false;
    const report = new TelegramDailyReport(new TelegramClient('bad-token', ['111']), '20:00');
    await report.tick(at('2025-06-03', '20:01'));
    await report.tick(at('2025-06-03', '20:02'));

    expect(sent).toHaveLength(1);
    expect(report.alreadySent('2025-06-03')).toBe(false);
  });

  it('without a chat id it only looks up who messaged the bot', async () => {
    await new TelegramDailyReport(new TelegramClient('token', []), '23:55').start();
    expect(sent.map((s) => s.method)).toEqual(['getUpdates']);
  });

  it('says once that it is connected', async () => {
    const report = new TelegramDailyReport(new TelegramClient('token', ['333']), '23:55');
    await report.start(60_000);
    report.stop();
    await new TelegramDailyReport(new TelegramClient('token', ['333']), '23:55').start(60_000).then(() => undefined);

    const connected = sent.filter((s) => s.body.text?.startsWith('✅ WheelWash is connected'));
    expect(connected).toHaveLength(1);
    expect(connected[0].body.text).toContain('every day at 23:55 (IST)');
  });
});
