// Zero-dependency JSON store for local demo/dev.
// Same async interface as postgresStore.js — the routes never know which
// backend is active. Writes are atomic (tmp file + rename). Single-process
// only: run one replica with this store; use Postgres for multi-replica.

import fs from 'node:fs';
import path from 'node:path';
import { newId } from '../lib/util.js';

const empty = () => ({
  users: [],
  doers: [],
  jobs: [],
  ledger: [],
  apiKeys: [],
  idempotency: {},
});

export function createJsonStore(filePath) {
  let db = empty();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath)) {
      db = { ...empty(), ...JSON.parse(fs.readFileSync(filePath, 'utf8')) };
    } else {
      persist();
    }
  } catch {
    db = empty();
  }

  function persist() {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, filePath);
  }

  const now = () => new Date().toISOString();

  return {
    kind: 'json',

    // ---- users ----
    async createUser({ name, email, passHash, city }) {
      if (db.users.some(u => u.email === email)) {
        const err = new Error('email already registered');
        err.status = 409; err.code = 'email_taken';
        throw err;
      }
      const user = { id: newId('u'), name, email, passHash, city: city || '', plan: 'free', createdAt: now() };
      db.users.push(user); persist();
      return { ...user };
    },
    async findUserByEmail(email) {
      return db.users.find(u => u.email === email) || null;
    },
    async findUserById(id) {
      return db.users.find(u => u.id === id) || null;
    },
    async setPlan(userId, plan) {
      const u = db.users.find(x => x.id === userId);
      if (u) { u.plan = plan; persist(); }
      return u ? { ...u } : null;
    },

    // ---- doers ----
    async getDoer(userId) {
      return db.doers.find(d => d.userId === userId) || null;
    },
    async upsertDoer(userId, patch) {
      let d = db.doers.find(x => x.userId === userId);
      if (!d) { d = { userId, status: 'pending', createdAt: now() }; db.doers.push(d); }
      Object.assign(d, patch, { updatedAt: now() });
      persist();
      return { ...d };
    },

    // ---- jobs ----
    async createJob({ askerId, title, category, label, city, rush, total, fee, doerShare, clientId }) {
      if (clientId && db.jobs.some(j => j.askerId === askerId && j.clientId === clientId)) {
        return { ...db.jobs.find(j => j.askerId === askerId && j.clientId === clientId), duplicate: true };
      }
      const job = {
        id: newId('j'), askerId, title, category, label, city, rush: !!rush,
        total, fee, doerShare, clientId: clientId || null,
        status: 'open', doerId: null, videoUrl: null,
        createdAt: now(), updatedAt: now(),
      };
      db.jobs.push(job);
      db.ledger.push({ id: newId('t'), jobId: job.id, type: 'hold', amount: total, actor: askerId, at: now() });
      persist();
      return { ...job };
    },
    async getJob(id) {
      return db.jobs.find(j => j.id === id) || null;
    },
    async listFeed({ status = 'open', city, cursor, limit = 20 }) {
      let items = db.jobs.filter(j => (!status || j.status === status) && (!city || j.city === city));
      items = items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      if (cursor) items = items.filter(j => j.createdAt < cursor);
      const page = items.slice(0, Math.min(limit, 50));
      return { items: page.map(j => ({ ...j })), nextCursor: page.length ? page[page.length - 1].createdAt : null };
    },
    async listByUser(userId) {
      return db.jobs.filter(j => j.askerId === userId || j.doerId === userId).map(j => ({ ...j }));
    },
    // Compare-and-set transition: throws 409 if status moved under us.
    async transitionJob(id, from, mutate) {
      const job = db.jobs.find(j => j.id === id);
      if (!job) { const e = new Error('job not found'); e.status = 404; e.code = 'not_found'; throw e; }
      const expected = Array.isArray(from) ? from : [from];
      if (!expected.includes(job.status)) {
        const e = new Error(`invalid transition from ${job.status}`);
        e.status = 409; e.code = 'bad_transition';
        throw e;
      }
      mutate(job);
      job.updatedAt = now();
      persist();
      return { ...job };
    },
    async appendLedger(entry) {
      const row = { id: newId('t'), at: now(), ...entry };
      db.ledger.push(row); persist();
      return row;
    },
    async ledgerByJob(jobId) {
      return db.ledger.filter(t => t.jobId === jobId);
    },
    async sumReleasedSince(iso) {
      return db.ledger.filter(t => t.type === 'release' && t.at >= iso).reduce((s, t) => s + t.amount, 0);
    },
    async countOpen() {
      return db.jobs.filter(j => j.status === 'open').length;
    },

    // ---- idempotency (memory-backed in PG; here persisted) ----
    async idemGet(key) {
      return db.idempotency[key] || null;
    },
    async idemSet(key, value) {
      db.idempotency[key] = value; persist();
    },

    // ---- api keys (B2B) ----
    async createApiKey({ userId, name, hash, prefix }) {
      const row = { id: newId('k'), userId, name, hash, prefix, createdAt: now() };
      db.apiKeys.push(row); persist();
      return { ...row };
    },
    async listApiKeys(userId) {
      return db.apiKeys.filter(k => k.userId === userId).map(({ hash, ...rest }) => rest);
    },
    async findApiKeyByHash(hash) {
      return db.apiKeys.find(k => k.hash === hash) || null;
    },
  };
}
