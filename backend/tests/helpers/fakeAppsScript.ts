import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

/**
 * Runs the real google-apps-script.js in Node against an in-memory spreadsheet,
 * covering just the parts of SpreadsheetApp / ContentService / LockService it uses.
 */
const SCRIPT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'google-apps-script.js');

class FakeRange {
  constructor(
    private sheet: FakeSheet,
    private row: number,
    private col: number,
    private rows: number,
    private cols: number
  ) {}

  getDisplayValues(): string[][] {
    const out: string[][] = [];
    for (let r = 0; r < this.rows; r++) {
      const line: string[] = [];
      for (let c = 0; c < this.cols; c++) {
        const raw = this.sheet.cells[this.row - 1 + r]?.[this.col - 1 + c] ?? '';
        line.push(raw.startsWith("'") ? raw.slice(1) : raw);
      }
      out.push(line);
    }
    return out;
  }

  setValues(values: string[][]): FakeRange {
    if (values.length !== this.rows || values.some((v) => v.length !== this.cols)) {
      throw new Error('The number of rows or columns in the data does not match the range');
    }
    values.forEach((line, r) => {
      const target = (this.sheet.cells[this.row - 1 + r] ??= []);
      line.forEach((value, c) => (target[this.col - 1 + c] = value));
    });
    for (let i = 0; i < this.sheet.cells.length; i++) this.sheet.cells[i] ??= [];
    return this;
  }

  setNumberFormat(): FakeRange {
    return this;
  }
  setFontWeight(): FakeRange {
    return this;
  }
  setBackground(): FakeRange {
    return this;
  }
  setFontColor(): FakeRange {
    return this;
  }
}

class FakeSheet {
  cells: string[][] = [];
  constructor(public name: string) {}

  getLastRow(): number {
    let last = this.cells.length;
    while (last > 0 && !(this.cells[last - 1] ?? []).some((v) => v)) last--;
    return last;
  }
  getLastColumn(): number {
    return Math.max(0, ...this.cells.map((r) => r.length));
  }
  getRange(row: number, col: number, rows = 1, cols = 1): FakeRange {
    return new FakeRange(this, row, col, rows, cols);
  }
  clearContents(): void {
    this.cells = [];
  }
  setFrozenRows(): void {}
}

export class FakeSpreadsheet {
  sheets: FakeSheet[] = [];
  getUrl(): string {
    return 'https://docs.google.com/spreadsheets/d/fake-sheet-id/edit';
  }
  getSheetByName(name: string): FakeSheet | null {
    return this.sheets.find((s) => s.name === name) ?? null;
  }
  insertSheet(name: string): FakeSheet {
    const sheet = new FakeSheet(name);
    this.sheets.push(sheet);
    return sheet;
  }
  private active: FakeSheet | null = null;
  setActiveSheet(sheet: FakeSheet): void {
    this.active = sheet;
  }
  moveActiveSheet(position: number): void {
    if (!this.active) return;
    this.sheets = this.sheets.filter((s) => s !== this.active);
    this.sheets.splice(position - 1, 0, this.active);
  }

  /** Data rows of a tab as objects keyed by header (what a person sees in the sheet) */
  records(name: string): Record<string, string>[] {
    const sheet = this.getSheetByName(name);
    if (!sheet || sheet.getLastRow() === 0) return [];
    const [headers, ...rows] = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getDisplayValues();
    return rows.map((row) => Object.fromEntries(headers.map((h, i) => [h, row[i]])));
  }
}

export function loadAppsScript(secret = '') {
  const spreadsheet = new FakeSpreadsheet();
  const context = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (content: string) => ({
        setMimeType() {
          return this;
        },
        getContent: () => content,
      }),
    },
  });
  const source = fs.readFileSync(SCRIPT_PATH, 'utf8').replace("var SECRET_KEY = '';", `var SECRET_KEY = ${JSON.stringify(secret)};`);
  vm.runInContext(source, context);

  const doPost = context.doPost as (e: unknown) => { getContent(): string };

  /** A fetch() stand-in that delivers requests to the script's doPost like the Web app would */
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    const output = doPost({ postData: { contents: String(init?.body ?? '') } });
    return new Response(output.getContent(), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  return { spreadsheet, doPost, fetchImpl };
}
