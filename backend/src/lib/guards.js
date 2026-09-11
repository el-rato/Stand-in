// Production boot guards. Pure function over an env object so tests can
// exercise every branch without touching the real environment.
const WEAK = new Set(['', 'dev-only-secret-change-me', 'change-me-to-a-long-random-string']);

export function assertProdConfig(env = process.env) {
  const prod = env.NODE_ENV === 'production' || !!env.VERCEL;
  if (!prod) return;
  const secret = env.JWT_SECRET || '';
  if (WEAK.has(secret) || secret.length < 32) {
    throw new Error('JWT_SECRET must be set to a long (32+ char) random value in production');
  }
  if (!env.DATABASE_URL && env.VERCEL) {
    throw new Error('DATABASE_URL is required on Vercel — the JSON store cannot persist on serverless');
  }
}
