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
// VOXEL_BUNDLE_TARGET=win cross-builds the Windows x64 runtime (from macOS/Linux) into build/python-runtime-win.
// On a native Windows host the Windows runtime is always built (pip runs inside the extracted runtime).
const WIN_HOST = process.platform === 'win32';
const WIN = WIN_HOST || process.env.VOXEL_BUNDLE_TARGET === 'win';
if (WIN) ASSETS.winx64 = { triple: 'x86_64-pc-windows-msvc', sha256: '0d828683d30185ab9f1110ad2194ef384cef0533b8e0da7e03ce837548841788' };
else if (process.platform !== 'darwin') throw new Error('bundle-python supports macOS natively; set VOXEL_BUNDLE_TARGET=win for Windows');
const arch = WIN ? 'winx64' : process.env.VOXEL_BUNDLE_ARCH || process.arch;
const asset = ASSETS[arch];
if (!asset) throw new Error(`unsupported arch ${arch}`);

const name = `cpython-${VERSION}+${RELEASE}-${asset.triple}-install_only.tar.gz`;
const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE}/${encodeURIComponent(name)}`;
const cacheDir = join(root, '.cache');
const archive = join(cacheDir, name);
const dest = join(root, 'build', WIN ? 'python-runtime-win' : 'python-runtime');
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
// archive top-level dir is "python". On Windows use the OS bsdtar: a GNU tar from Git-for-Windows on PATH
// mis-parses "C:\..." paths as remote hosts.
const sysTar = WIN_HOST ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
execFileSync(WIN_HOST && existsSync(sysTar) ? sysTar : 'tar', ['-xzf', archive, '-C', staging]);
renameSync(join(staging, 'python'), dest);
rmSync(staging, { recursive: true, force: true });

if (WIN) {
  const site = join(dest, 'Lib', 'site-packages');
  const winPy = join(dest, 'python.exe');
  const winEnv = { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONDONTWRITEBYTECODE: '1' };
  delete winEnv.PYTHONHOME;
  delete winEnv.PYTHONPATH;
  if (WIN_HOST) {
    // Native: install straight into the extracted runtime with its own pip.
    execFileSync(winPy, ['-I', '-m', 'pip', 'install', '--no-cache-dir', '--only-binary=:all:', '-r', reqFile], { stdio: 'inherit', env: winEnv });
  } else {
    // Cross: install win_amd64 wheels into the runtime's site-packages (nothing can be executed on this host).
    const macPy = join(root, 'build', 'python-runtime', 'bin', 'python3'); // has ssl+pip
    const host = process.env.VOXEL_HOST_PYTHON || (existsSync(macPy) ? macPy : 'python3');
    execFileSync(host, ['-m', 'pip', 'install', '--no-cache-dir', '--only-binary=:all:', '--platform', 'win_amd64',
      '--python-version', '3.10', '--implementation', 'cp', '--abi', 'cp310', '--target', site, '-r', reqFile], { stdio: 'inherit' });
  }
  const kill = (p) => rmSync(p, { recursive: true, force: true });
  const sweep = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isSymbolicLink() || !e.isDirectory()) continue;
      if (e.name === '__pycache__' || e.name === 'tests' || (e.name === 'test' && p.includes('site-packages'))) { kill(p); continue; }
      sweep(p);
    }
  };
  for (const p of [join(dest, 'Lib', 'test'), join(dest, 'Lib', 'idlelib'), join(dest, 'Lib', 'turtledemo'), join(dest, 'include'), join(dest, 'Scripts'), join(dest, 'tcl'), join(dest, 'libs')]) kill(p);
  sweep(dest);
  for (const f of readdirSync(dest)) if (f.endsWith('.pdb')) kill(join(dest, f));
  if (!existsSync(join(dest, 'python.exe'))) throw new Error('python.exe missing in runtime');
  for (const m of ['numpy', 'shapely', 'pyproj', 'PIL', 'osmium', 'pandas', 'geopandas', 'osmnx']) {
    if (!existsSync(join(site, m))) throw new Error(`wheel for ${m} missing`);
  }
  if (WIN_HOST) {
    execFileSync(winPy, ['-I', '-c', 'import ssl, osmnx, osmium, shapely, pyproj, numpy, PIL, mapbox_vector_tile, geopandas, pandas, requests; print("imports ok")'], { stdio: 'inherit', env: winEnv });
    sweep(dest); // the import check may recreate caches
  }
  writeFileSync(stamp, stampValue);
  const dirSize = (d) => readdirSync(d, { withFileTypes: true }).reduce((n, e) => {
    const p = join(d, e.name);
    return n + (e.isSymbolicLink() ? 0 : e.isDirectory() ? dirSize(p) : statSync(p).size);
  }, 0);
  console.log(`[bundle-python] windows runtime done: ${(dirSize(dest) / 1048576).toFixed(1)} MB`);
  process.exit(0);
}

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
