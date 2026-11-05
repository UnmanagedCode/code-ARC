// The offline bundle's policy: where a bundle is found, what its manifest
// must say, and the one verifier every path (boot, import, export) runs
// before a bundle is used. A bundle is a directory:
//   manifest.json  pip/<pip>.pyz  wheels/<wheel>.whl  games/<base>/<ver>/{metadata.json, <class>.py}
// Format and trust model: docs/bundle.md.
import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { GAME_ID_RE } from './limits.js';

export const BUNDLE_FORMAT = 'code-arc-bundle';
export const BUNDLE_FORMAT_VERSION = 1;
export const BUNDLE_EXT = '.arcbundle';
export const MANIFEST_FILE = 'manifest.json';
export const LICENSE_NOTICE = 'Game sources in this bundle were downloaded from arcprize.org by the person who exported it, '
  + 'for their own environments. ARC publishes no license for them: do not commit, publish or share this bundle.';

const MiB = 1024 * 1024;
// The single source of a bundle's bounds; import and verify take an override for tests.
export const BUNDLE_LIMITS = Object.freeze({
  manifestMaxBytes: 1 * MiB,
  filesMax: 10000,
  fileMaxBytes: 128 * MiB,
  totalMaxBytes: 1024 * MiB,
  archiveMaxBytes: 1024 * MiB,
  ratioMax: 100,
  pathMax: 200,
  depthMax: 5,
});

export const BUNDLE_FIXES = Object.freeze({
  BUNDLE_HASH_MISMATCH: 're-import the bundle from its original archive (`node scripts/bundle.mjs import <archive> --replace`), or remove it to use the web',
  BUNDLE_PLATFORM_MISMATCH: 'export the bundle on a machine matching this host (same OS, CPU architecture and Python minor version), or install the Python version it targets here',
  BUNDLE_STALE: 'export a new bundle from this checkout',
  BUNDLE_INVALID: 're-export, or re-import with `node scripts/bundle.mjs import`',
  BUNDLE_EXISTS: 'pass --replace to swap the installed bundle (stop the plugin first)',
  BUNDLE_ID_MISMATCH: 'check the id the exporter printed; import only the bundle you expect',
  BUNDLE_OUT_INVALID: 'pass a new output path ending in .arcbundle',
  BUNDLE_EXPORT_FAILED: 'see the detail; export needs network and a host matching the bundle target',
});

