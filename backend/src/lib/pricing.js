// Server-authoritative pricing. The client NEVER sets the price —
// it sends a category key (+ rush flag) and the server computes the total.
// This is what makes the take-rate enforceable at scale.

export const CATEGORIES = {
  wake_roast: { base: 3, label: 'Wake-up roast' },
  place_check: { base: 5, label: 'Place check' },
  hype: { base: 4, label: 'Hype bundle x10' },
  pitch: { base: 6, label: 'Practice my pitch' },
  proposal: { base: 9, label: 'Proposal filming' },
  queue: { base: 14, label: 'Queue / errand' },
};

export const RUSH_FEE = 2;
export const PLATFORM_FEE_BPS = 2000; // 20%
export const DOER_SHARE_BPS = 8000; // 80%

export function quoteJob(category, rush = false) {
  const cat = CATEGORIES[category];
  if (!cat) {
    const err = new Error(`unknown category: ${category}`);
    err.status = 400;
    err.code = 'bad_category';
    throw err;
  }
  const total = cat.base + (rush ? RUSH_FEE : 0);
  const fee = Math.round((total * PLATFORM_FEE_BPS) / 10000 * 100) / 100;
  const doer = Math.round((total - fee) * 100) / 100;
  return { category, label: cat.label, rush: !!rush, total, fee, doer };
}
