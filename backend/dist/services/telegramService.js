import { config } from '../config/index.js';
import { db } from '../database/excelDb.js';
import { logger } from '../utils/logger.js';
import { getKolkataDateString, getKolkataTimestamp } from '../utils/dateUtils.js';
import { CountService } from './countService.js';
/**
 * Sends the day's truck count to Telegram once a day at TELEGRAM_REPORT_TIME (IST).
 * Each message sent is written to the audit log, so a restart never sends the same day twice.
 */
export const TELEGRAM_DAILY_REPORT = 'TELEGRAM_DAILY_REPORT';
export const TELEGRAM_CONNECTED = 'TELEGRAM_CONNECTED';
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;
// A report missed while the server was down (e.g. a restart at midnight) is still sent until 06:00
const CATCH_UP_UNTIL = '06:00';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatDate(date) {
    const [year, month, day] = date.split('-').map(Number);
    return `${day} ${MONTHS[month - 1]} ${year}`;
}
function previousDay(date) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
}
/** "🚛 WheelWash – 26 Oct 2026 / Total trucks today: 130 / one line per site" */
export function buildDailyMessage(date, today = getKolkataDateString()) {
    const sites = db.getLocations().map((loc) => ({ name: loc.name, total: CountService.getLocationCount(loc.id, date).total }));
    const total = sites.reduce((sum, s) => sum + s.total, 0);
    return [
        `🚛 WheelWash – ${formatDate(date)}`,
        '',
        `Total trucks ${date === today ? 'today' : 'on this day'}: ${total}`,
        '',
        ...sites.map((s) => `${s.name}: ${s.total}`),
    ].join('\n');
}
export class TelegramClient {
    token;
    chatIds;
    constructor(token, chatIds) {
        this.token = token;
        this.chatIds = chatIds;
    }
    static fromConfig() {
        if (!config.telegramBotToken)
            return null;
        return new TelegramClient(config.telegramBotToken, config.telegramChatIds);
    }
    get hasChats() {
        return this.chatIds.length > 0;
    }
    get chatList() {
        return this.chatIds.join(',');
    }
    async call(method, body) {
        const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15_000),
        });
        const data = await res.json().catch(() => null);
        if (!data?.ok)
            throw new Error(data?.description || `Telegram answered HTTP ${res.status}`);
        return data.result;
    }
    /** Send to every configured chat; fails if any chat did not get it */
    async send(text) {
        const failures = [];
        for (const chatId of this.chatIds) {
            try {
                await this.call('sendMessage', { chat_id: chatId, text });
            }
            catch (err) {
                failures.push(`chat ${chatId}: ${err.message}`);
            }
        }
        if (failures.length > 0)
            throw new Error(failures.join('; '));
    }
    /** Chats that have messaged the bot, to help find TELEGRAM_CHAT_ID */
    async recentChats() {
        const updates = await this.call('getUpdates', {});
        const chats = new Map();
        for (const update of updates) {
            const chat = (update.message || update.channel_post || update.my_chat_member)?.chat;
            if (chat)
                chats.set(String(chat.id), chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || '');
        }
        return [...chats].map(([id, name]) => `${id} (${name})`);
    }
}
export class TelegramDailyReport {
    client;
    reportTime;
    timer = null;
    retryAt = 0;
    sending = false;
    constructor(client, reportTime // HH:MM, IST
    ) {
        this.client = client;
        this.reportTime = reportTime;
    }
    async start(checkEveryMs = 30_000) {
        if (!this.client.hasChats) {
            await this.logChatIdHelp();
            return;
        }
        await this.sendConnectedMessage();
        if (this.timer)
            clearInterval(this.timer);
        this.timer = setInterval(() => this.tick().catch(() => undefined), checkEveryMs);
        this.timer.unref();
        await this.tick();
    }
    stop() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
    }
    /** The day whose report should have gone out by now, or null if none is due */
    dueDate(now = new Date()) {
        const [today, time] = getKolkataTimestamp(now).split(' ');
        const hhmm = time.slice(0, 5);
        if (hhmm >= this.reportTime)
            return today;
        if (hhmm < CATCH_UP_UNTIL)
            return previousDay(today);
        return null;
    }
    alreadySent(date) {
        return db.auditLogs.some((log) => log.action === TELEGRAM_DAILY_REPORT && log.details.includes(`[date ${date}]`));
    }
    async tick(now = new Date()) {
        const date = this.dueDate(now);
        if (!date || this.sending || Date.now() < this.retryAt || this.alreadySent(date))
            return;
        this.sending = true;
        try {
            const text = buildDailyMessage(date, getKolkataDateString(now));
            await this.client.send(text);
            db.recordAuditLog({
                user_id: null,
                action: TELEGRAM_DAILY_REPORT,
                details: `Daily truck count sent to Telegram [date ${date}]`,
                created_at: getKolkataTimestamp(now),
            });
            logger.info(`[TELEGRAM] Daily truck count for ${date} sent`);
        }
        catch (err) {
            this.retryAt = Date.now() + RETRY_AFTER_FAILURE_MS;
            logger.warn(`[TELEGRAM] Could not send the daily truck count for ${date}: ${err.message}. Retrying in 10 minutes.`);
        }
        finally {
            this.sending = false;
        }
    }
    /** One message when a chat is set up (or the chats change), so it is clear the bot works */
    async sendConnectedMessage() {
        const marker = `[chats ${this.client.chatList}]`;
        if (db.auditLogs.some((log) => log.action === TELEGRAM_CONNECTED && log.details.includes(marker)))
            return;
        try {
            await this.client.send(`✅ WheelWash is connected.\nYou will get the day's truck count here every day at ${this.reportTime} (IST).`);
            db.recordAuditLog({
                user_id: null,
                action: TELEGRAM_CONNECTED,
                details: `Telegram daily truck count connected ${marker}`,
                created_at: getKolkataTimestamp(),
            });
            logger.info(`[TELEGRAM] Connected; daily truck count goes out at ${this.reportTime} IST`);
        }
        catch (err) {
            logger.warn(`[TELEGRAM] Could not send to Telegram: ${err.message}. Check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.`);
        }
    }
    async logChatIdHelp() {
        try {
            const chats = await this.client.recentChats();
            logger.warn(chats.length > 0
                ? `[TELEGRAM] TELEGRAM_CHAT_ID is not set. Chats that messaged the bot: ${chats.join(', ')}. Set TELEGRAM_CHAT_ID to one of these ids.`
                : '[TELEGRAM] TELEGRAM_CHAT_ID is not set. Send any message to the bot (or add it to your group), restart, and the chat id is shown here.');
        }
        catch (err) {
            logger.warn(`[TELEGRAM] Could not reach Telegram: ${err.message}. Check TELEGRAM_BOT_TOKEN.`);
        }
    }
}
export function startTelegramDailyReport() {
    const client = TelegramClient.fromConfig();
    if (!client)
        return null;
    const report = new TelegramDailyReport(client, config.telegramReportTime);
    report.start().catch((err) => logger.warn(`[TELEGRAM] ${err.message}`));
    return report;
}
