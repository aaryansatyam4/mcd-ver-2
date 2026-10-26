import os from 'os';
import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Never let tests write into the real production workbook (public/database.xlsx).
    // A fresh seeded database is created in the temp dir for every test run.
    env: {
      EXCEL_DB_PATH: path.join(os.tmpdir(), `wheelwash-test-${process.pid}-${Date.now()}.xlsx`),
      YOLO_AUTOSTART: 'false',
      // Tests never talk to a real Google Sheet
      GOOGLE_SCRIPT_URL: '',
    },
    fileParallelism: false,
  },
});
