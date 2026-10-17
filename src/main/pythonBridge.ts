import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ErrorCode, Event, Request, Stage } from '../shared/contract';

export class BridgeError extends Error {
  constructor(public code: ErrorCode | 'SPAWN_FAILED' | 'PROCESS_EXIT', message: string) {
    super(message);
  }
}

export interface BridgeListeners {
  onProgress(e: { id: string; stage: Stage; pct: number; message: string; tile?: { done: number; total: number } }): void;
  onWarning(e: { id: string; code: string; message: string }): void;
  onLog(line: string): void;
}

type ResultEvent = Extract<Event, { type: 'result' }>;
export type GenerateResult = Extract<ResultEvent, { kind: 'generate' }>;
export type ExportResult = Extract<ResultEvent, { kind: 'export' }>;
export type AnalyzeFacadeResult = Extract<ResultEvent, { kind: 'analyzeFacade' }>;
export type DetailResult = Extract<ResultEvent, { kind: 'detail' }>;

interface Pending {
  resolve(ev: ResultEvent | Extract<Event, { type: 'pong' }>): void;
  reject(err: BridgeError): void;
}

export interface BridgeOptions {
  /** project root containing ./python (dev only) */
  root: string;
  /** true in a packaged app: python lives in process.resourcesPath */
  packaged?: boolean;
  tempDir: string;
  /** persistent cache dir handed to python as VOXEL_CACHE_DIR (an already-set env var wins) */
  cacheDir?: string;
  listeners: BridgeListeners;
}

const READY_TIMEOUT_MS = 30_000;

