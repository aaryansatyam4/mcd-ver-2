import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { getKolkataTimestamp } from '../utils/dateUtils.js';
import { GoogleSheetsClient, GoogleSheetsSync } from '../services/googleSheetsStore.js';
import { APPEND_ONLY_TABLES, TABLE_NAMES, toSheetRow } from './schema.js';
export class ExcelDatabase {
    filePath;
    isSaving = false;
    saveTimeout = null;
    sheetsError = null;
    isReloading = false;
    // Set when GOOGLE_SCRIPT_URL is configured and the sheet could be reached at startup
    sheets = null;
    // In-memory data tables
    users = [];
    locations = [];
    cameras = [];
    vehicleEvents = [];
    countAdjustments = [];
    auditLogs = [];
    constructor(filePath) {
        this.filePath = filePath;
    }
    async init(sheetsClient = GoogleSheetsClient.fromConfig()) {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        if (fs.existsSync(this.filePath)) {
            logger.info(`Loading existing database from Excel file: ${this.filePath}`);
            await this.loadFromDisk();
        }
        else {
            logger.info(`Excel database not found. Creating and seeding initial database at: ${this.filePath}`);
            await this.seedInitialDatabase();
            await this.saveToDisk();
        }
        if (sheetsClient)
            await this.connectGoogleSheets(sheetsClient);
    }
    /**
     * Make the Google Sheet the source of truth: every table found in the sheet replaces the
     * local copy, and tables the sheet does not have yet are uploaded from the local copy.
     */
    async connectGoogleSheets(client) {
        let remote = null;
        for (let attempt = 1; attempt <= 3 && !remote; attempt++) {
            try {
                logger.info('Loading database from Google Sheet...');
                remote = await client.load();
            }
            catch (err) {
                this.sheetsError = err.message;
                logger.warn(`Could not reach the Google Sheet (attempt ${attempt}/3): ${this.sheetsError}`);
                if (attempt < 3)
                    await new Promise((r) => setTimeout(r, 2000 * attempt));
            }
        }
        if (!remote) {
            logger.error('Google Sheet unreachable. Running on the local Excel file only; changes made until the next restart will NOT reach the sheet.');
            return;
        }
        this.sheetsError = null;
        this.sheets = new GoogleSheetsSync(client, () => this.snapshot());
        await this.applySheetTables(remote);
        await this.saveToDisk();
        logger.info(`Google Sheet database connected: ${this.users.length} users, ${this.vehicleEvents.length} events, ${this.countAdjustments.length} adjustments`);
    }
    /**
     * Replace the in-memory tables with the ones read from the sheet. Returns the tables whose
     * contents changed.
     */
    async applySheetTables(remote) {
        const sheets = this.sheets;
        const current = this.snapshot();
        // A tab that exists in the sheet wins, even when empty. The exception is an empty
        // locations/users/cameras tab, which would lock everyone out, so the local copy is uploaded.
        const fromSheet = TABLE_NAMES.filter((name) => remote[name] !== undefined && (APPEND_ONLY_TABLES.includes(name) || remote[name].length > 0));
        const missing = TABLE_NAMES.filter((name) => !fromSheet.includes(name));
        const asCells = (name, rows) => JSON.stringify(rows.map((row) => toSheetRow(name, row)));
        const changed = fromSheet.filter((name) => asCells(name, current[name]) !== asCells(name, remote[name]));
        for (const name of fromSheet)
            this.setTable(name, remote[name]);
        sheets.markInSync(fromSheet);
        if (missing.length > 0) {
            logger.info(`Uploading to Google Sheet (not there yet): ${missing.join(', ')}`);
            sheets.markMissing(missing);
            await sheets.flush().catch(() => undefined); // keeps retrying in the background on failure
        }
        return changed;
    }
    /**
     * Pick up edits made by hand in the Google Sheet. Skipped while local changes are still being
     * saved (the sheet would not have them yet), and thrown away if a local change happens while
     * the sheet is being read. Returns the tables that changed.
     */
    async reloadFromGoogleSheet() {
        const sheets = this.sheets;
        if (!sheets || this.isReloading || sheets.hasUnsavedData())
            return [];
        this.isReloading = true;
        try {
            const changesBefore = sheets.changeCount;
            const remote = await sheets.client.load();
            if (sheets.changeCount !== changesBefore || sheets.hasUnsavedData())
                return [];
            const changed = await this.applySheetTables(remote);
            if (changed.length > 0) {
                logger.info(`[GOOGLE SHEETS] Reloaded edits made in the sheet: ${changed.join(', ')}`);
                sheets.refreshDashboard();
                await this.saveToDisk();
            }
            return changed;
        }
        catch (err) {
            logger.warn(`[GOOGLE SHEETS] Could not reload the sheet: ${err.message}`);
            return [];
        }
        finally {
            this.isReloading = false;
        }
    }
    /** Reload the sheet every `intervalMs`, calling `onChange` when something was edited there */
    startGoogleSheetReload(intervalMs, onChange) {
        if (!this.sheets || intervalMs <= 0)
            return;
        setInterval(() => {
            this.reloadFromGoogleSheet()
                .then((changed) => {
                if (changed.length > 0)
                    onChange(changed);
            })
                .catch(() => undefined);
        }, intervalMs).unref();
    }
    snapshot() {
        return {
            locations: this.locations,
            users: this.users,
            cameras: this.cameras,
            vehicle_events: this.vehicleEvents,
            count_adjustments: this.countAdjustments,
            audit_logs: this.auditLogs,
        };
    }
    setTable(name, rows) {
        switch (name) {
            case 'locations':
                this.locations = rows;
                break;
            case 'users':
                this.users = rows;
                break;
            case 'cameras':
                this.cameras = rows;
                break;
            case 'vehicle_events':
                this.vehicleEvents = rows;
                break;
            case 'count_adjustments':
                this.countAdjustments = rows;
                break;
            case 'audit_logs':
                this.auditLogs = rows;
                break;
        }
    }
    getStorageStatus() {
        return {
            mode: this.sheets ? 'google-sheets' : 'excel',
            googleSheetConfigured: Boolean(config.googleScriptUrl),
            spreadsheetUrl: this.sheets?.client.spreadsheetUrl ?? null,
            lastSyncAt: this.sheets?.lastSyncAt ?? null,
            pendingChanges: this.sheets?.pendingChanges() ?? 0,
            error: this.sheets?.lastError ?? this.sheetsError,
        };
    }
    /** Write everything out (local file and Google Sheet), e.g. before shutting down */
    async flush() {
        await this.saveToDisk();
        await this.sheets?.flush().catch(() => undefined);
    }
    /**
     * Seed the initial 3 locations, 5 default users, and 3 cameras
     */
    async seedInitialDatabase() {
        const timestamp = getKolkataTimestamp();
        const defaultPasswordHash = bcrypt.hashSync('123456', 10);
        // 1. Locations
        this.locations = [
            { id: 1, name: 'GHAZIPUR', active: 1 },
            { id: 2, name: 'OKHLA', active: 1 },
            { id: 3, name: 'BHALASWA', active: 1 },
        ];
        // 2. Users (5 accounts as specified in prompt)
        this.users = [
            {
                id: 1,
                username: 'admin',
                password_hash: defaultPasswordHash,
                role: 'admin',
                assigned_location_id: null,
                active: 1,
                must_change_password: 0,
                created_at: timestamp,
                last_login: null,
            },
            {
                id: 2,
                username: 'ghazipur',
                password_hash: defaultPasswordHash,
                role: 'operator',
                assigned_location_id: 1,
                active: 1,
                must_change_password: 0,
                created_at: timestamp,
                last_login: null,
            },
            {
                id: 3,
                username: 'okhla',
                password_hash: defaultPasswordHash,
                role: 'operator',
                assigned_location_id: 2,
                active: 1,
                must_change_password: 0,
                created_at: timestamp,
                last_login: null,
            },
            {
                id: 4,
                username: 'bhalaswa',
                password_hash: defaultPasswordHash,
                role: 'operator',
                assigned_location_id: 3,
                active: 1,
                must_change_password: 0,
                created_at: timestamp,
                last_login: null,
            },
            {
                id: 5,
                username: 'monitoring',
                password_hash: defaultPasswordHash,
                role: 'monitoring',
                assigned_location_id: null,
                active: 1,
                must_change_password: 0,
                created_at: timestamp,
                last_login: null,
            },
        ];
        // 3. Cameras
        const defaultSettings = (locationId) => JSON.stringify({
            roi: { x: 20, y: 35, width: 60, height: 45 },
            sensitivity: 65,
            minDurationMs: 1200,
            cooldownSeconds: 5,
            direction: 'any',
        });
        this.cameras = [
            {
                id: 1,
                location_id: 1,
                connection_configuration: JSON.stringify({
                    rtspUrl: 'rtsp://admin:pass@192.168.1.101:554/live/ch0',
                    ip: '192.168.1.101',
                    port: 554,
                    name: 'Ghazipur Wheel Wash Cam',
                }),
                detection_enabled: 1,
                status: 'online',
                detection_settings: defaultSettings(1),
            },
            {
                id: 2,
                location_id: 2,
                connection_configuration: JSON.stringify({
                    rtspUrl: 'rtsp://admin:pass@192.168.1.102:554/live/ch0',
                    ip: '192.168.1.102',
                    port: 554,
                    name: 'Okhla Wheel Wash Cam',
                }),
                detection_enabled: 1,
                status: 'online',
                detection_settings: defaultSettings(2),
            },
            {
                id: 3,
                location_id: 3,
                connection_configuration: JSON.stringify({
                    rtspUrl: 'rtsp://admin:pass@192.168.1.103:554/live/ch0',
                    ip: '192.168.1.103',
                    port: 554,
                    name: 'Bhalaswa Wheel Wash Cam',
                }),
                detection_enabled: 1,
                status: 'online',
                detection_settings: defaultSettings(3),
            },
        ];
        // Initial audit log
        this.auditLogs = [
            {
                id: 1,
                user_id: 1,
                action: 'SYSTEM_INIT',
                details: 'Initial WheelWash database seeded with 3 locations and 5 user accounts',
                created_at: timestamp,
            },
        ];
        this.vehicleEvents = [];
        this.countAdjustments = [];
    }
    /**
     * Load data from existing Excel file
     */
    async loadFromDisk() {
        try {
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.readFile(this.filePath);
            // 1. Locations
            const locSheet = workbook.getWorksheet('locations');
            if (locSheet) {
                this.locations = [];
                locSheet.eachRow((row, rowNumber) => {
                    if (rowNumber === 1)
                        return; // Header
                    const id = Number(row.getCell(1).value);
                    const name = String(row.getCell(2).value || '');
                    const active = Number(row.getCell(3).value || 1);
                    if (id && name) {
                        this.locations.push({ id, name, active });
                    }
                });
            }
            // 2. Users
            const userSheet = workbook.getWorksheet('users');
            if (userSheet) {
                this.users = [];
                userSheet.eachRow((row, rowNumber) => {
                    if (rowNumber === 1)
                        return;
                    const id = Number(row.getCell(1).value);
                    const username = String(row.getCell(2).value || '');
                    const password_hash = String(row.getCell(3).value || '');
                    const role = String(row.getCell(4).value || 'operator');
                    const assigned_location_id = row.getCell(5).value ? Number(row.getCell(5).value) : null;
                    const active = Number(row.getCell(6).value || 1);
                    const must_change_password = Number(row.getCell(7).value || 0);
                    const created_at = String(row.getCell(8).value || '');
                    const last_login = row.getCell(9).value ? String(row.getCell(9).value) : null;
                    if (id && username) {
                        this.users.push({
                            id,
                            username,
                            password_hash,
                            role,
                            assigned_location_id,
                            active,
                            must_change_password,
                            created_at,
                            last_login,
                        });
                    }
                });
            }
            // 3. Cameras
            const camSheet = workbook.getWorksheet('cameras');
            if (camSheet) {
                this.cameras = [];
                camSheet.eachRow((row, rowNumber) => {
                    if (rowNumber === 1)
                        return;
                    const id = Number(row.getCell(1).value);
                    const location_id = Number(row.getCell(2).value);
                    const connection_configuration = String(row.getCell(3).value || '{}');
                    const detection_enabled = Number(row.getCell(4).value || 1);
                    const status = String(row.getCell(5).value || 'online');
                    const detection_settings = String(row.getCell(6).value || '{}');
                    if (id && location_id) {
                        this.cameras.push({
                            id,
                            location_id,
                            connection_configuration,
                            detection_enabled,
                            status,
                            detection_settings,
                        });
                    }
                });
            }
            // 4. Vehicle Events
            const eventSheet = workbook.getWorksheet('vehicle_events');
            if (eventSheet) {
                this.vehicleEvents = [];
                eventSheet.eachRow((row, rowNumber) => {
                    if (rowNumber === 1)
                        return;
                    const id = Number(row.getCell(1).value);
                    const location_id = Number(row.getCell(2).value);
                    const camera_id = Number(row.getCell(3).value);
                    const event_timestamp = String(row.getCell(4).value || '');
                    const detection_source = String(row.getCell(5).value || 'automatic');
                    if (id && location_id) {
                        this.vehicleEvents.push({
                            id,
                            location_id,
                            camera_id,
                            event_timestamp,
                            detection_source,
                        });
                    }
                });
            }
            // 5. Count Adjustments
            const adjSheet = workbook.getWorksheet('count_adjustments');
            if (adjSheet) {
                this.countAdjustments = [];
                adjSheet.eachRow((row, rowNumber) => {
                    if (rowNumber === 1)
                        return;
                    const id = Number(row.getCell(1).value);
                    const location_id = Number(row.getCell(2).value);
                    const report_date = String(row.getCell(3).value || '');
                    const adjustment = Number(row.getCell(4).value || 0);
                    const previous_total = Number(row.getCell(5).value || 0);
                    const corrected_total = Number(row.getCell(6).value || 0);
                    const reason = String(row.getCell(7).value || '');
                    const modified_by = Number(row.getCell(8).value || 1);
                    const created_at = String(row.getCell(9).value || '');
                    if (id && location_id) {
                        this.countAdjustments.push({
                            id,
                            location_id,
                            report_date,
                            adjustment,
                            previous_total,
                            corrected_total,
                            reason,
                            modified_by,
                            created_at,
                        });
                    }
                });
            }
            // 6. Audit Logs
            const auditSheet = workbook.getWorksheet('audit_logs');
            if (auditSheet) {
                this.auditLogs = [];
                auditSheet.eachRow((row, rowNumber) => {
                    if (rowNumber === 1)
                        return;
                    const id = Number(row.getCell(1).value);
                    const user_id = row.getCell(2).value ? Number(row.getCell(2).value) : null;
                    const action = String(row.getCell(3).value || '');
                    const details = String(row.getCell(4).value || '');
                    const created_at = String(row.getCell(5).value || '');
                    if (id && action) {
                        this.auditLogs.push({
                            id,
                            user_id,
                            action,
                            details,
                            created_at,
                        });
                    }
                });
            }
            logger.info(`Excel database loaded successfully: ${this.locations.length} locations, ${this.users.length} users, ${this.cameras.length} cameras, ${this.vehicleEvents.length} events, ${this.countAdjustments.length} adjustments, ${this.auditLogs.length} audit logs`);
        }
        catch (err) {
            logger.error('Failed to load database from Excel, re-initializing:', err);
            await this.seedInitialDatabase();
            await this.saveToDisk();
        }
    }
    /**
     * Schedule a debounced flush to the Excel file, and to the Google Sheet when connected
     */
    queueSave(table) {
        this.sheets?.markDirty(table);
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }
        this.saveTimeout = setTimeout(() => {
            this.saveToDisk().catch((err) => {
                logger.error('Error saving Excel database to disk:', err);
            });
        }, 200);
    }
    /**
     * Save all in-memory tables to the Excel workbook with clean corporate formatting
     */
    async saveToDisk() {
        if (this.isSaving)
            return;
        this.isSaving = true;
        try {
            const workbook = new ExcelJS.Workbook();
            workbook.creator = 'WheelWash Monitor';
            workbook.lastModifiedBy = 'WheelWash Monitor System';
            workbook.created = new Date();
            workbook.modified = new Date();
            const headerFill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FF0F172A' }, // Slate 900
            };
            const headerFont = {
                name: 'Segoe UI',
                size: 11,
                bold: true,
                color: { argb: 'FFFFFFFF' },
            };
            // Helper to style worksheet headers
            const formatSheet = (sheet) => {
                const headerRow = sheet.getRow(1);
                headerRow.font = headerFont;
                headerRow.fill = headerFill;
                headerRow.height = 24;
                headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
                sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];
            };
            // 1. locations
            const locSheet = workbook.addWorksheet('locations');
            locSheet.columns = [
                { header: 'id', key: 'id', width: 8 },
                { header: 'name', key: 'name', width: 22 },
                { header: 'active', key: 'active', width: 10 },
            ];
            this.locations.forEach((loc) => locSheet.addRow(loc));
            formatSheet(locSheet);
            // 2. users
            const userSheet = workbook.addWorksheet('users');
            userSheet.columns = [
                { header: 'id', key: 'id', width: 8 },
                { header: 'username', key: 'username', width: 20 },
                { header: 'password_hash', key: 'password_hash', width: 35 },
                { header: 'role', key: 'role', width: 15 },
                { header: 'assigned_location_id', key: 'assigned_location_id', width: 22 },
                { header: 'active', key: 'active', width: 10 },
                { header: 'must_change_password', key: 'must_change_password', width: 22 },
                { header: 'created_at', key: 'created_at', width: 22 },
                { header: 'last_login', key: 'last_login', width: 22 },
            ];
            this.users.forEach((u) => userSheet.addRow(u));
            formatSheet(userSheet);
            // 3. cameras
            const camSheet = workbook.addWorksheet('cameras');
            camSheet.columns = [
                { header: 'id', key: 'id', width: 8 },
                { header: 'location_id', key: 'location_id', width: 14 },
                { header: 'connection_configuration', key: 'connection_configuration', width: 45 },
                { header: 'detection_enabled', key: 'detection_enabled', width: 18 },
                { header: 'status', key: 'status', width: 15 },
                { header: 'detection_settings', key: 'detection_settings', width: 50 },
            ];
            this.cameras.forEach((c) => camSheet.addRow(c));
            formatSheet(camSheet);
            // 4. vehicle_events
            const eventSheet = workbook.addWorksheet('vehicle_events');
            eventSheet.columns = [
                { header: 'id', key: 'id', width: 10 },
                { header: 'location_id', key: 'location_id', width: 14 },
                { header: 'camera_id', key: 'camera_id', width: 12 },
                { header: 'event_timestamp', key: 'event_timestamp', width: 24 },
                { header: 'detection_source', key: 'detection_source', width: 20 },
            ];
            this.vehicleEvents.forEach((e) => eventSheet.addRow(e));
            formatSheet(eventSheet);
            // 5. count_adjustments
            const adjSheet = workbook.addWorksheet('count_adjustments');
            adjSheet.columns = [
                { header: 'id', key: 'id', width: 8 },
                { header: 'location_id', key: 'location_id', width: 14 },
                { header: 'report_date', key: 'report_date', width: 16 },
                { header: 'adjustment', key: 'adjustment', width: 14 },
                { header: 'previous_total', key: 'previous_total', width: 16 },
                { header: 'corrected_total', key: 'corrected_total', width: 16 },
                { header: 'reason', key: 'reason', width: 35 },
                { header: 'modified_by', key: 'modified_by', width: 14 },
                { header: 'created_at', key: 'created_at', width: 24 },
            ];
            this.countAdjustments.forEach((a) => adjSheet.addRow(a));
            formatSheet(adjSheet);
            // 6. audit_logs
            const auditSheet = workbook.addWorksheet('audit_logs');
            auditSheet.columns = [
                { header: 'id', key: 'id', width: 8 },
                { header: 'user_id', key: 'user_id', width: 12 },
                { header: 'action', key: 'action', width: 25 },
                { header: 'details', key: 'details', width: 50 },
                { header: 'created_at', key: 'created_at', width: 24 },
            ];
            this.auditLogs.forEach((l) => auditSheet.addRow(l));
            formatSheet(auditSheet);
            // Write atomically via a temp file to avoid file corruption
            const tempPath = `${this.filePath}.tmp`;
            await workbook.xlsx.writeFile(tempPath);
            if (fs.existsSync(tempPath)) {
                fs.renameSync(tempPath, this.filePath);
            }
            logger.debug(`Excel database saved successfully to ${this.filePath}`);
        }
        catch (err) {
            logger.error('Failed to write Excel database:', err);
        }
        finally {
            this.isSaving = false;
        }
    }
    // --- QUERY & MUTATION HELPERS ---
    // Locations
    getLocations() {
        return [...this.locations];
    }
    getLocationById(id) {
        return this.locations.find((l) => l.id === id);
    }
    // Users
    getUsers() {
        return [...this.users];
    }
    getUserById(id) {
        return this.users.find((u) => u.id === id);
    }
    getUserByUsername(username) {
        return this.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
    }
    createUser(user) {
        const nextId = this.users.length > 0 ? Math.max(...this.users.map((u) => u.id)) + 1 : 1;
        const newUser = { ...user, id: nextId };
        this.users.push(newUser);
        this.queueSave('users');
        return newUser;
    }
    updateUser(id, updates) {
        const index = this.users.findIndex((u) => u.id === id);
        if (index === -1)
            return undefined;
        this.users[index] = { ...this.users[index], ...updates };
        this.queueSave('users');
        return this.users[index];
    }
    // Cameras
    getCameras() {
        return [...this.cameras];
    }
    getCameraById(id) {
        return this.cameras.find((c) => c.id === id);
    }
    getCameraByLocationId(locationId) {
        return this.cameras.find((c) => c.location_id === locationId);
    }
    updateCamera(id, updates) {
        const index = this.cameras.findIndex((c) => c.id === id);
        if (index === -1)
            return undefined;
        this.cameras[index] = { ...this.cameras[index], ...updates };
        this.queueSave('cameras');
        return this.cameras[index];
    }
    // Vehicle Events
    getVehicleEvents() {
        return [...this.vehicleEvents];
    }
    recordVehicleEvent(event) {
        const nextId = this.vehicleEvents.length > 0 ? Math.max(...this.vehicleEvents.map((e) => e.id)) + 1 : 1;
        const newEvent = { ...event, id: nextId };
        this.vehicleEvents.push(newEvent);
        this.queueSave('vehicle_events');
        return newEvent;
    }
    getEventsByLocationAndDate(locationId, dateStr) {
        return this.vehicleEvents.filter((e) => e.location_id === locationId && e.event_timestamp.startsWith(dateStr));
    }
    getLatestEventByLocation(locationId) {
        const filtered = this.vehicleEvents
            .filter((e) => e.location_id === locationId)
            .sort((a, b) => b.event_timestamp.localeCompare(a.event_timestamp));
        return filtered[0];
    }
    // Count Adjustments
    getCountAdjustments() {
        return [...this.countAdjustments];
    }
    getAdjustmentsByLocationAndDate(locationId, dateStr) {
        return this.countAdjustments.filter((a) => a.location_id === locationId && a.report_date === dateStr);
    }
    recordCountAdjustment(adj) {
        const nextId = this.countAdjustments.length > 0 ? Math.max(...this.countAdjustments.map((a) => a.id)) + 1 : 1;
        const newAdj = { ...adj, id: nextId };
        this.countAdjustments.push(newAdj);
        this.queueSave('count_adjustments');
        return newAdj;
    }
    // Audit Logs
    getAuditLogs() {
        return this.auditLogs
            .filter((l) => l.action !== 'COUNT_ADJUSTMENT')
            .sort((a, b) => b.created_at.localeCompare(a.created_at));
    }
    recordAuditLog(log) {
        const nextId = this.auditLogs.length > 0 ? Math.max(...this.auditLogs.map((l) => l.id)) + 1 : 1;
        const newLog = { ...log, id: nextId };
        this.auditLogs.push(newLog);
        this.queueSave('audit_logs');
        return newLog;
    }
}
// Export singleton database instance initialized with public path
export const db = new ExcelDatabase(config.excelDbPath);
