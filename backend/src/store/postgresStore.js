// Postgres store — same interface as jsonStore.js.
// Activated when DATABASE_URL is set (requires `npm i pg`).
// Run migrations/001_init.sql first. All state changes use transactions
// with SELECT ... FOR UPDATE so concurrent claim/approve calls are safe
// across any number of API replicas.

import { createRequire } from 'node:module';
import { newId } from '../lib/util.js';

const require = createRequire(import.meta.url);

export function createPostgresStore(databaseUrl) {
  let Pool;
  try {
    ({ Pool } = require('pg'));
  } catch {
    throw new Error('postgres store needs the "pg" package: run `npm i pg`');
  }
  const pool = new Pool({ connectionString: databaseUrl });

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

    async getDoer(userId) {
      const { rows } = await pool.query(`SELECT * FROM doer_profiles WHERE user_id=$1`, [userId]);
      return rows[0] ? mapDoer(rows[0]) : null;
    },
    async upsertDoer(userId, patch) {
      const { rows } = await pool.query(
        `INSERT INTO doer_profiles (user_id, display_name, city, status)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id) DO UPDATE SET display_name=COALESCE($2, doer_profiles.display_name), city=COALESCE($3, doer_profiles.city), status=COALESCE($4, doer_profiles.status), updated_at=NOW()
         RETURNING *`,
        [userId, patch.displayName || null, patch.city || null, patch.status || null]
      );
      return mapDoer(rows[0]);
    },

    async createJob({ askerId, title, category, label, city, rush, total, fee, doerShare, clientId }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (clientId) {
          const dup = await client.query(`SELECT * FROM jobs WHERE asker_id=$1 AND client_id=$2`, [askerId, clientId]);
          if (dup.rows[0]) { await client.query('ROLLBACK'); return { ...mapJob(dup.rows[0]), duplicate: true }; }
        }
        const id = newId('j');
        const { rows } = await client.query(
          `INSERT INTO jobs (id, asker_id, title, category, label, city, rush, total, fee, doer_share, client_id, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'open') RETURNING *`,
          [id, askerId, title, category, label, city, !!rush, total, fee, doerShare, clientId || null]
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
        mutate(draft);
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
  };
}

function mapUser(r) {
  return { id: r.id, name: r.name, email: r.email, city: r.city, plan: r.plan, createdAt: r.createdAt || r.created_at };
}
function mapUserFull(r) {
  return { id: r.id, name: r.name, email: r.email, passHash: r.pass_hash, city: r.city, plan: r.plan, createdAt: r.created_at };
}
function mapDoer(r) {
  return { userId: r.user_id, displayName: r.display_name, city: r.city, status: r.status, updatedAt: r.updated_at };
}
function mapJob(r) {
  return {
    id: r.id, askerId: r.asker_id, title: r.title, category: r.category, label: r.label,
    city: r.city, rush: r.rush, total: Number(r.total), fee: Number(r.fee), doerShare: Number(r.doer_share),
    clientId: r.client_id, status: r.status, doerId: r.doer_id, videoUrl: r.video_url,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
  };
}