export class BundleError extends Error {
  constructor(code, message, fix = BUNDLE_FIXES[code] || null) {
    super(message);
    this.code = code;
    this.fix = fix;
  }
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;
const TOKEN_RE = /^[A-Za-z0-9._-]{1,40}$/;
const PATH_RE = /^[A-Za-z0-9._+-]+(\/[A-Za-z0-9._+-]+)*$/;
const TITLE_MAX = 200;
const TARGET_KEYS = ['implementation', 'python', 'system', 'machine', 'libc'];
const MANIFEST_KEYS = ['format', 'format_version', 'notice', 'created_at', 'target', 'requirements_sha256', 'toolkit', 'pip', 'wheels', 'games', 'files'];

// -- locating ----------------------------------------------------------------

// CODE_ARC_BUNDLE (absolute; relative throws), the data-dir slot, and the
// toolkit dir a bundle must never sit in (the NORMAL arcade writes there).
export function bundleLocations(env, dataDir) {
  const raw = env.CODE_ARC_BUNDLE;
  const envPath = raw === undefined || raw === '' ? null : raw;
  if (envPath !== null && !path.isAbsolute(envPath)) {
    throw new BundleError('BUNDLE_INVALID', `CODE_ARC_BUNDLE must be an absolute path to an extracted bundle (got ${JSON.stringify(raw)})`, 'fix or unset CODE_ARC_BUNDLE');
  }
  return {
    envPath,
    dataDirPath: dataDir ? path.join(dataDir, 'bundle') : null,
    toolkitDir: dataDir ? path.join(dataDir, 'toolkit') : null,
  };
}

async function lstatOrNull(p) {
  try {
    return await fs.lstat(p);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function realOrResolved(p) {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);

// null (no bundle) or {location, dir, shadowed}. Throws BundleError with
// `loc` = {location, path, shadowed} when the winning location is unusable:
// there is never a fallback past it.
export async function locateBundle({ envPath, dataDirPath, toolkitDir }) {
  const slot = dataDirPath ? await lstatOrNull(dataDirPath) : null;
  const shadowed = envPath && slot ? dataDirPath : null;
  const fail = (location, p, message, fix) => Object.assign(new BundleError('BUNDLE_INVALID', message, fix), { loc: { location, path: p, shadowed } });
  let location;
  let dir;
  if (envPath) {
    location = 'env';
    try {
      dir = await fs.realpath(envPath);
    } catch (e) {
      throw fail('env', envPath, `offline bundle ${envPath}: CODE_ARC_BUNDLE names a path that cannot be read (${e.code})`, 'fix or unset CODE_ARC_BUNDLE');
    }
  } else if (slot) {
    location = 'data_dir';
    if (slot.isSymbolicLink() || !slot.isDirectory()) {
      throw fail('data_dir', dataDirPath, `offline bundle ${dataDirPath}: must be a real directory, not a symlink or file`, BUNDLE_FIXES.BUNDLE_INVALID);
    }
    dir = dataDirPath;
  } else {
    return null;
  }
  if (toolkitDir && inside(dir, await realOrResolved(toolkitDir))) {
    throw fail(location, dir, `offline bundle ${dir}: is inside the toolkit's download dir ${toolkitDir}, which the toolkit writes to`, 'move the bundle out of the toolkit dir');
  }
  return { location, dir, shadowed };
}

// -- paths, pins, manifest -----------------------------------------------------

const invalid = (msg) => new BundleError('BUNDLE_INVALID', msg);

// The allowlist every manifest path and every archive entry passes.
export function validateBundlePath(p, limits = BUNDLE_LIMITS) {
  if (typeof p !== 'string' || p.length < 1 || p.length > limits.pathMax || !PATH_RE.test(p)) throw invalid(`bad path ${JSON.stringify(String(p).slice(0, 80))}`);
  const segs = p.split('/');
  if (segs.some((s) => s === '.' || s === '..')) throw invalid(`path ${p} has a . or .. segment`);
  if (segs.length > limits.depthMax) throw invalid(`path ${p} is deeper than ${limits.depthMax}`);
  const last = segs[segs.length - 1];
  const ok = (segs[0] === 'pip' && segs.length === 2 && last.endsWith('.pyz'))
    || (segs[0] === 'wheels' && segs.length === 2 && last.endsWith('.whl'))
    || (segs[0] === 'games' && segs.length >= 3 && segs.length <= 4 && (last === 'metadata.json' || last.endsWith('.py')));
  if (!ok) throw invalid(`path ${p} is not an allowed bundle file (pip/*.pyz, wheels/*.whl, games/<game>[/<ver>]/{metadata.json,*.py})`);
  return segs;
}

// PEP 503 name normalization.
export const normName = (name) => name.toLowerCase().replace(/[-_.]+/g, '-');

export function parsePins(text) {
  const pins = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([A-Za-z0-9][A-Za-z0-9.+!_-]*)$/.exec(line);
    if (!m) throw new BundleError('BUNDLE_INVALID', `requirements.txt line ${JSON.stringify(line.slice(0, 80))} is not a name==version pin`);
    pins.push({ name: m[1], norm: normName(m[1]), version: m[2] });
  }
  return pins;
}

// {norm, version} from a wheel filename (name-ver[-build]-py-abi-plat.whl).
export function wheelProject(file) {
  const base = path.posix.basename(file);
  if (!base.endsWith('.whl')) return null;
  const parts = base.slice(0, -4).split('-');
  if (parts.length !== 5 && parts.length !== 6) return null;
  return { norm: normName(parts[0]), version: parts[1] };
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function exactKeys(obj, keys, where) {
  if (!isObj(obj)) throw invalid(`manifest ${where} must be an object`);
  const got = Object.keys(obj);
  const extra = got.filter((k) => !keys.includes(k));
  const missing = keys.filter((k) => !(k in obj));
  if (extra.length || missing.length) throw invalid(`manifest ${where}: ${extra.length ? `unknown ${extra.join(', ')}` : ''}${extra.length && missing.length ? '; ' : ''}${missing.length ? `missing ${missing.join(', ')}` : ''}`);
}

const str = (v, where, re = TOKEN_RE) => {
  if (typeof v !== 'string' || !re.test(v)) throw invalid(`manifest ${where} is malformed`);
  return v;
};

export function parseManifest(buf, limits = BUNDLE_LIMITS) {
  if (buf.length > limits.manifestMaxBytes) throw invalid(`manifest is over ${limits.manifestMaxBytes} bytes`);
  let m;
  try {
    m = JSON.parse(buf.toString('utf8'));
  } catch {
    throw invalid('manifest is not JSON');
  }
  exactKeys(m, MANIFEST_KEYS, 'top level');
  if (m.format !== BUNDLE_FORMAT || m.format_version !== BUNDLE_FORMAT_VERSION) throw invalid(`manifest format is ${JSON.stringify(m.format)} v${m.format_version}; this checkout reads ${BUNDLE_FORMAT} v${BUNDLE_FORMAT_VERSION}`);
  if (m.notice !== LICENSE_NOTICE) throw invalid('manifest notice is missing or altered');
  if (typeof m.created_at !== 'string' || Number.isNaN(Date.parse(m.created_at)) || !/^\d{4}-\d{2}-\d{2}T/.test(m.created_at)) throw invalid('manifest created_at is not an ISO time');
  exactKeys(m.target, TARGET_KEYS, 'target');
  for (const k of TARGET_KEYS) if (!(k === 'libc' && m.target[k] === null)) str(m.target[k], `target.${k}`);
  str(m.requirements_sha256, 'requirements_sha256', HEX64);
  exactKeys(m.toolkit, ['arc_agi', 'arcengine'], 'toolkit');
  str(m.toolkit.arc_agi, 'toolkit.arc_agi');
  str(m.toolkit.arcengine, 'toolkit.arcengine');

  if (!Array.isArray(m.files)) throw invalid('manifest files must be a list');
  if (m.files.length > limits.filesMax) throw invalid(`manifest lists over ${limits.filesMax} files`);
  const files = new Map();
  const folded = new Set();
  let total = 0;
  for (const [i, f] of m.files.entries()) {
    exactKeys(f, ['path', 'size', 'sha256'], `files[${i}]`);
    validateBundlePath(f.path, limits);
    if (!Number.isSafeInteger(f.size) || f.size < 0 || f.size > limits.fileMaxBytes) throw invalid(`manifest size of ${f.path} is out of bounds`);
    str(f.sha256, `files[${i}].sha256`, HEX64);
    const lower = f.path.toLowerCase();
    if (folded.has(lower)) throw invalid(`manifest lists ${f.path} twice (case-insensitively)`);
    folded.add(lower);
    files.set(f.path, f);
    total += f.size;
  }
  if (total > limits.totalMaxBytes) throw invalid(`manifest files total over ${limits.totalMaxBytes} bytes`);
  for (const p of files.keys()) {
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) {
      const prefix = segs.slice(0, i).join('/').toLowerCase();
      if (folded.has(prefix)) throw invalid(`manifest path ${p} is under a listed file`);
    }
  }

  exactKeys(m.pip, ['version', 'file'], 'pip');
  str(m.pip.version, 'pip.version');
  if (!files.has(m.pip.file) || !m.pip.file.startsWith('pip/')) throw invalid('manifest pip.file is not a listed pip/ file');

  if (!Array.isArray(m.wheels) || m.wheels.length === 0) throw invalid('manifest wheels must be a non-empty list');
  for (const [i, w] of m.wheels.entries()) {
    exactKeys(w, ['file', 'project', 'version'], `wheels[${i}]`);
    str(w.project, `wheels[${i}].project`);
    str(w.version, `wheels[${i}].version`, /^[A-Za-z0-9.+!_-]{1,40}$/);
    if (!files.has(w.file) || !w.file.startsWith('wheels/')) throw invalid(`manifest wheel ${w.file} is not a listed wheels/ file`);
    const wp = wheelProject(w.file);
    if (!wp || wp.norm !== normName(w.project) || wp.version !== w.version) throw invalid(`manifest wheel ${w.file} does not match ${w.project}==${w.version}`);
  }

  if (!Array.isArray(m.games) || m.games.length === 0) throw invalid('manifest games must be a non-empty list');
  for (const [i, g] of m.games.entries()) {
    exactKeys(g, ['game_id', 'title', 'dir'], `games[${i}]`);
    if (typeof g.game_id !== 'string' || !GAME_ID_RE.test(g.game_id)) throw invalid(`manifest games[${i}].game_id is malformed`);
    if (typeof g.title !== 'string' || g.title.length > TITLE_MAX) throw invalid(`manifest games[${i}].title is malformed`);
    if (typeof g.dir !== 'string' || !g.dir.startsWith('games/') || !files.has(`${g.dir}/metadata.json`)) throw invalid(`manifest games[${i}].dir has no listed metadata.json`);
  }
  return m;
}

// -- verification --------------------------------------------------------------

// Opens `p` (labelled `rel` in errors) only if it is a regular file. The
// lstat refuses a FIFO, device, socket or symlink before any open, and the
// open is O_NOFOLLOW|O_NONBLOCK, so one swapped in after the lstat can
// neither be followed nor block the open; fstat then re-checks the handle.
// Resolves {fh, size}; the caller closes fh.
export async function openRegularFile(p, rel) {
  let st;
  try {
    st = await fs.lstat(p);
  } catch (e) {
    if (e.code === 'ENOENT') throw invalid(`missing file ${rel}`);
    throw e;
  }
  if (!st.isFile()) throw invalid(`${rel} is not a regular file`);
  let fh;
  try {
    fh = await fs.open(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (e) {
    if (e.code === 'ENOENT') throw invalid(`missing file ${rel}`);
    if (e.code === 'ELOOP') throw invalid(`${rel} is not a regular file`);
    throw e;
  }
  const fst = await fh.stat().catch(async (e) => {
    await fh.close();
    throw e;
  });
  if (!fst.isFile()) {
    await fh.close();
    throw invalid(`${rel} is not a regular file`);
  }
  return { fh, size: fst.size };
}

async function readManifest(p, maxBytes) {
  const { fh, size } = await openRegularFile(p, MANIFEST_FILE);
  try {
    if (size > maxBytes) throw invalid(`${MANIFEST_FILE} is over ${maxBytes} bytes`);
    const buf = await fh.readFile();
    if (buf.length > maxBytes) throw invalid(`${MANIFEST_FILE} is over ${maxBytes} bytes`);
    return buf;
  } finally {
    await fh.close();
  }
}

// Hashes at most expectedSize + 1 bytes (enough to see a size mismatch),
// checking `signal` on every chunk.
async function hashFile(p, rel, expectedSize, signal) {
  const { fh, size } = await openRegularFile(p, rel);
  try {
    if (size !== expectedSize) return { size };
    const h = createHash('sha256');
    let n = 0;
    for await (const chunk of fh.createReadStream({ autoClose: false, start: 0, end: expectedSize })) {
      signal?.throwIfAborted();
      n += chunk.length;
      h.update(chunk);
    }
    return { size: n, sha256: h.digest('hex') };
  } finally {
    await fh.close();
  }
}

// The single verifier: boot, the end of import and the end of export.
// Resolves {id, manifest}; id = sha256 of the manifest bytes. `signal`
// (optional) aborts it between entries and on every hashed chunk.
export async function verifyBundle(dir, { requirementsText, limits = BUNDLE_LIMITS, signal }) {
  const where = `offline bundle ${dir}: `;
  const wrap = (e) => {
    if (e instanceof BundleError) {
      if (!e.message.startsWith(where)) e.message = where + e.message;
      return e;
    }
    if (e.code === 'ELOOP' || e.code === 'ENOENT' || e.code === 'ENOTDIR') return new BundleError('BUNDLE_INVALID', `${where}${e.message}`);
    return e;
  };
  try {
    const st = await fs.lstat(dir);
    if (!st.isDirectory()) throw invalid('is not a directory');
    signal?.throwIfAborted();
    const buf = await readManifest(path.join(dir, MANIFEST_FILE), limits.manifestMaxBytes);
    const manifest = parseManifest(buf, limits);
    const id = sha256(buf);
    if (manifest.requirements_sha256 !== sha256(requirementsText)) {
      throw new BundleError('BUNDLE_STALE', 'it was exported for a different requirements.txt than this checkout\'s');
    }
    checkWheelsMatchPins(manifest, parsePins(requirementsText));

    const listed = new Map(manifest.files.map((f) => [f.path, f]));
    const ancestors = new Set();
    for (const p of listed.keys()) {
      const segs = p.split('/');
      for (let i = 1; i < segs.length; i++) ancestors.add(segs.slice(0, i).join('/'));
    }
    let entries = 0;
    const walk = async (rel) => {
      for (const name of await fs.readdir(rel ? path.join(dir, rel) : dir)) {
        signal?.throwIfAborted();
        const r = rel ? `${rel}/${name}` : name;
        if (++entries > limits.filesMax * 2) throw invalid(`has over ${limits.filesMax * 2} entries`);
        const s = await fs.lstat(path.join(dir, r));
        if (s.isDirectory()) {
          if (!ancestors.has(r)) throw invalid(`unexpected directory ${r}`);
          await walk(r);
        } else if (s.isFile()) {
          if (!(r === MANIFEST_FILE || listed.has(r))) throw invalid(`unexpected file ${r}`);
        } else {
          throw invalid(`${r} is not a regular file or directory`);
        }
      }
    };
    await walk('');

    for (const f of manifest.files) {
      signal?.throwIfAborted();
      const got = await hashFile(path.join(dir, f.path), f.path, f.size, signal);
      if (got.size !== f.size) throw new BundleError('BUNDLE_HASH_MISMATCH', `${f.path} is ${got.size} bytes, the manifest says ${f.size}`);
      if (got.sha256 !== f.sha256) throw new BundleError('BUNDLE_HASH_MISMATCH', `${f.path} has sha256 ${got.sha256}, the manifest says ${f.sha256}`);
    }
    return { id, manifest };
  } catch (e) {
    throw wrap(e);
  }
}

// The manifest's wheels must be exactly one per pin, same version.
export function checkWheelsMatchPins(manifest, pins) {
  const byNorm = new Map();
  for (const w of manifest.wheels) {
    const n = normName(w.project);
    if (byNorm.has(n)) throw invalid(`two wheels for ${w.project}`);
    byNorm.set(n, w);
  }
  for (const p of pins) {
    const w = byNorm.get(p.norm);
    if (!w) throw invalid(`no wheel for the pin ${p.name}==${p.version}`);
    if (w.version !== p.version) throw invalid(`wheel ${w.file} is ${w.version}, requirements.txt pins ${p.name}==${p.version}`);
    byNorm.delete(p.norm);
  }
  if (byNorm.size) throw invalid(`wheels not pinned by requirements.txt: ${[...byNorm.values()].map((w) => w.file).join(', ')}`);
}

// -- install helpers ----------------------------------------------------------

export function bundleSummary(loc, id, manifest) {
  return {
    location: loc.location,
    path: loc.dir,
    id,
    created_at: manifest.created_at,
    target: manifest.target,
    toolkit: manifest.toolkit,
    games: manifest.games.length,
    shadowed: loc.shadowed,
  };
}

// Prints the interpreter's target as one JSON line.
export const TARGET_PROBE_ARGS = Object.freeze(['-I', '-c',
  'import json,platform,sys;print(json.dumps({"implementation":sys.implementation.name,"python":"%d.%d"%sys.version_info[:2],'
  + '"system":platform.system().lower(),"machine":platform.machine(),"libc":platform.libc_ver()[0] or None}))']);

const describeTarget = (t) => `${t.implementation} ${t.python} ${t.system} ${t.machine}${t.libc ? ` ${t.libc}` : ''}`;

export function checkTarget(manifestTarget, host, cmd = 'python') {
  const differs = TARGET_KEYS.filter((k) => (manifestTarget[k] ?? null) !== (host?.[k] ?? null));
  if (differs.length) {
    throw new BundleError('BUNDLE_PLATFORM_MISMATCH',
      `the bundle targets ${describeTarget(manifestTarget)}; this host's ${cmd} is ${host ? describeTarget(host) : 'unknown'} (differs in ${differs.join(', ')})`,
      `export the bundle on a machine matching this host (same OS, CPU architecture and Python minor version), or install Python ${manifestTarget.python} here`);
  }
}

// One `name==version --hash=sha256:<wheel sha>` per pin of this checkout.
export function hashedRequirements(requirementsText, manifest) {
  const files = new Map(manifest.files.map((f) => [f.path, f]));
  const wheels = new Map(manifest.wheels.map((w) => [normName(w.project), w]));
  return parsePins(requirementsText).map((p) => {
    const w = wheels.get(p.norm);
    if (!w || w.version !== p.version) throw invalid(`no wheel for the pin ${p.name}==${p.version}`);
    return `${p.name}==${p.version} --hash=sha256:${files.get(w.file).sha256}`;
  }).join('\n') + '\n';
}

// pip's argv for an install from bundle files only. --isolated ignores PIP_*
// env and pip config (which could add index or find-links URLs).
export function bundleInstallArgs({ pyz, wheelsDir, requirementsFile }) {
  return [pyz, 'install', '--isolated', '--disable-pip-version-check', '--no-input', '--no-index', '--find-links', wheelsDir, '--require-hashes', '-r', requirementsFile];
}
