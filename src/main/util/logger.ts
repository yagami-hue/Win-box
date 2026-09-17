// src/main/util/logger.ts
import type { Logger } from '../../shared/types';
import { logsDir } from './paths';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

mkdirSync(logsDir(), { recursive: true });
const logFile = join(logsDir(), `app-${new Date().toISOString().slice(0, 10)}.log`);

function stamp(level: string, t: string): string {
  return `${new Date().toISOString()} [${level}] ${t}`;
}

export const fileLogger: Logger = {
  i: (t) => {
    const s = stamp('I', t);
    try { appendFileSync(logFile, s + '\n'); } catch { /* ignore */ }
    console.log(s);
  },
  w: (t) => {
    const s = stamp('W', t);
    try { appendFileSync(logFile, s + '\n'); } catch { /* ignore */ }
    console.warn(s);
  },
  e: (t, err) => {
    const s = stamp('E', t + (err ? ' ' + (err instanceof Error ? err.message : String(err)) : ''));
    try { appendFileSync(logFile, s + '\n'); } catch { /* ignore */ }
    console.error(s);
  },
};
