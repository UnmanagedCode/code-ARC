// Crash-safe writes (tmp file + rename) and size-bounded JSON reads.
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';

export async function writeFileAtomic(file, data, mode = 0o600) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, data, { mode });
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

// The parsed JSON, or null when the file does not exist. Throws on a file
// over maxBytes or malformed JSON, naming the file.
export async function readJsonBounded(file, maxBytes) {
  let fh;
  try {
    fh = await fs.open(file, 'r');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    const { size } = await fh.stat();
    if (size > maxBytes) throw new Error(`${file} is ${size} bytes, over the ${maxBytes}-byte limit`);
    const text = await fh.readFile('utf8');
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`${file} is not valid JSON: ${e.message}`);
    }
  } finally {
    await fh.close();
  }
}
