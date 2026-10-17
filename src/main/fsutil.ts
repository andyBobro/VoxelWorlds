import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, open, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/** Electron-free filesystem helpers shared by the worlds library and the geodata manager. */

const tmpSuffix = (): string => `.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;

/** fsync a directory so a rename/create inside it survives power loss (best effort; not supported everywhere). */
export async function fsyncDir(dir: string): Promise<void> {
  try {
    const fh = await open(dir, 'r');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    /* e.g. Windows or exotic filesystems */
  }
}

/** Abortable delay: resolves after `ms`, or immediately (false) when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((res) => {
    if (signal?.aborted) return res(false);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      res(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      res(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Write `data` to `path` atomically: tmp file in the same dir, fsync, rename. Never leaves a half-written target. */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = path + tmpSuffix();
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } catch (e) {
    await fh.close().catch(() => undefined);
    await rm(tmp, { force: true });
    throw e;
  }
  await fh.close();
  try {
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  await fsyncDir(dirname(path));
}

/** Copy `src` to `dst` atomically (copy to tmp in dst's dir, rename). */
export async function copyFileAtomic(src: string, dst: string): Promise<void> {
  const tmp = dst + tmpSuffix();
  try {
    await copyFile(src, tmp, constants.COPYFILE_EXCL);
    const fh = await open(tmp, 'r+');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, dst);
    await fsyncDir(dirname(dst));
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export async function readJsonFile<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

/** Total size in bytes of all regular files below `dir` (ignores `.tmp-` leftovers and unreadable entries). */
export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile() && !e.name.includes('.tmp-')) {
      try {
        total += (await stat(p)).size;
      } catch {
        /* vanished */
      }
    }
  }
  return total;
}

/** True when `child` is `parent` itself or lies below it (lexical check on resolved paths). */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

/** Like isInside, but after resolving symlinks on both sides (a link pointing outside `parent` is rejected). */
export async function isInsideReal(parent: string, child: string): Promise<boolean> {
  try {
    return isInside(await realpath(parent), await realpath(child));
  } catch {
    return false;
  }
}

export async function fileSize(p: string): Promise<number | null> {
  try {
    const st = await stat(p);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/** Serialises async tasks; a failing task does not break the chain. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const p = this.tail.then(task, task);
    this.tail = p.catch(() => undefined);
    return p;
  }
}
