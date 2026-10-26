import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { getKolkataTimestamp } from '../utils/dateUtils.js';
import { APPEND_ONLY_TABLES, TABLE_NAMES, fromSheetRow, tableHeaders, toSheetRow, } from '../database/schema.js';
const NOT_DEPLOYED_HINT = 'Google did not return data from the Apps Script. Open the script, click Deploy > Manage deployments > Edit, ' +
    'make sure it is a "Web app" with "Execute as: Me" and "Who has access: Anyone", click Deploy, ' +
    'and use the URL that ends in /exec.';
/**
 * Talks to the Web App deployed from google-apps-script.js.
 * Every request is a POST so the shared secret never ends up in a URL.
 */
export class GoogleSheetsClient {
    url;
    secret;
    timeoutMs;
    spreadsheetUrl = null;
    constructor(url, secret, timeoutMs = config.googleScriptTimeoutMs) {
        this.url = url;
        this.secret = secret;
        this.timeoutMs = timeoutMs;
    }
    static fromConfig() {
        if (!config.googleScriptUrl)
            return null;
        if (!/^https?:\/\//.test(config.googleScriptUrl)) {
            logger.error(`GOOGLE_SCRIPT_URL must be the Web app URL (https://script.google.com/macros/s/.../exec)`);
            return null;
        }
        return new GoogleSheetsClient(config.googleScriptUrl, config.googleScriptSecret);
    }
    async call(body) {
        const res = await fetch(this.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, secret: this.secret }),
            redirect: 'follow',
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        const text = await res.text();
        let data;
        try {
            data = JSON.parse(text);
        }
        catch {
            throw new Error(`${NOT_DEPLOYED_HINT} (HTTP ${res.status})`);
        }
        if (data.status !== 'ok') {
            throw new Error(`Apps Script error: ${data.message || 'unknown error'}`);
        }
        if (data.spreadsheetUrl)
            this.spreadsheetUrl = data.spreadsheetUrl;
        return data;
    }
    /** Read every table from the sheet. Tables whose tab does not exist yet are left out. */
    async load() {
        const data = await this.call({ action: 'load' });
        const tables = {};
        for (const name of TABLE_NAMES) {
            const sheet = data.tables?.[name];
            if (!sheet)
                continue;
            tables[name] = sheet.rows
                .map((cells) => fromSheetRow(name, sheet.headers, cells))
                .filter((row) => row !== null);
        }
        return tables;
    }
    async save(payload) {
        await this.call({ action: 'save', ...payload });
    }
}
// Large backlogs (e.g. the first upload of an existing workbook) are sent in several requests
const APPEND_CHUNK_SIZE = 2000;
/**
 * Keeps the Google Sheet in step with the in-memory tables.
 * Edited tables (users, cameras, locations) are rewritten whole; append-only tables only send
 * the rows the sheet has not received yet. Failed pushes are retried with backoff, so nothing
 * is lost while Google is unreachable.
 */
