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

    // ---- admin ----
    async platformStats() {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const jobsByStatus = {};
      for (const job of db.jobs) jobsByStatus[job.status] = (jobsByStatus[job.status] || 0) + 1;
      return {
        gmv: money(db.ledger.filter(t => t.type === 'hold').reduce((sum, t) => sum + Number(t.amount), 0)),
        fees: money(db.ledger.filter(t => t.type === 'fee').reduce((sum, t) => sum + Number(t.amount), 0)),
        openJobs: jobsByStatus.open || 0,
        paidToday: money(db.ledger.filter(t => t.type === 'release' && t.at >= today.toISOString()).reduce((sum, t) => sum + Number(t.amount), 0)),
        paidOut: money(db.payouts.filter(p => p.status === 'transferred').reduce((sum, p) => sum + Number(p.amount), 0)),
        users: db.users.length,
        verifiedDoers: db.doers.filter(d => d.status === 'verified').length,
        jobsByStatus,
      };
    },
    async listAllJobs({ status, cursor, limit = 20 }) {
      let rows = db.jobs.filter(j => !status || j.status === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      if (cursor) rows = rows.filter(j => j.createdAt < cursor);
      const size = Math.min(Math.max(limit, 1), 50);
      const page = rows.slice(0, size);
      return { items: page.map(j => ({ ...j })), nextCursor: rows.length > size ? page.at(-1).createdAt : null };
    },
    async listUsers({ q = '', limit = 50 }) {
      const needle = q.toLowerCase();
      return db.users
        .filter(u => !needle || u.name.toLowerCase().includes(needle) || u.email.toLowerCase().includes(needle))
        .slice(0, Math.min(Math.max(limit, 1), 5000))
        .map(({ passHash, ...user }) => ({ ...user }));
    },
    async setRole(userId, role) {
      const user = db.users.find(u => u.id === userId);
      if (!user) { const e = new Error('user not found'); e.status = 404; e.code = 'not_found'; throw e; }
      user.role = role; persist();
      const { passHash, ...safe } = user;
      return { ...safe };
    },
    async recentLedger(limit = 50) {
      return db.ledger.slice().sort((a, b) => b.at.localeCompare(a.at)).slice(0, Math.min(Math.max(limit, 1), 5000)).map(t => ({
        ...t,
        jobTitle: db.jobs.find(j => j.id === t.jobId)?.title || null,
      }));
    },

    // ---- reports ----
    async createReport(input) {
      const row = { id: newId('r'), ...input, createdAt: now() };
      db.reports.push(row); persist();
      return { ...row };
    },
    async listReports({ type, limit = 50 }) {
      return db.reports.filter(r => !type || r.type === type).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.min(Math.max(limit, 1), 5000)).map(r => ({ ...r }));
    },

    // ---- payouts ----
    async sumReleasedByDoer(doerId) {
      const jobIds = new Set(db.jobs.filter(j => j.doerId === doerId).map(j => j.id));
      return money(db.ledger.filter(t => t.type === 'release' && jobIds.has(t.jobId)).reduce((sum, t) => sum + Number(t.amount), 0));
    },
    async sumPayoutsByDoer(doerId) {
      return money(db.payouts.filter(p => p.doerId === doerId && ['processing', 'transferred', 'queued'].includes(p.status)).reduce((sum, p) => sum + Number(p.amount), 0));
    },
    async createPayout({ doerId, amount }) {
      const released = await this.sumReleasedByDoer(doerId);
      const used = await this.sumPayoutsByDoer(doerId);
      if (amount > released - used + 0.001) { const e = new Error('payout balance changed'); e.status = 409; e.code = 'balance_changed'; throw e; }
      const row = { id: newId('p'), doerId, amount: money(amount), status: 'processing', transferId: null, createdAt: now(), updatedAt: now() };
      db.payouts.push(row); persist();
      return { ...row };
    },
    async setPayoutStatus(id, status, transferId = null) {
      const payout = db.payouts.find(p => p.id === id);
      if (!payout) { const e = new Error('payout not found'); e.status = 404; e.code = 'not_found'; throw e; }
      Object.assign(payout, { status, transferId, updatedAt: now() }); persist();
      return { ...payout };
    },
    async listPayoutsByDoer(doerId) {
      return db.payouts.filter(p => p.doerId === doerId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(p => ({ ...p }));
    },
    async listAllPayouts(limit = 50) {
      return db.payouts.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.min(Math.max(limit, 1), 5000)).map(p => ({ ...p }));
    },
  };
}

function money(value) {
  return Math.round(Number(value) * 100) / 100;
}