export class PythonBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private disposed = false;
  private respawnAttempts = 0;
  private respawnTimer: NodeJS.Timeout | null = null;

  constructor(private opts: BridgeOptions) {}

  newId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${++this.seq}`;
  }

  private resolveCwd(): string {
    return this.opts.packaged ? join(process.resourcesPath, 'python') : join(this.opts.root, 'python');
  }

  private resolvePython(): string {
    const env = process.env.VOXEL_PYTHON;
    if (env) return env;
    if (this.opts.packaged) {
      return process.platform === 'win32'
        ? join(process.resourcesPath, 'python-runtime', 'python.exe')
        : join(process.resourcesPath, 'python-runtime', 'bin', 'python3');
    }
    const venv =
      process.platform === 'win32'
        ? join(this.opts.root, 'python', '.venv', 'Scripts', 'python.exe')
        : join(this.opts.root, 'python', '.venv', 'bin', 'python');
    return existsSync(venv) ? venv : process.platform === 'win32' ? 'python' : 'python3';
  }

  /** Spawn if needed and wait for the ready handshake. */
  ensureReady(): Promise<void> {
    if (this.disposed) return Promise.reject(new BridgeError('INTERNAL', 'Bridge disposed'));
    if (this.proc && !this.starting) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.spawnProcess().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private spawnProcess(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const python = this.resolvePython();
      const cwd = this.resolveCwd();
      const childEnv: NodeJS.ProcessEnv = { ...process.env };
      // The bundled interpreter is relocatable; stray variables would point it at another install.
      delete childEnv.PYTHONHOME;
      delete childEnv.PYTHONPATH;
      let settled = false;
      const settle = (err?: BridgeError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };

      let proc: ChildProcessWithoutNullStreams;
      try {
        proc = spawn(python, ['-m', 'voxelworlds'], {
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          // own process group so the whole python tree can be killed on quit
          detached: process.platform !== 'win32',
          env: {
            ...childEnv,
            PYTHONDONTWRITEBYTECODE: '1',
            PYTHONUNBUFFERED: '1',
            PYTHONIOENCODING: 'utf-8',
            VOXEL_TMP_DIR: this.opts.tempDir,
            ...(!childEnv.VOXEL_CACHE_DIR && this.opts.cacheDir ? { VOXEL_CACHE_DIR: this.opts.cacheDir } : {}),
          },
        });
      } catch (e) {
        reject(new BridgeError('SPAWN_FAILED', `Cannot start ${python}: ${(e as Error).message}`));
        return;
      }
      this.proc = proc;
      this.opts.listeners.onLog(`[bridge] started ${python} -m voxelworlds (pid ${proc.pid ?? '?'})`);

      const timer = setTimeout(() => {
        settle(new BridgeError('SPAWN_FAILED', 'Python did not send "ready" in time'));
        proc.kill();
      }, READY_TIMEOUT_MS);

      const outDec = new StringDecoder('utf8');
      let outBuf = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        outBuf += outDec.write(chunk);
        let nl: number;
        while ((nl = outBuf.indexOf('\n')) >= 0) {
          const line = outBuf.slice(0, nl).replace(/\r$/, '');
          outBuf = outBuf.slice(nl + 1);
          if (line.trim()) this.handleLine(line, settle);
        }
      });

      const errDec = new StringDecoder('utf8');
      let errBuf = '';
      proc.stderr.on('data', (chunk: Buffer) => {
        errBuf += errDec.write(chunk);
        let nl: number;
        while ((nl = errBuf.indexOf('\n')) >= 0) {
          const line = errBuf.slice(0, nl).replace(/\r$/, '');
          errBuf = errBuf.slice(nl + 1);
          if (line) this.opts.listeners.onLog(line);
        }
      });

      proc.stdin.on('error', () => {
        /* handled via exit */
      });

      proc.on('error', (err) => {
        settle(new BridgeError('SPAWN_FAILED', `Cannot start ${python}: ${err.message}`));
        this.onExit(proc, `spawn error: ${err.message}`);
      });
      proc.on('exit', (code, signal) => {
        settle(new BridgeError('PROCESS_EXIT', `Python exited before ready (code ${code ?? signal})`));
        this.onExit(proc, `exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`);
      });
    });
  }

  private onExit(proc: ChildProcessWithoutNullStreams, reason: string): void {
    if (this.proc !== proc) return;
    this.proc = null;
    this.opts.listeners.onLog(`[bridge] python ${reason}`);
    const err = new BridgeError('PROCESS_EXIT', `Python process ${reason}`);
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    if (this.disposed) return;
    // Respawn with backoff; lazily re-created on next request if this fails.
    if (this.respawnAttempts < 5) {
      const delay = Math.min(500 * 2 ** this.respawnAttempts, 8000);
      this.respawnAttempts++;
      this.respawnTimer = setTimeout(() => {
        this.respawnTimer = null;
        this.ensureReady().catch(() => undefined);
      }, delay);
    }
  }

  private handleLine(line: string, settleReady: (err?: BridgeError) => void): void {
    let ev: Event;
    try {
      ev = JSON.parse(line) as Event;
      if (typeof ev !== 'object' || ev === null || typeof ev.type !== 'string') throw new Error('not an event');
    } catch {
      this.opts.listeners.onLog(`[stdout] ${line}`);
      return;
    }
    switch (ev.type) {
      case 'ready':
        this.respawnAttempts = 0;
        this.opts.listeners.onLog(`[bridge] python ready, version ${ev.version}`);
        settleReady();
        return;
      case 'progress':
        this.opts.listeners.onProgress({ id: ev.id, stage: ev.stage, pct: ev.pct, message: ev.message, tile: ev.tile });
        return;
      case 'warning':
        this.opts.listeners.onWarning({ id: ev.id, code: ev.code, message: ev.message });
        return;
      case 'result':
      case 'pong': {
        const p = this.pending.get(ev.id);
        if (p) {
          this.pending.delete(ev.id);
          p.resolve(ev);
        }
        return;
      }
      case 'error': {
        const p = this.pending.get(ev.id);
        if (p) {
          this.pending.delete(ev.id);
          p.reject(new BridgeError(ev.code, ev.message));
        } else {
          this.opts.listeners.onLog(`[error ${ev.code}] ${ev.message}`);
        }
        return;
      }
    }
  }

  private write(req: Request): void {
    const proc = this.proc;
    if (!proc || !proc.stdin.writable) throw new BridgeError('PROCESS_EXIT', 'Python process is not running');
    proc.stdin.write(JSON.stringify(req) + '\n');
  }

  /** Send a request and await its result event. Rejects on error event or process exit. */
  async request<T extends ResultEvent>(req: Request): Promise<T> {
    await this.ensureReady();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(req.id, { resolve: resolve as Pending['resolve'], reject });
      try {
        this.write(req);
      } catch (e) {
        this.pending.delete(req.id);
        reject(e as Error);
      }
    });
  }

  /** Ask python to cancel a running request. Fire and forget; the original request rejects with CANCELLED. */
  cancel(target: string): void {
    try {
      this.write({ id: this.newId('cancel'), type: 'cancel', target });
    } catch {
      /* nothing running */
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.respawnTimer) clearTimeout(this.respawnTimer);
    const proc = this.proc;
    this.proc = null;
    for (const p of this.pending.values()) p.reject(new BridgeError('PROCESS_EXIT', 'App is quitting'));
    this.pending.clear();
    if (!proc) return;
    try {
      proc.stdin.end();
    } catch {
      /* ignore */
    }
    const killTree = (sig: NodeJS.Signals): void => {
      try {
        if (process.platform !== 'win32' && proc.pid) process.kill(-proc.pid, sig);
        else proc.kill(sig);
      } catch {
        /* already gone */
      }
    };
    killTree('SIGTERM');
    // 'exit' handlers run synchronously even while the app is quitting; timers may not.
    process.once('exit', () => killTree('SIGKILL'));
    setTimeout(() => {
      if (proc.exitCode === null) killTree('SIGKILL');
    }, 1500).unref();
  }
}
