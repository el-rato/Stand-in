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
  payouts: [],
  reports: [],
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
      const user = { id: newId('u'), name, email, passHash, city: city || '', plan: 'free', role: 'user', createdAt: now() };
      db.users.push(user); persist();
      return { ...user };
    },
    async findUserByEmail(email) {
      const u = db.users.find(x => x.email === email);
      return u ? { ...u, role: u.role || 'user' } : null;
    },
    async findUserById(id) {
      const u = db.users.find(x => x.id === id);
      return u ? { ...u, role: u.role || 'user' } : null;
    },
    async setPlan(userId, plan) {
      const u = db.users.find(x => x.id === userId);
      if (u) { u.plan = plan; persist(); }
      return u ? { ...u } : null;
    },
    async setPassword(userId, passHash) {
      const u = db.users.find(x => x.id === userId);
      if (!u) { const e = new Error('user not found'); e.status = 404; e.code = 'not_found'; throw e; }
      u.passHash = passHash; persist();
      return true;
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
    async createJob({ askerId, title, category, label, city, rush, total, fee, doerShare, clientId, description, deadline, videoLength, moderation }) {
      if (clientId && db.jobs.some(j => j.askerId === askerId && j.clientId === clientId)) {
        return { ...db.jobs.find(j => j.askerId === askerId && j.clientId === clientId), duplicate: true };
      }
      const job = {
        id: newId('j'), askerId, title, category, label, city, rush: !!rush,
        total, fee, doerShare, clientId: clientId || null,
        description: description || '', deadline: deadline || 'asap', videoLength: videoLength || '1:30',
        moderation: moderation || { score: 0, flags: [] },
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

    // ---- admin ----
    async setRole(userId, role) {
      if (!['user', 'admin'].includes(role)) {
        const e = new Error('invalid role'); e.status = 400; e.code = 'bad_role'; throw e;
      }
      const u = db.users.find(x => x.id === userId);
      if (!u) { const e = new Error('user not found'); e.status = 404; e.code = 'not_found'; throw e; }
      u.role = role; persist();
      const { passHash, ...safe } = u;
      return safe;
    },
    async platformStats() {
      const byStatus = {};
      db.jobs.forEach(j => { byStatus[j.status] = (byStatus[j.status] || 0) + 1; });
      const paid = db.jobs.filter(j => j.status === 'paid');
      const since = new Date(); since.setUTCHours(0, 0, 0, 0);
      const paidToday = db.ledger
        .filter(t => t.type === 'release' && t.at >= since.toISOString())
        .reduce((s, t) => s + t.amount, 0);
      return {
        users: db.users.length,
        verifiedDoers: db.doers.filter(d => d.status === 'verified').length,
        jobsByStatus: byStatus,
        openJobs: byStatus.open || 0,
        gmv: paid.reduce((s, j) => s + j.total, 0),
        fees: Math.round(paid.reduce((s, j) => s + j.fee, 0) * 100) / 100,
        paidOut: paid.reduce((s, j) => s + j.doerShare, 0),
        paidToday,
      };
    },
    async listAllJobs({ status, cursor, limit = 20 }) {
      let items = db.jobs.filter(j => (!status || j.status === status));
      items = items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      if (cursor) items = items.filter(j => j.createdAt < cursor);
      const page = items.slice(0, Math.min(limit, 50));
      return { items: page.map(j => ({ ...j })), nextCursor: page.length ? page[page.length - 1].createdAt : null };
    },
    async listUsers({ q, limit = 50 }) {
      const needle = (q || '').toLowerCase();
      return db.users
        .filter(u => !needle || u.name.toLowerCase().includes(needle) || u.email.includes(needle))
        .slice(0, Math.min(limit, 5000))
        .map(({ passHash, ...rest }) => ({ ...rest, role: rest.role || 'user' }));
    },
    async recentLedger(limit = 50) {
      return db.ledger.slice(-Math.min(limit, 5000)).reverse();
    },

    // ---- reports (safety / contact inbox for owners) ----
    async createReport({ type, subject, message, contact, jobId }) {
      const row = { id: newId('r'), type, subject, message, contact: contact || '', jobId: jobId || null, at: now() };
      db.reports.push(row); persist();
      return { ...row };
    },
    async listReports({ type, limit = 50 }) {
      let items = db.reports.filter(r => (!type || r.type === type));
      items = items.sort((a, b) => (a.at < b.at ? 1 : -1));
      return items.slice(0, Math.min(limit, 200)).map(r => ({ ...r }));
    },

    // ---- payouts (single-process: sequential execution is the lock) ----
    async sumReleasedByDoer(doerId) {
      return db.ledger.filter(t => t.type === 'release' && t.actor === doerId).reduce((s, t) => s + t.amount, 0);
    },
    async sumPayoutsByDoer(doerId) {
      return db.payouts
        .filter(p => p.doerId === doerId && ['processing', 'transferred', 'queued'].includes(p.status))
        .reduce((s, p) => s + p.amount, 0);
    },
    async createPayout({ doerId, amount }) {
      const released = await this.sumReleasedByDoer(doerId);
      const used = await this.sumPayoutsByDoer(doerId);
      if (Math.round((released - used) * 100) / 100 < amount - 1e-9) {
        const e = new Error('insufficient available balance');
        e.status = 409; e.code = 'insufficient';
        throw e;
      }
      const row = { id: newId('p'), doerId, amount, status: 'processing', transferId: null, at: now(), updatedAt: now() };
      db.payouts.push(row); persist();
      return { ...row };
    },
    async setPayoutStatus(id, status, transferId) {
      const p = db.payouts.find(x => x.id === id);
      if (!p) { const e = new Error('payout not found'); e.status = 404; e.code = 'not_found'; throw e; }
      p.status = status;
      if (transferId) p.transferId = transferId;
      p.updatedAt = now(); persist();
      return { ...p };
    },
    async listPayoutsByDoer(doerId) {
      return db.payouts.filter(p => p.doerId === doerId).map(p => ({ ...p })).reverse();
    },
    async listAllPayouts(limit = 50) {
      return db.payouts.slice(-Math.min(limit, 200)).reverse().map(p => ({ ...p }));
    },
    async payoutCandidates(min) {
      const out = [];
      for (const d of db.doers.filter(x => x.status === 'verified')) {
        const released = await this.sumReleasedByDoer(d.userId);
        const used = await this.sumPayoutsByDoer(d.userId);
        const available = Math.round((released - used) * 100) / 100;
        if (available >= min) out.push({ userId: d.userId, displayName: d.displayName, released, used, available });
      }
      return out;
    },
  };
}
