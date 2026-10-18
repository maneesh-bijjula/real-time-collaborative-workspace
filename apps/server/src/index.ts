import 'dotenv/config';
import { createApplication } from './app.js';
import { readConfig } from './config.js';

const application = await createApplication(readConfig());
const port = await application.listen();
console.log(`Workspace API and collaboration server listening on port ${port}`);
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    const timeout = setTimeout(() => process.exit(1), 15_000).unref();
    application.close().then(
      () => {
        clearTimeout(timeout);
        process.exit(0);
      },
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
  });
}