export class GoogleSheetsSync {
    client;
    getTables;
    debounceMs;
    dirty = new Set();
    tabsToCreate = new Set();
    syncedCounts = {};
    timer = null;
    running = null;
    failures = 0;
    dashboardProvider = null;
    dashboardDue = false;
    lastSyncAt = null;
    lastError = null;
    constructor(client, getTables, debounceMs = 1500) {
        this.client = client;
        this.getTables = getTables;
        this.debounceMs = debounceMs;
    }
    /** Keep a readable Dashboard tab: sent with every save, and refreshed on a timer so "today" rolls over */
    setDashboardProvider(provider, refreshMs = 5 * 60_000) {
        this.dashboardProvider = provider;
        const refresh = () => {
            this.dashboardDue = true;
            this.schedule();
        };
        refresh();
        setInterval(refresh, refreshMs).unref();
    }
    /** Record that the sheet already holds these tables exactly as they are in memory */
    markInSync(tables) {
        const current = this.getTables();
        for (const name of tables) {
            this.dirty.delete(name);
            if (APPEND_ONLY_TABLES.includes(name))
                this.syncedCounts[name] = current[name].length;
        }
    }
    /** Record that the sheet is missing these tables, so they are uploaded in full */
    markMissing(tables) {
        for (const name of tables) {
            if (APPEND_ONLY_TABLES.includes(name)) {
                this.syncedCounts[name] = 0;
                this.tabsToCreate.add(name); // so the tab shows up even before it has rows
            }
            else {
                this.dirty.add(name);
            }
        }
        this.schedule();
    }
    markDirty(table) {
        // Append-only tables are detected by comparing row counts, so they only need a push scheduled
        if (!APPEND_ONLY_TABLES.includes(table))
            this.dirty.add(table);
        this.schedule();
    }
    pendingChanges() {
        const tables = this.getTables();
        const appended = APPEND_ONLY_TABLES.reduce((sum, name) => sum + tables[name].length - (this.syncedCounts[name] ?? 0), 0);
        return this.dirty.size + this.tabsToCreate.size + appended + (this.dashboardDue ? 1 : 0);
    }
    schedule(delay = this.debounceMs) {
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush().catch(() => undefined);
        }, delay);
    }
    /** Push everything that is pending. Resolves once the sheet is up to date or a push has failed. */
    async flush() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        // Only one push at a time; a flush requested meanwhile runs right after it
        while (this.running)
            await this.running.catch(() => undefined);
        if (this.pendingChanges() === 0)
            return;
        this.running = this.pushPending().finally(() => {
            this.running = null;
        });
        return this.running;
    }
    async pushPending() {
        while (this.pendingChanges() > 0) {
            const tables = this.getTables();
            const payload = { replace: {}, append: {} };
            const replaced = [...this.dirty];
            for (const name of replaced) {
                payload.replace[name] = {
                    headers: tableHeaders(name),
                    rows: tables[name].map((row) => toSheetRow(name, row)),
                };
            }
            const appended = {};
            const created = [...this.tabsToCreate];
            for (const name of APPEND_ONLY_TABLES) {
                const from = this.syncedCounts[name] ?? 0;
                const rows = tables[name].slice(from, from + APPEND_CHUNK_SIZE);
                if (rows.length === 0 && !created.includes(name))
                    continue;
                appended[name] = rows.length;
                payload.append[name] = {
                    headers: tableHeaders(name),
                    rows: rows.map((row) => toSheetRow(name, row)),
                };
            }
            const dashboardDue = this.dashboardDue;
            this.dashboardDue = false;
            if (this.dashboardProvider) {
                try {
                    payload.dashboard = this.dashboardProvider();
                }
                catch (err) {
                    logger.debug(`Could not build Google Sheet dashboard: ${err.message}`);
                }
            }
            // Clear before sending so edits made while the request is in flight are pushed again
            replaced.forEach((name) => this.dirty.delete(name));
            created.forEach((name) => this.tabsToCreate.delete(name));
            try {
                await this.client.save(payload);
            }
            catch (err) {
                replaced.forEach((name) => this.dirty.add(name));
                created.forEach((name) => this.tabsToCreate.add(name));
                if (dashboardDue)
                    this.dashboardDue = true;
                this.failures++;
                this.lastError = err.message;
                const retryIn = Math.min(60_000, 2000 * 2 ** (this.failures - 1));
                logger.warn(`[GOOGLE SHEETS] Save failed (${this.lastError}). ${this.pendingChanges()} change(s) kept, retrying in ${retryIn / 1000}s`);
                this.schedule(retryIn);
                throw err;
            }
            for (const [name, count] of Object.entries(appended)) {
                this.syncedCounts[name] = (this.syncedCounts[name] ?? 0) + count;
            }
            if (this.failures > 0)
                logger.info('[GOOGLE SHEETS] Connection restored, all changes saved');
            this.failures = 0;
            this.lastError = null;
            this.lastSyncAt = getKolkataTimestamp();
            logger.debug(`[GOOGLE SHEETS] Saved ${replaced.length} table(s), appended ${Object.values(appended).reduce((a, b) => a + b, 0)} row(s)`);
        }
    }
}
