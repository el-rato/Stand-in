// Text moderation for job posts: blocklist (reject) + watchlist (flag for
// owner review). Runs server-side on every POST /jobs — the client pre-scan
// is UX sugar only. Worded to never fire on legit jobs (proposal, bar,
// night, roast, film, street all pass — covered by tests).

const BLOCK = [
  {
    code: 'sexual_content',
    message: 'No sexual content — this marketplace is public-place tasks only.',
    patterns: [/\b(sex|porn|nude|naked|escort|hookup|hook-up|onlyfans|xxx|adult fun)\b/i],
  },
  {
    code: 'contact_info',
    message: 'Leave phone numbers and emails out — all chat stays on-platform.',
    patterns: [
      /\+?\d(?:[\d\s().-]{6,}\d)/, // phone-ish runs (prices like $5 can't match: too short)
      /[\w.+-]+@[\w-]+\.[\w.]+/, // email
      /\b(whatsapp|telegram|signal|snapchat)\b.{0,20}\d/i,
    ],
  },
  {
    code: 'private_meetup',
    message: 'Public places only — no private meetups, addresses, or indoor one-on-ones.',
    patterns: [
      /\b(my (place|apartment|flat|house|hotel|room|bedroom))\b/i,
      /\bcome (over|to (my|mine))\b/i,
      /\bmeet (me )?(alone|in private|at night|after dark)\b/i,
      /\b(bedroom|bathroom|shower|behind closed doors)\b/i,
    ],
  },
  {
    code: 'violence',
    message: 'No violent content, pranks included.',
    patterns: [/\b(kill|murder|stab|shoot (him|her|them|someone|people)|bomb|assault|strangle)\b/i],
  },
  {
    code: 'offplatform',
    message: 'No links — keep everything on-platform.',
    patterns: [/https?:\/\//i, /\b(bit\.ly|tinyurl|discord\.gg|t\.me\/)\b/i],
  },
];

const CAPS_MIN_LEN = 20;

function capsRatio(text) {
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length < CAPS_MIN_LEN) return 0;
  return letters.replace(/[^A-Z]/g, '').length / letters.length;
}

export function scanJob({ title = '', description = '' }) {
  const text = `${title}\n${description}`;
  const blocked = [];
  for (const rule of BLOCK) {
    if (rule.patterns.some((re) => re.test(text))) blocked.push({ code: rule.code, message: rule.message });
  }
  const flagged = [];
  if (capsRatio(text) > 0.7) flagged.push({ code: 'shouting', message: 'Mostly ALL CAPS.' });
  if (/(.)\1{5,}/.test(text)) flagged.push({ code: 'spam_shapes', message: 'Repeated characters.' });
  if (/\bfree money\b/i.test(text) || /\$\s?\d{5,}/.test(text)) flagged.push({ code: 'bait', message: 'Looks like bait.' });
  const score = Math.min(1, blocked.length + flagged.length * 0.4);
  return { ok: blocked.length === 0, blocked, flagged, score };
}

export function blockMessage(scan) {
  return scan.blocked[0] ? scan.blocked[0].message : 'Rejected by moderation.';
}
