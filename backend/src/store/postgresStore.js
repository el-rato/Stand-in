// Postgres store — same interface as jsonStore.js.
// Activated when DATABASE_URL is set (requires `npm i pg`).
// Run migrations/001_init.sql first. All state changes use transactions
// with SELECT ... FOR UPDATE so concurrent claim/approve calls are safe
// across any number of API replicas.

import { newId } from '../lib/util.js';

export function createPostgresStore(databaseUrl) {
  let Pool;
  try {
    ({ Pool } = awaitImportPg());
  } catch {
    throw new Error('postgres store needs the "pg" package: run `npm i pg`');
  }
  const pool = new Pool({ connectionString: databaseUrl });

  const now = () => new Date().toISOString();

  return {
    kind: 'postgres',

    async createUser({ name, email, passHash, city }) {
      const id = newId('u');
      try {
        const { rows } = await pool.query(
          `INSERT INTO users (id, name, email, pass_hash, city, plan) VALUES ($1,$2,$3,$4,$5,'free') RETURNING id, name, email, city, plan, created_at AS "createdAt"`,
          [id, name, email, passHash, city || '']
        );
        return mapUser(rows[0]);
      } catch (e) {
        if (e.code === '23505') { const err = new Error('email already registered'); err.status = 409; err.code = 'email_taken'; throw err; }
        throw e;
      }
    },
    async findUserByEmail(email) {
      const { rows } = await pool.query(`SELECT * FROM users WHERE email=$1`, [email]);
      return rows[0] ? mapUserFull(rows[0]) : null;
    },
    async findUserById(id) {
      const { rows } = await pool.query(`SELECT * FROM users WHERE id=$1`, [id]);
      return rows[0] ? mapUserFull(rows[0]) : null;
    },
    async setPlan(userId, plan) {
      const { rows } = await pool.query(`UPDATE users SET plan=$2 WHERE id=$1 RETURNING id, name, email, city, plan`, [userId, plan]);
      return rows[0] || null;
    },
    async setPassword(userId, passHash) {
      await pool.query(`UPDATE users SET pass_hash=$2 WHERE id=$1`, [userId, passHash]);
      return true;
    },

    async getDoer(userId) {
      const { rows } = await pool.query(`SELECT * FROM doer_profiles WHERE user_id=$1`, [userId]);
      return rows[0] ? mapDoer(rows[0]) : null;
    },
    async upsertDoer(userId, patch) {
      const { rows } = await pool.query(
        `INSERT INTO doer_profiles (user_id, display_name, city, status, stripe_account_id)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_id) DO UPDATE SET display_name=COALESCE($2, doer_profiles.display_name), city=COALESCE($3, doer_profiles.city), status=COALESCE($4, doer_profiles.status), stripe_account_id=COALESCE($5, doer_profiles.stripe_account_id), updated_at=NOW()
         RETURNING *`,
        [userId, patch.displayName || null, patch.city || null, patch.status || null, patch.stripeAccountId || null]
      );
      return mapDoer(rows[0]);
    },

    async createJob({ askerId, title, category, label, city, rush, total, fee, doerShare, clientId, description, deadline, videoLength, moderation }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (clientId) {
          const dup = await client.query(`SELECT * FROM jobs WHERE asker_id=$1 AND client_id=$2`, [askerId, clientId]);
          if (dup.rows[0]) { await client.query('ROLLBACK'); return { ...mapJob(dup.rows[0]), duplicate: true }; }
        }
        const id = newId('j');
        const { rows } = await client.query(
          `INSERT INTO jobs (id, asker_id, title, category, label, city, rush, total, fee, doer_share, client_id, description, deadline, video_length, moderation, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'open') RETURNING *`,
          [id, askerId, title, category, label, city, !!rush, total, fee, doerShare, clientId || null,
            description || '', deadline || 'asap', videoLength || '1:30', JSON.stringify(moderation || { score: 0, flags: [] })]
        );
        await client.query(`INSERT INTO ledger (id, job_id, type, amount, actor) VALUES ($1,$2,'hold',$3,$4)`, [newId('t'), id, total, askerId]);
        await client.query('COMMIT');
        return mapJob(rows[0]);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    async getJob(id) {
      const { rows } = await pool.query(`SELECT * FROM jobs WHERE id=$1`, [id]);
      return rows[0] ? mapJob(rows[0]) : null;
    },
    async listFeed({ status = 'open', city, cursor, limit = 20 }) {
      const lim = Math.min(limit, 50);
      const params = [];
      let where = '';
      if (status) { params.push(status); where += `status=$${params.length}`; }
      if (city) { params.push(city); where += (where ? ' AND ' : '') + `city=$${params.length}`; }
      if (cursor) { params.push(cursor); where += (where ? ' AND ' : '') + `created_at < $${params.length}`; }
      params.push(lim + 1);
      const { rows } = await pool.query(
        `SELECT * FROM jobs ${where ? 'WHERE ' + where : ''} ORDER BY created_at DESC LIMIT $${params.length}`,
        params
      );
      const hasMore = rows.length > lim;
      const page = rows.slice(0, lim).map(mapJob);
      return { items: page, nextCursor: hasMore ? page[page.length - 1].createdAt : null };
    },
    async listByUser(userId) {
      const { rows } = await pool.query(`SELECT * FROM jobs WHERE asker_id=$1 OR doer_id=$1 ORDER BY created_at DESC`, [userId]);
      return rows.map(mapJob);
    },
    async transitionJob(id, from, mutate) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(`SELECT * FROM jobs WHERE id=$1 FOR UPDATE`, [id]);
        if (!rows[0]) { const e = new Error('job not found'); e.status = 404; e.code = 'not_found'; throw e; }
        const job = mapJob(rows[0]);
        const expected = Array.isArray(from) ? from : [from];
        if (!expected.includes(job.status)) {
          const e = new Error(`invalid transition from ${job.status}`);
          e.status = 409; e.code = 'bad_transition';
          throw e;
        }
        const draft = { ...job };
        mutate(draft); // mutate camelCase draft
        await client.query(
          `UPDATE jobs SET status=$2, doer_id=$3, video_url=$4, updated_at=NOW() WHERE id=$1`,
          [id, draft.status, draft.doerId || null, draft.videoUrl || null]
        );
        await client.query('COMMIT');
        const fresh = await pool.query(`SELECT * FROM jobs WHERE id=$1`, [id]);
        return mapJob(fresh.rows[0]);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    async appendLedger(entry) {
      const { rows } = await pool.query(
        `INSERT INTO ledger (id, job_id, type, amount, actor) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [newId('t'), entry.jobId, entry.type, entry.amount, entry.actor || null]
      );
      return rows[0];
    },
    async ledgerByJob(jobId) {
      const { rows } = await pool.query(`SELECT * FROM ledger WHERE job_id=$1 ORDER BY created_at`, [jobId]);
      return rows;
    },
    async sumReleasedSince(iso) {
      const { rows } = await pool.query(`SELECT COALESCE(SUM(amount),0) AS s FROM ledger WHERE type='release' AND created_at >= $1`, [iso]);
      return Number(rows[0].s);
    },
    async countOpen() {
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM jobs WHERE status='open'`);
      return rows[0].c;
    },

    async idemGet(key) {
      const { rows } = await pool.query(`SELECT response FROM idempotency WHERE key=$1`, [key]);
      return rows[0] ? rows[0].response : null;
    },
    async idemSet(key, value) {
      await pool.query(
        `INSERT INTO idempotency (key, response) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`,
        [key, value]
      );
    },

    async createApiKey({ userId, name, hash, prefix }) {
      const { rows } = await pool.query(
        `INSERT INTO api_keys (id, user_id, name, hash, prefix) VALUES ($1,$2,$3,$4,$5) RETURNING id, user_id AS "userId", name, prefix, created_at AS "createdAt"`,
        [newId('k'), userId, name, hash, prefix]
      );
      return rows[0];
    },
    async listApiKeys(userId) {
      const { rows } = await pool.query(`SELECT id, user_id AS "userId", name, prefix, created_at AS "createdAt" FROM api_keys WHERE user_id=$1`, [userId]);
      return rows;
    },
    async findApiKeyByHash(hash) {
      const { rows } = await pool.query(`SELECT * FROM api_keys WHERE hash=$1`, [hash]);
      return rows[0] || null;
    },

    // ---- admin ----
    async setRole(userId, role) {
      if (!['user', 'admin'].includes(role)) {
        const e = new Error('invalid role'); e.status = 400; e.code = 'bad_role'; throw e;
      }
      const { rows } = await pool.query(
        `UPDATE users SET role=$2 WHERE id=$1 RETURNING id, name, email, city, plan, role`,
        [userId, role]
      );
      if (!rows[0]) { const e = new Error('user not found'); e.status = 404; e.code = 'not_found'; throw e; }
      return rows[0];
    },
    async platformStats() {
      const [byStatus, money, users, doers] = await Promise.all([
        pool.query(`SELECT status, COUNT(*)::int AS c FROM jobs GROUP BY status`),
        pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(total),0)::float AS gmv, COALESCE(SUM(fee),0)::float AS fees, COALESCE(SUM(doer_share),0)::float AS paid FROM jobs WHERE status='paid'`),
        pool.query(`SELECT COUNT(*)::int AS c FROM users`),
        pool.query(`SELECT COUNT(*)::int AS c FROM doer_profiles WHERE status='verified'`),
      ]);
      const since = new Date(); since.setUTCHours(0, 0, 0, 0);
      const paidToday = await this.sumReleasedSince(since.toISOString());
      const jobsByStatus = {};
      byStatus.rows.forEach(r => { jobsByStatus[r.status] = r.c; });
      return {
        users: users.rows[0].c,
        verifiedDoers: doers.rows[0].c,
        jobsByStatus,
        openJobs: jobsByStatus.open || 0,
        gmv: money.rows[0].gmv, fees: money.rows[0].fees, paidOut: money.rows[0].paid,
        paidToday,
      };
    },
    async listAllJobs({ status, cursor, limit = 20 }) {
      const lim = Math.min(limit, 50);
      const params = [];
      let where = '';
      if (status) { params.push(status); where += `status=$${params.length}`; }
      if (cursor) { params.push(cursor); where += (where ? ' AND ' : '') + `created_at < $${params.length}`; }
      params.push(lim + 1);
      const { rows } = await pool.query(
        `SELECT * FROM jobs ${where ? 'WHERE ' + where : ''} ORDER BY created_at DESC LIMIT $${params.length}`,
        params
      );
      const hasMore = rows.length > lim;
      const page = rows.slice(0, lim).map(mapJob);
      return { items: page, nextCursor: hasMore ? page[page.length - 1].createdAt : null };
    },
    async listUsers({ q, limit = 50 }) {
      const needle = `%${q || ''}%`;
      const { rows } = await pool.query(
        `SELECT id, name, email, city, plan, COALESCE(role,'user') AS role, created_at AS "createdAt"
         FROM users WHERE $1='' OR email ILIKE $1 OR name ILIKE $1
         ORDER BY created_at DESC LIMIT $2`,
        [q ? needle : '', Math.min(limit, 5000)]
      );
      return rows;
    },
    async recentLedger(limit = 50) {
      const { rows } = await pool.query(
        `SELECT l.id, l.job_id AS "jobId", l.type, l.amount, l.actor, l.created_at AS "at", j.title AS "jobTitle"
         FROM ledger l LEFT JOIN jobs j ON j.id = l.job_id
         ORDER BY l.created_at DESC LIMIT $1`,
        [Math.min(limit, 5000)]
      );
      return rows;
    },

    // ---- reports (safety / contact inbox for owners) ----
    async createReport({ type, subject, message, contact, jobId }) {
      const { rows } = await pool.query(
        `INSERT INTO reports (id, type, subject, message, contact, job_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, type, subject, message, contact, job_id AS "jobId", created_at AS "at"`,
        [newId('r'), type, subject, message, contact || '', jobId || null]
      );
      return rows[0];
    },
    async listReports({ type, limit = 50 }) {
      const params = [];
      let where = '';
      if (type) { params.push(type); where = `WHERE type=$${params.length}`; }
      params.push(Math.min(limit, 200));
      const { rows } = await pool.query(
        `SELECT id, type, subject, message, contact, job_id AS "jobId", created_at AS "at"
         FROM reports ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
        params
      );
      return rows;
    },

    // ---- payouts (locked debit: concurrent claims can't double-pay) ----
    async sumReleasedByDoer(doerId) {
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(amount),0)::float AS s FROM ledger WHERE type='release' AND actor=$1`, [doerId]
      );
      return rows[0].s;
    },
    async sumPayoutsByDoer(doerId) {
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(amount),0)::float AS s FROM payouts WHERE doer_id=$1 AND status IN ('processing','transferred','queued')`,
        [doerId]
      );
      return rows[0].s;
    },
    async createPayout({ doerId, amount }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT * FROM doer_profiles WHERE user_id=$1 FOR UPDATE`, [doerId]);
        const rel = await client.query(`SELECT COALESCE(SUM(amount),0)::float AS s FROM ledger WHERE type='release' AND actor=$1`, [doerId]);
        const used = await client.query(`SELECT COALESCE(SUM(amount),0)::float AS s FROM payouts WHERE doer_id=$1 AND status IN ('processing','transferred','queued')`, [doerId]);
        if (Math.round((rel.rows[0].s - used.rows[0].s) * 100) / 100 < amount - 1e-9) {
          const e = new Error('insufficient available balance');
          e.status = 409; e.code = 'insufficient';
          throw e;
        }
        const { rows } = await client.query(
          `INSERT INTO payouts (id, doer_id, amount, status) VALUES ($1,$2,$3,'processing')
           RETURNING id, doer_id AS "doerId", amount, status, transfer_id AS "transferId", created_at AS "at"`,
          [newId('p'), doerId, amount]
        );
        await client.query('COMMIT');
        return rows[0];
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    async setPayoutStatus(id, status, transferId) {
      const { rows } = await pool.query(
        `UPDATE payouts SET status=$2, transfer_id=COALESCE($3, transfer_id), updated_at=NOW() WHERE id=$1
         RETURNING id, doer_id AS "doerId", amount, status, transfer_id AS "transferId", created_at AS "at"`,
        [id, status, transferId || null]
      );
      if (!rows[0]) { const e = new Error('payout not found'); e.status = 404; e.code = 'not_found'; throw e; }
      return rows[0];
    },
    async listPayoutsByDoer(doerId) {
      const { rows } = await pool.query(
        `SELECT id, doer_id AS "doerId", amount, status, transfer_id AS "transferId", created_at AS "at"
         FROM payouts WHERE doer_id=$1 ORDER BY created_at DESC`, [doerId]
      );
      return rows;
    },
    async listAllPayouts(limit = 50) {
      const { rows } = await pool.query(
        `SELECT id, doer_id AS "doerId", amount, status, transfer_id AS "transferId", created_at AS "at"
         FROM payouts ORDER BY created_at DESC LIMIT $1`, [Math.min(limit, 200)]
      );
      return rows;
    },
    async payoutCandidates(min) {
      const { rows } = await pool.query(
        `SELECT d.user_id AS "userId", d.display_name AS "displayName",
          COALESCE((SELECT SUM(amount)::float FROM ledger WHERE type='release' AND actor=d.user_id),0) AS released,
          COALESCE((SELECT SUM(amount)::float FROM payouts WHERE doer_id=d.user_id AND status IN ('processing','transferred','queued')),0) AS used
         FROM doer_profiles d WHERE d.status='verified'`
      );
      return rows
        .map(r => ({ ...r, available: Math.round((r.released - r.used) * 100) / 100 }))
        .filter(r => r.available >= min);
    },
  };
}

// Synchronous require hidden behind a function so the module graph loads
// fine when `pg` is not installed (json store path).
function awaitImportPg() {
  return (awaitImportPg._cache ??= initPg());
  function initPg() {
    // eslint-disable-next-line global-require
    return require('pg');
  }
}

function mapUser(r) {
  return { id: r.id, name: r.name, email: r.email, city: r.city, plan: r.plan, role: r.role || 'user', createdAt: r.createdAt || r.created_at };
}
function mapUserFull(r) {
  return { id: r.id, name: r.name, email: r.email, passHash: r.pass_hash, city: r.city, plan: r.plan, role: r.role || 'user', createdAt: r.created_at };
}
function mapDoer(r) {
  return { userId: r.user_id, displayName: r.display_name, city: r.city, status: r.status, stripeAccountId: r.stripe_account_id || null, updatedAt: r.updated_at };
}
function mapJob(r) {
  return {
    id: r.id, askerId: r.asker_id, title: r.title, category: r.category, label: r.label,
    city: r.city, rush: r.rush, total: Number(r.total), fee: Number(r.fee), doerShare: Number(r.doer_share),
    clientId: r.client_id, status: r.status, doerId: r.doer_id, videoUrl: r.video_url,
    description: r.description || '', deadline: r.deadline || 'asap', videoLength: r.video_length || '1:30',
    moderation: r.moderation || { score: 0, flags: [] },
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
  };
}

// Minimal CJS bridge for optional `pg` inside an ESM file.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
