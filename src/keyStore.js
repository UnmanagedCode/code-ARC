// The ARC API key, stored at <dataDir>/secrets.json with mode 0600. get() is
// the only accessor that returns the key; everything user-facing uses
// status(), which exposes at most the last four characters.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic, readJsonBounded } from './atomicFile.js';

const KEY_RE = /^[A-Za-z0-9._-]{8,256}$/;
// Shorter keys are masked completely: four characters of a short key is
// too much of it.
const TAIL_MIN_LENGTH = 16;

export function createKeyStore({ dataDir }) {
  const file = path.join(dataDir, 'secrets.json');

  async function get() {
    const data = await readJsonBounded(file, 4096);
    if (data === null) return null;
    if (typeof data !== 'object' || typeof data.arcApiKey !== 'string' || !KEY_RE.test(data.arcApiKey)) {
      throw new Error(`${file} is malformed; clear the key in Settings or delete the file`);
    }
    return data.arcApiKey;
  }

  return {
    get,
    async status() {
      const key = await get();
      if (key === null) return { set: false, masked: null };
      return { set: true, masked: key.length >= TAIL_MIN_LENGTH ? `••••${key.slice(-4)}` : '••••' };
    },
    async set(key) {
      const k = typeof key === 'string' ? key.trim() : '';
      if (!KEY_RE.test(k)) {
        // Never echo the submitted value.
        throw Object.assign(new Error('API key must be 8-256 characters of A-Z a-z 0-9 . _ -'), { code: 'INVALID_KEY' });
      }
      await writeFileAtomic(file, JSON.stringify({ arcApiKey: k }));
    },
    async clear() {
      await fs.rm(file, { force: true });
    },
  };
}
