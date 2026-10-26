/**
 * ==============================================================================
 * MCD WHEELWASH MONITOR — GOOGLE SHEET DATABASE (Google Apps Script)
 * ==============================================================================
 *
 * This script turns a Google Sheet into the WheelWash database. The backend loads
 * all data from the sheet when it starts and writes every change back within a
 * couple of seconds, so nothing is lost when the server restarts.
 *
 * SETUP (about 5 minutes, one time):
 *   1. Create a new, empty Google Sheet (sheets.new).
 *   2. Extensions > Apps Script. Delete the sample code and paste this whole file.
 *   3. Optional but recommended: type a password between the quotes of SECRET_KEY
 *      below, and use the same value for GOOGLE_SCRIPT_SECRET on the backend.
 *   4. Click Save, then Deploy > New deployment > gear icon > "Web app".
 *        Execute as:      Me
 *        Who has access:  Anyone
 *      Click Deploy and allow access when Google asks.
 *   5. Copy the "Web app URL" (ends in /exec) and set it as GOOGLE_SCRIPT_URL
 *      on the backend (Render > wheelwash-backend > Environment), then redeploy.
 *
 * On first start the backend fills the sheet with the existing data. Tabs:
 *   Dashboard          today's truck count per site (refreshed on every change)
 *   locations, users, cameras, vehicle_events, count_adjustments, audit_logs
 *
 * Edit data through the WheelWash app. If you edit the data tabs by hand,
 * restart the backend afterwards so it reloads them.
 *
 * After changing this script, use Deploy > Manage deployments > Edit >
 * Version: "New version" > Deploy, so the same URL keeps working.
 */

var SECRET_KEY = '';

var TABLES = ['locations', 'users', 'cameras', 'vehicle_events', 'count_adjustments', 'audit_logs'];
var DASHBOARD_TAB = 'Dashboard';

/** Opening the Web app URL in a browser shows whether the script is online */
function doGet() {
  return jsonResponse({
    status: 'ok',
    message: 'WheelWash Google Sheet database is online.',
    spreadsheetUrl: SpreadsheetApp.getActiveSpreadsheet().getUrl(),
  });
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (SECRET_KEY && body.secret !== SECRET_KEY) {
      return jsonResponse({ status: 'error', message: 'Wrong secret. GOOGLE_SCRIPT_SECRET must match SECRET_KEY in the script.' });
    }

    // One request at a time, so two saves never write into the same rows
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      if (body.action === 'load') {
        return jsonResponse({ status: 'ok', spreadsheetUrl: ss.getUrl(), tables: loadTables(ss) });
      }
      if (body.action === 'save') {
        saveChanges(ss, body);
        return jsonResponse({ status: 'ok', spreadsheetUrl: ss.getUrl() });
      }
      return jsonResponse({ status: 'error', message: 'Unknown action: ' + body.action });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return jsonResponse({ status: 'error', message: String(err) });
  }
}

function loadTables(ss) {
  var tables = {};
  TABLES.forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet || sheet.getLastRow() === 0) return;
    var values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getDisplayValues();
    tables[name] = { headers: values[0], rows: values.slice(1) };
  });
  return tables;
}

function saveChanges(ss, body) {
  var replace = body.replace || {};
  var append = body.append || {};

  Object.keys(replace).forEach(function (name) {
    if (TABLES.indexOf(name) !== -1) replaceTable(ss, name, replace[name]);
  });
  Object.keys(append).forEach(function (name) {
    if (TABLES.indexOf(name) !== -1) appendRows(ss, name, append[name]);
  });
  if (body.dashboard) {
    var created = !ss.getSheetByName(DASHBOARD_TAB);
    replaceTable(ss, DASHBOARD_TAB, body.dashboard);
    if (created) {
      ss.setActiveSheet(ss.getSheetByName(DASHBOARD_TAB));
      ss.moveActiveSheet(1);
    }
  }
}

/** Overwrite a whole tab (used for users, cameras, locations and the dashboard) */
function replaceTable(ss, name, table) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clearContents();
  writeRows(sheet, 1, [table.headers].concat(table.rows));
  styleHeader(sheet, table.headers.length);
}

/** Add new rows at the bottom. Rows whose id is already in the tab are skipped, so a retried save never duplicates data. */
function appendRows(ss, name, table) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  var lastRow = sheet.getLastRow();

  if (lastRow === 0) {
    writeRows(sheet, 1, [table.headers]);
    styleHeader(sheet, table.headers.length);
    lastRow = 1;
  }

  // Columns are matched by header name, so reordering columns in the sheet is fine
  var sheetHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  table.headers.forEach(function (header) {
    if (sheetHeaders.indexOf(header) === -1) {
      sheetHeaders.push(header);
      writeRows(sheet, 1, [sheetHeaders]);
      styleHeader(sheet, sheetHeaders.length);
    }
  });

  var idColumn = sheetHeaders.indexOf('id') + 1;
  var existing = {};
  if (lastRow > 1) {
    sheet.getRange(2, idColumn, lastRow - 1, 1).getDisplayValues().forEach(function (r) {
      existing[r[0]] = true;
    });
  }

  var idIndex = table.headers.indexOf('id');
  var rows = table.rows
    .filter(function (row) { return !existing[row[idIndex]]; })
    .map(function (row) {
      return sheetHeaders.map(function (header) {
        var i = table.headers.indexOf(header);
        return i === -1 ? '' : row[i];
      });
    });

  if (rows.length > 0) writeRows(sheet, lastRow + 1, rows);
}

/** Store every value as plain text so Sheets never turns timestamps or ids into dates/numbers */
function writeRows(sheet, startRow, rows) {
  if (rows.length === 0) return;
  var width = rows[0].length;
  var values = rows.map(function (row) {
    return row.map(function (value) {
      var text = value === null || value === undefined ? '' : String(value);
      return text.charAt(0) === '=' ? "'" + text : text; // never run text as a formula
    });
  });
  var range = sheet.getRange(startRow, 1, values.length, width);
  range.setNumberFormat('@');
  range.setValues(values);
}

function styleHeader(sheet, width) {
  sheet.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#0F172A').setFontColor('#FFFFFF');
  sheet.setFrozenRows(1);
}

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
