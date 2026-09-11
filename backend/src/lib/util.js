import crypto from 'node:crypto';

export function newId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(9).toString('hex')}`;
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function publicJob(job) {
  if (!job) return job;
  const { ...rest } = job;
  return rest;
}
