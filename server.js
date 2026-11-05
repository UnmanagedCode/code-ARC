// Entry point: build the config, start the app on 127.0.0.1:$PORT, stop the
// sidecar's process group on SIGTERM/SIGINT.
import { createApp } from './src/app.js';
import { loadConfig } from './src/config.js';

let config;
try {
  config = loadConfig();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const app = await createApp({ config });
app.server.listen(config.port, '127.0.0.1', () => {
  console.log(`code-arc listening on http://127.0.0.1:${app.server.address().port}`);
});

let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    app.close().finally(() => process.exit(0));
  });
}
