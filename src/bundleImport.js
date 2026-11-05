// Installs a bundle archive into <data>/bundle. The archive is untrusted:
// every entry is checked against the manifest (its first entry) while it
// streams into a private staging dir, the staging dir is verified like a
// placed bundle, and only then renamed into the slot. Any failure removes
// staging and leaves the slot as it was. One import at a time per data dir.
import { randomBytes, createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import {
  BUNDLE_LIMITS, BundleError, MANIFEST_FILE, parseManifest, sha256, validateBundlePath, verifyBundle,
} from './bundle.js';
import { readTar, TarError } from './tar.js';

const STAGING_PREFIX = '.bundle-staging-';
const OLD_PREFIX = '.bundle-old-';
// The ratio check's floor on compressed input, so a small archive's tar
// padding never trips it.
const RATIO_FLOOR_BYTES = 64 * 1024;

const invalid = (msg) => new BundleError('BUNDLE_INVALID', msg);
const rand = () => randomBytes(6).toString('hex');

async function lstatOrNull(p) {
  try {
    return await fs.lstat(p);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// Removes staging/old dirs a crashed import left (exact prefix, real dirs only).
async function sweep(dataDir, log) {
  for (const name of await fs.readdir(dataDir)) {
    if (!name.startsWith(STAGING_PREFIX) && !name.startsWith(OLD_PREFIX)) continue;
    const p = path.join(dataDir, name);
    const st = await fs.lstat(p);
    if (st.isDirectory() && !st.isSymbolicLink()) {
      log.log?.(`[code-arc bundle] removing a stale ${name}`);
      await fs.rm(p, { recursive: true, force: true });
    }
  }
}

// Streams the archive's entries into `staging`; resolves the manifest buffer.
async function extract({ archive, staging, expectId, limits }) {
  let inBytes = 0;
  let outBytes = 0;
  let manifestBuf = null;
  let manifest = null;
  let listed = null;
  let ancestors = null;
  const seen = new Set();
  let open = null;

  const counter = new Transform({
    transform(chunk, _enc, cb) {
      inBytes += chunk.length;
      cb(null, chunk);
    },
  });
  const gunzip = createGunzip();
  const piping = pipeline(createReadStream(archive), counter, gunzip).catch(() => {});

  async function* limited() {
    for await (const chunk of gunzip) {
      outBytes += chunk.length;
      if (outBytes > limits.totalMaxBytes || outBytes > limits.ratioMax * Math.max(inBytes, RATIO_FLOOR_BYTES)) {
        throw invalid(`decompression limit exceeded (${outBytes} bytes out of ${inBytes} in)`);
      }
      yield chunk;
    }
  }

  async function onEntry(e) {
    if (!manifest) {
      if (manifestBuf) throw invalid('entries after an unreadable manifest');
      if (e.type !== 'file' || e.path !== MANIFEST_FILE) throw invalid(`the first entry must be ${MANIFEST_FILE}, not ${e.path}`);
      if (e.size > limits.manifestMaxBytes) throw invalid(`${MANIFEST_FILE} is over ${limits.manifestMaxBytes} bytes`);
      const parts = [];
      return {
        write: (c) => { parts.push(Buffer.from(c)); },
        end: async () => {
          manifestBuf = Buffer.concat(parts);
          manifest = parseManifest(manifestBuf, limits);
          const id = sha256(manifestBuf);
          if (expectId && id !== expectId) {
            throw new BundleError('BUNDLE_ID_MISMATCH', `the archive's bundle id is ${id}, expected ${expectId}`);
          }
          listed = new Map(manifest.files.map((f) => [f.path, f]));
          ancestors = new Set();
          for (const p of listed.keys()) {
            const segs = p.split('/');
            for (let i = 1; i < segs.length; i++) ancestors.add(segs.slice(0, i).join('/'));
          }
          await fs.writeFile(path.join(staging, MANIFEST_FILE), manifestBuf, { flag: 'wx', mode: 0o600 });
        },
      };
    }
    if (e.type === 'dir') {
      if (!ancestors.has(e.path)) throw invalid(`unexpected directory entry ${e.path}`);
      return null;
    }
    validateBundlePath(e.path, limits);
    const f = listed.get(e.path);
    if (!f) throw invalid(`unlisted file ${e.path}`);
    if (seen.has(e.path)) throw invalid(`duplicate entry ${e.path}`);
    seen.add(e.path);
    if (seen.size > limits.filesMax) throw invalid(`over ${limits.filesMax} files`);
    if (e.size !== f.size) throw invalid(`${e.path} is ${e.size} bytes in the archive, the manifest says ${f.size}`);
    const dest = path.join(staging, ...e.path.split('/'));
    await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    const fh = await fs.open(dest, 'wx', 0o600);
    open = fh;
    const h = createHash('sha256');
    return {
      write: async (c) => {
        h.update(c);
        await fh.write(c);
      },
      end: async () => {
        open = null;
        await fh.close();
        const got = h.digest('hex');
        if (got !== f.sha256) throw new BundleError('BUNDLE_HASH_MISMATCH', `${e.path} has sha256 ${got}, the manifest says ${f.sha256}`);
      },
    };
  }

  try {
    await readTar(limited(), { onEntry });
  } catch (e) {
    gunzip.destroy();
    throw e;
  } finally {
    if (open) await open.close().catch(() => {});
    await piping;
  }
  if (!manifest) throw invalid('the archive is empty');
  const missing = [...listed.keys()].filter((p) => !seen.has(p));
  if (missing.length) throw invalid(`missing file ${missing[0]}${missing.length > 1 ? ` (and ${missing.length - 1} more)` : ''}`);
}

export async function importBundle({
  archive, dataDir, checkoutDir, replace = false, expectId = null, limits = BUNDLE_LIMITS, log = console,
}) {
  let st;
  try {
    st = await fs.stat(archive);
  } catch (e) {
    throw invalid(`cannot read ${archive} (${e.code})`);
  }
  if (!st.isFile()) throw invalid(`${archive} is not a regular file`);
  if (st.size > limits.archiveMaxBytes) throw invalid(`${archive} is over ${limits.archiveMaxBytes} bytes`);
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await sweep(dataDir, log);
  const slot = path.join(dataDir, 'bundle');
  const existing = await lstatOrNull(slot);
  if (existing && !replace) throw new BundleError('BUNDLE_EXISTS', `${slot} already holds a bundle`);
  const requirementsText = await fs.readFile(path.join(checkoutDir, 'requirements.txt'), 'utf8');

  const staging = path.join(dataDir, `${STAGING_PREFIX}${rand()}`);
  await fs.mkdir(staging, { mode: 0o700 });
  try {
    try {
      await extract({ archive, staging, expectId, limits });
    } catch (e) {
      if (e instanceof TarError) throw invalid(`malformed archive: ${e.message}`);
      if (typeof e.code === 'string' && e.code.startsWith('Z_')) throw invalid(`not a gzip archive (${e.message})`);
      throw e;
    }
    const { id, manifest } = await verifyBundle(staging, { requirementsText, limits });
    if (!existing) {
      await fs.rename(staging, slot);
    } else {
      const old = path.join(dataDir, `${OLD_PREFIX}${rand()}`);
      await fs.rename(slot, old);
      try {
        await fs.rename(staging, slot);
      } catch (e) {
        await fs.rename(old, slot);
        throw e;
      }
      await fs.rm(old, { recursive: true, force: true });
    }
    return { id, dir: slot, manifest };
  } catch (e) {
    await fs.rm(staging, { recursive: true, force: true });
    throw e;
  }
}
