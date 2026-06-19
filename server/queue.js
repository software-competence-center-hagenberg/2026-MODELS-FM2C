// Shared Valkey queue constants and helpers
// Uses ioredis (RESP protocol compatible with Valkey)
import { getValkey } from './config.js';

export const QUEUE_KEY = 'spl_jobs_queue';
export const EVENTS_CHANNEL = 'spl_jobs_events';

/**
 * Enqueue a job ID. The worker will BLPOP it.
 */
export async function enqueueJob(id) {
  const conn = await getValkey();
  await conn.rpush(QUEUE_KEY, id);
}

/**
 * Dequeue a job ID (blocking, with timeout in seconds).
 * Returns the job ID string or null on timeout.
 */
export async function dequeueJob(timeoutSec = 5) {
  const conn = await getValkey();
  // ioredis: blpop(key, timeoutSeconds) returns [key, value] or null
  const result = await conn.blpop(QUEUE_KEY, timeoutSec);
  return result?.[1] ?? null;
}

/**
 * Publish a status update to the events channel.
 */
export async function publishEvent(id, payload) {
  const conn = await getValkey();
  await conn.publish(EVENTS_CHANNEL, JSON.stringify({ id, ...payload }));
}

/**
 * Subscribe to the events channel.
 */
export async function subscribeEvents(callback) {
  const IORedis = (await import('ioredis')).default;
  const conn = await getValkey();
  const subscriber = new IORedis(conn.options);
  await subscriber.connect();
  subscriber.on('message', (_channel, msg) => {
    try {
      if (msg) callback(JSON.parse(msg));
    } catch {
      // ignore malformed
    }
  });
  await subscriber.subscribe(EVENTS_CHANNEL);
  return subscriber;
}
