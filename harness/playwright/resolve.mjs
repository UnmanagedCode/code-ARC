import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.CC_PROJECTS_ROOT;
if (!root) throw new Error('CC_PROJECTS_ROOT is not set: export the absolute projects root');
const file = path.join(root, '.plugins', 'code-playwright', 'browser.mjs');
if (!existsSync(file)) throw new Error(`code-playwright not found at ${file}`);
export const BROWSER = pathToFileURL(file).href;
