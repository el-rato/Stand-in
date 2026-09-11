// Production boot guards. Pure function over an env object so tests can
// exercise every branch without touching the real environment.
const WEAK = new Set(['', 'dev-only-secret-change-me', 'change-me-to-a-long-random-string']);

export function assertProdConfig(env = process.env) {
  const prod = env.NODE_ENV === 'production' || !!env.VERCEL;
  if (!prod) return;
  const problems = [];
  const secret = env.JWT_SECRET || '';
  if (WEAK.has(secret) || secret.length < 32) {
    problems.push('JWT_SECRET must be set to a long (32+ char) random value in production');
  }
  if (!env.DATABASE_URL && env.VERCEL) {
    problems.push('DATABASE_URL is required on Vercel - the JSON store cannot persist on serverless');
  }
  if (env.VERCEL && !env.REDIS_URL) {
    problems.push('REDIS_URL is required on Vercel for shared rate limits and realtime events');
  }
  if (env.VERCEL && !env.S3_BUCKET) {
    problems.push('S3_BUCKET is required on Vercel for persistent uploads');
  }
  if (env.STRIPE_SECRET && !env.STRIPE_WEBHOOK_SECRET) {
    problems.push('STRIPE_WEBHOOK_SECRET is required when STRIPE_SECRET is set');
  }
  if (problems.length) throw new Error(problems.join('; '));
}
