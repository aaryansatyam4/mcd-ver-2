import type {
  User,
  Location,
  Camera,
  VehicleEvent,
  CountAdjustment,
  AuditLog,
} from '../models/types.js';

/**
 * Column layout of every table, shared by the Excel workbook and the Google Sheet.
 * Google Sheets hands every cell back as text, so each column also declares how to parse it.
 */
type ColumnType = 'number' | 'nullableNumber' | 'string' | 'nullableString';
type Column = { name: string; type: ColumnType; default?: number | string };

export interface Tables {
  locations: Location[];
  users: User[];
  cameras: Camera[];
  vehicle_events: VehicleEvent[];
  count_adjustments: CountAdjustment[];
  audit_logs: AuditLog[];
}

export type TableName = keyof Tables;

export const TABLE_COLUMNS: Record<TableName, Column[]> = {
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

export const TABLE_NAMES = Object.keys(TABLE_COLUMNS) as TableName[];

// Rows in these tables are only ever added, never edited, so they can be synced by appending
export const APPEND_ONLY_TABLES: TableName[] = ['vehicle_events', 'count_adjustments', 'audit_logs'];

export function tableHeaders(table: TableName): string[] {
  return TABLE_COLUMNS[table].map((c) => c.name);
}

/** Row object -> list of cell strings in column order */
export function toSheetRow(table: TableName, row: object): string[] {
  const record = row as Record<string, unknown>;
  return TABLE_COLUMNS[table].map((c) => {
    const value = record[c.name];
    return value === null || value === undefined ? '' : String(value);
  });
}

/** Cell values (looked up by header name) -> typed row object, or null when the row has no id */
export function fromSheetRow<T extends TableName>(
  table: T,
  headers: string[],
  cells: unknown[]
): Tables[T][number] | null {
  const record: Record<string, number | string | null> = {};

  for (const column of TABLE_COLUMNS[table]) {
    const index = headers.indexOf(column.name);
    const raw = index === -1 ? '' : String(cells[index] ?? '').trim();
    const empty = raw === '' || raw === 'null';

    switch (column.type) {
      case 'number':
        record[column.name] = empty ? ((column.default as number) ?? 0) : Number(raw);
        break;
      case 'nullableNumber':
        record[column.name] = empty ? null : Number(raw);
        break;
      case 'string':
        record[column.name] = empty ? ((column.default as string) ?? '') : raw;
        break;
      case 'nullableString':
        record[column.name] = empty ? null : raw;
        break;
    }
  }

  if (!record.id || Number.isNaN(record.id)) return null;
  return record as unknown as Tables[T][number];
}
