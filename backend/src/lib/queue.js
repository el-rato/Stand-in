// Background work queue. Default runs inline (setImmediate) so the demo
// needs no infrastructure. Scale path: back this with BullMQ + Redis and
// move verification callbacks, payout runs, notifications and moderation
// scans into named jobs with retries. Callers use `enqueue()` either way.

export async function enqueue(name, payload = {}) {
  // In-process execution with at-least-once logging.
  setImmediate(async () => {
    try {
      await handle(name, payload);
    } catch (err) {
      console.error(`[queue] job failed: ${name}`, err.message);
    }
  });
  return { queued: name };
}

async function handle(name, payload) {
  switch (name) {
    case 'verification.completed':
      // Hook: notify user, update search index, warm recommendation cache.
      break;
    case 'payout.released':
      // Hook: trigger Stripe transfer / payout batching per doer.
      break;
    case 'moderation.scan':
      // Hook: async media safety scan on delivered videoUrl.
      break;
    default:
      break;
  }
}
