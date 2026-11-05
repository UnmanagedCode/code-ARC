// server.js with a raised per-session step rate, for the harness's
// 300-step script burst only.
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';

const config = loadConfig();
const app = await createApp({ config, stepRate: { max: 1000, windowMs: 1000 } });
app.server.listen(config.port, '127.0.0.1');
process.on('SIGTERM', () => { app.close().finally(() => process.exit(0)); });
