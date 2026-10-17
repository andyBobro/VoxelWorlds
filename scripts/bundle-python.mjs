// Builds build/python-runtime: relocatable python-build-standalone CPython 3.10 + python/requirements.txt.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = '20260414';
const VERSION = '3.10.20';
const ASSETS = {
  arm64: { triple: 'aarch64-apple-darwin', sha256: 'f76cc83c7db16cfc8794bf6e44d834152b57d8bab4e04e823cbc59ed23ec22f8' },
  x64: { triple: 'x86_64-apple-darwin', sha256: '95a2d794b8981723095190fa94b574ceb4272bb49d83b9e418bb90341e304d09' },
};
if (process.platform !== 'darwin') throw new Error('bundle-python currently supports macOS only');
const arch = process.env.VOXEL_BUNDLE_ARCH || process.arch;
const asset = ASSETS[arch];
if (!asset) throw new Error(`unsupported arch ${arch}`);

const name = `cpython-${VERSION}+${RELEASE}-${asset.triple}-install_only.tar.gz`;
const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE}/${encodeURIComponent(name)}`;
const cacheDir = join(root, '.cache');
const archive = join(cacheDir, name);
const dest = join(root, 'build', 'python-runtime');
const stamp = join(dest, '.bundle-stamp');
const reqFile = join(root, 'python', 'requirements.txt');
const stampValue = `${name}\n${createHash('sha256').update(readFileSync(reqFile)).digest('hex')}\n`;

const sha256 = async (f) => {
  const h = createHash('sha256');
  await pipeline(createReadStream(f), h);
  return h.digest('hex');
};

if (existsSync(stamp) && readFileSync(stamp, 'utf8') === stampValue) {
  console.log('[bundle-python] up to date');
  process.exit(0);
}

mkdirSync(cacheDir, { recursive: true });
if (!existsSync(archive) || (await sha256(archive)) !== asset.sha256) {
  console.log('[bundle-python] downloading', url);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const tmp = archive + '.part';
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  const got = await sha256(tmp);
  if (got !== asset.sha256) {
    rmSync(tmp, { force: true });
    throw new Error(`sha256 mismatch for ${name}: expected ${asset.sha256}, got ${got}`);
  }
  renameSync(tmp, archive);
}
console.log('[bundle-python] sha256 verified');

rmSync(dest, { recursive: true, force: true });
const staging = join(root, 'build', '.python-extract');
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
execFileSync('tar', ['-xzf', archive, '-C', staging]); // archive top-level dir is "python"
renameSync(join(staging, 'python'), dest);
rmSync(staging, { recursive: true, force: true });

const py = join(dest, 'bin', 'python3');
const env = { ...process.env, PYTHONHOME: '', PYTHONPATH: '', PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONDONTWRITEBYTECODE: '1' };
delete env.PYTHONHOME;
delete env.PYTHONPATH;
execFileSync(py, ['-I', '-c', 'import ssl; print("ssl:", ssl.OPENSSL_VERSION)'], { stdio: 'inherit', env });
execFileSync(py, ['-I', '-m', 'pip', 'install', '--no-cache-dir', '--only-binary=:all:', '-r', reqFile], { stdio: 'inherit', env });

// Strip: caches, tests, build-time leftovers; pip entry-point scripts embed absolute shebangs (not relocatable).
const walk = (d, fn) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (fn(p, e.name) === 'skip') continue;
      walk(p, fn);
    }
  }
};
const lib = join(dest, 'lib', 'python3.10');
const kill = (p) => rmSync(p, { recursive: true, force: true });
walk(dest, (p, n) => {
  if (n === '__pycache__' || n === 'tests' || n === 'test' && p.includes('site-packages')) { kill(p); return 'skip'; }
});
for (const p of [join(lib, 'test'), join(lib, 'idlelib'), join(lib, 'turtledemo'), join(lib, 'lib2to3', 'tests'), join(dest, 'include'), join(dest, 'share')]) kill(p);
for (const f of readdirSync(join(dest, 'lib'))) if (f.endsWith('.a')) kill(join(dest, 'lib', f));
for (const f of readdirSync(join(dest, 'bin'))) {
  if (!/^python3?(\.\d+)?$/.test(f)) kill(join(dest, 'bin', f));
}

execFileSync(py, ['-I', '-c', 'import ssl, osmnx, osmium, shapely, pyproj, numpy, PIL, mapbox_vector_tile, geopandas, pandas, requests; print("imports ok")'], { stdio: 'inherit', env });
// the import check may recreate caches
walk(dest, (p, n) => { if (n === '__pycache__') { kill(p); return 'skip'; } });
writeFileSync(stamp, stampValue);
const du = execFileSync('du', ['-sh', dest]).toString().trim();
console.log('[bundle-python] done:', du);
