// Standalone worker process — polls Valkey queue, processes generation jobs
// Run with: node server/worker-standalone.js
import { GenerationStore } from './store.js';
import { getValkey } from './config.js';
import { QUEUE_KEY, publishEvent } from './queue.js';
import { ID_PATTERN } from './config.js';
import { GenerationWorker, runPreviewBuild } from './worker.js';

const store = new GenerationStore();

const events = {
  publish(id, payload) {
    void publishEvent(id, payload).catch((err) =>
      console.error('[worker] failed to publish event:', err.message),
    );
  },
};

const worker = new GenerationWorker(store, events);

async function main() {
  await getValkey();
  console.log('[worker] connected to Valkey, waiting for jobs...');

  while (true) {
    try {
      const conn = await getValkey();
      // ioredis blpop: blpop(key, timeoutSeconds) returns [key, value] or null
      const result = await conn.blpop(QUEUE_KEY, 5);
      const item = result?.[1] ?? null;
      if (!item) continue;

      console.log('[worker] picked up job:', item);

      if (item.startsWith('enhance:')) {
        const parts = item.split(':');
        const id = parts[1];
        const instructionsB64 = parts.slice(2).join(':');
        const instructions = Buffer.from(instructionsB64, 'base64url').toString('utf8');
        await worker.enhanceJob(id, instructions);
      } else if (item.startsWith('preview:')) {
        const id = item.split(':')[1];
        await handlePreview(id);
      } else {
        if (ID_PATTERN.test(item)) {
          worker.enqueue(item);
        } else {
          console.warn('[worker] invalid job id:', item);
        }
      }
    } catch (err) {
      console.error('[worker] poll error:', err.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function handlePreview(id) {
  const view = store.getView(id);
  if (!view) {
    console.warn(`[worker] preview: view ${id} not found`);
    return;
  }
  try {
    events.publish(id, { status: view.status, message: 'Building preview...' });
    await runPreviewBuild(id);
    events.publish(id, { status: 'preview-ready', message: 'Preview build complete.' });
  } catch (err) {
    console.error(`[worker] preview ${id} failed:`, err.message);
    events.publish(id, { status: 'error', message: `Preview build failed: ${err.message}` });
  }
}

process.on('SIGTERM', () => {
  console.log('[worker] shutting down...');
  process.exit(0);
});
process.on('SIGINT', () => {
  process.exit(0);
});

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
