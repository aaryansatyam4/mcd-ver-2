export const TABLE_COLUMNS = {
    locations: [
        { name: 'id', type: 'number' },
        { name: 'name', type: 'string' },
        { name: 'active', type: 'number', default: 1 },
    ],
    users: [
        { name: 'id', type: 'number' },
        { name: 'username', type: 'string' },
        { name: 'password_hash', type: 'string' },
        { name: 'role', type: 'string', default: 'operator' },
        { name: 'assigned_location_id', type: 'nullableNumber' },
        { name: 'active', type: 'number', default: 1 },
        { name: 'must_change_password', type: 'number', default: 0 },
        { name: 'created_at', type: 'string' },
        { name: 'last_login', type: 'nullableString' },
    ],
    cameras: [
        { name: 'id', type: 'number' },
        { name: 'location_id', type: 'number' },
        { name: 'connection_configuration', type: 'string', default: '{}' },
        { name: 'detection_enabled', type: 'number', default: 1 },
        { name: 'status', type: 'string', default: 'online' },
        { name: 'detection_settings', type: 'string', default: '{}' },
    ],
    vehicle_events: [
        { name: 'id', type: 'number' },
        { name: 'location_id', type: 'number' },
        { name: 'camera_id', type: 'number' },
        { name: 'event_timestamp', type: 'string' },
        { name: 'detection_source', type: 'string', default: 'automatic' },
    ],
    count_adjustments: [
        { name: 'id', type: 'number' },
        { name: 'location_id', type: 'number' },
        { name: 'report_date', type: 'string' },
        { name: 'adjustment', type: 'number', default: 0 },
        { name: 'previous_total', type: 'number', default: 0 },
        { name: 'corrected_total', type: 'number', default: 0 },
        { name: 'reason', type: 'string' },
        { name: 'modified_by', type: 'number', default: 1 },
        { name: 'created_at', type: 'string' },
    ],
    audit_logs: [
        { name: 'id', type: 'number' },
        { name: 'user_id', type: 'nullableNumber' },
        { name: 'action', type: 'string' },
        { name: 'details', type: 'string' },
        { name: 'created_at', type: 'string' },
    ],
};
export const TABLE_NAMES = Object.keys(TABLE_COLUMNS);
// Rows in these tables are only ever added, never edited, so they can be synced by appending
export const APPEND_ONLY_TABLES = ['vehicle_events', 'count_adjustments', 'audit_logs'];
// Date / time columns. Reports match them as text ("2026-10-26 12:37:09" starts with "2026-10-26"),
// so values typed by hand in the sheet are brought into that exact form.
const DATE_COLUMNS = new Set(['event_timestamp', 'report_date', 'created_at', 'last_login']);
const DATE_PATTERN = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/;
/** "2026/10/26 9:05" -> "2026-10-26 09:05:00". Anything that is not a date is returned as is. */
export function normalizeDateText(raw) {
    const m = DATE_PATTERN.exec(raw);
    if (!m)
        return raw;
    const pad = (v) => (v ?? '0').padStart(2, '0');
    const date = `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    return m[4] === undefined ? date : `${date} ${pad(m[4])}:${pad(m[5])}:${pad(m[6])}`;
}
export function tableHeaders(table) {
    return TABLE_COLUMNS[table].map((c) => c.name);
}
/** Row object -> list of cell strings in column order */
export function toSheetRow(table, row) {
    const record = row;
    return TABLE_COLUMNS[table].map((c) => {
        const value = record[c.name];
        return value === null || value === undefined ? '' : String(value);
    });
}
/** Cell values (looked up by header name) -> typed row object, or null when the row has no id */
export function fromSheetRow(table, headers, cells) {
    const record = {};
    for (const column of TABLE_COLUMNS[table]) {
        const index = headers.indexOf(column.name);
        let raw = index === -1 ? '' : String(cells[index] ?? '').trim();
        if (DATE_COLUMNS.has(column.name))
            raw = normalizeDateText(raw);
        const empty = raw === '' || raw === 'null';
        switch (column.type) {
            case 'number':
                record[column.name] = empty ? (column.default ?? 0) : Number(raw);
                break;
            case 'nullableNumber':
                record[column.name] = empty ? null : Number(raw);
                break;
            case 'string':
                record[column.name] = empty ? (column.default ?? '') : raw;
                break;
            case 'nullableString':
                record[column.name] = empty ? null : raw;
                break;
        }
    }
    if (!record.id || Number.isNaN(record.id))
        return null;
    return record;
}
