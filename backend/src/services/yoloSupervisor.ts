import { spawn, spawnSync, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import { isYoloAvailable, setYoloUnavailableCallback } from './yoloDetector.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const yoloDir = path.resolve(__dirname, '..', '..', 'yolo');

let yoloProc: ChildProcess | null = null;
let resolvedPython: string | null = null;
let isStarting = false;

// When yoloDetector detects that the sidecar is unreachable during live camera usage,
// try to resurrect the managed YOLO process automatically.
setYoloUnavailableCallback(() => {
  ensureYoloService().catch(() => {});
});

/**
 * Searches candidates for a python binary that has ultralytics, fastapi, and uvicorn installed.
 */
function resolvePythonBinary(): string {
  if (resolvedPython) return resolvedPython;

  const candidates: string[] = [];
  if (process.env.YOLO_PYTHON) candidates.push(process.env.YOLO_PYTHON);
  if (config.yoloPython && config.yoloPython !== 'python3') candidates.push(config.yoloPython);

  const home = process.env.HOME || '';
  if (home) {
    candidates.push(path.join(home, '.pyenv', 'shims', 'python3'));
    candidates.push(path.join(home, '.pyenv', 'shims', 'python'));
    candidates.push(path.join(home, 'anaconda3', 'bin', 'python3'));
    candidates.push(path.join(home, 'miniconda3', 'bin', 'python3'));
  }
  candidates.push('/opt/anaconda3/bin/python3');
  candidates.push('/opt/homebrew/bin/python3');
  candidates.push('python3');
  candidates.push('python');

  for (const candidate of candidates) {
    try {
      if (candidate.includes(path.sep) && !fs.existsSync(candidate)) {
        continue;
      }
      const test = spawnSync(candidate, ['-c', 'import ultralytics, fastapi, uvicorn'], {
        timeout: 10000,
        encoding: 'utf8',
      });
      if (test.status === 0) {
        resolvedPython = candidate;
        logger.info(`Resolved YOLO Python interpreter: ${candidate}`);
        return candidate;
      }
    } catch {
      // continue testing next candidate
    }
  }

  resolvedPython = config.yoloPython || 'python3';
  return resolvedPython;
}

/**
 * Ensures the YOLO26 FastAPI detection sidecar is running on port 5002.
 * If already active (e.g. started via Docker, PM2, or manually), it reuses it.
 * Otherwise, it automatically spawns and supervises python detect_server.py.
 */
export async function ensureYoloService(): Promise<boolean> {
  const alreadyUp = await isYoloAvailable();
  if (alreadyUp) {
    logger.info(`YOLO26 detection sidecar is online and healthy at ${config.yoloUrl}.`);
    return true;
  }

  if (isStarting) {
    return false;
  }

  const url = new URL(config.yoloUrl);
  const isLocal = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  if (!config.yoloAutoStart || !isLocal) {
    logger.warn(`YOLO26 sidecar not reachable at ${config.yoloUrl}. Live camera counting stays paused until it is up.`);
    return false;
  }

  isStarting = true;
  const pythonBin = resolvePythonBinary();
  logger.info(`YOLO26 sidecar not detected. Automatically launching managed YOLO process using "${pythonBin}"...`);

  let lastStderr = '';

  try {
    yoloProc = spawn(pythonBin, ['detect_server.py'], {
      cwd: yoloDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: url.port || '5002', HOST: url.hostname.replace(/^\[|\]$/g, '') },
    });

    // Without this listener a missing python binary would crash the whole server
    yoloProc.on('error', (err) => {
      logger.error(`Failed to start YOLO sidecar with "${pythonBin}": ${err.message}`);
      yoloProc = null;
    });

    yoloProc.stdout?.on('data', (data: Buffer) => {
      logger.info(`[yolo] ${data.toString().trim()}`);
    });

    yoloProc.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      lastStderr = msg;
      logger.debug(`[yolo:log] ${msg}`);
    });

    yoloProc.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        logger.error(`YOLO sidecar process exited with code ${code}. Stderr: ${lastStderr}`);
      } else {
        logger.warn(`YOLO sidecar process exited with code ${code}`);
      }
      yoloProc = null;
    });

    // Poll health endpoint for up to 60 seconds while torch + model weights load
    for (let i = 0; i < 120; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!yoloProc) break;
      if (await isYoloAvailable()) {
        logger.info(`YOLO26 sidecar model warm and verified healthy at ${config.yoloUrl}.`);
        isStarting = false;
        return true;
      }
    }
    logger.warn('YOLO26 sidecar did not become healthy. Live camera counting stays paused until it is up.');
  } catch (err) {
    logger.error(`Failed to auto-spawn ${pythonBin} detect_server.py: ${(err as Error).message}`);
  } finally {
    isStarting = false;
  }

  return false;
}

export function stopYoloService(): void {
  if (yoloProc) {
    try {
      yoloProc.kill('SIGTERM');
      const forceTimer = setTimeout(() => {
        try {
          if (yoloProc && !yoloProc.killed) yoloProc.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 2000);
      forceTimer.unref();
    } catch (e) {
      logger.debug(`Error stopping YOLO process: ${(e as Error).message}`);
    }
    yoloProc = null;
  }
}
