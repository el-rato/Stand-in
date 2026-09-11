// Grant or revoke owner access: npm run make-admin -- you@email.com [admin|user]
// The user must have registered first (or be in the seed data).
import { createStore } from '../src/store/index.js';

const [email, role = 'admin'] = process.argv.slice(2);
if (!email) {
  console.error('usage: npm run make-admin -- you@email.com [admin|user]');
  process.exit(1);
}

const store = await createStore();
const user = await store.findUserByEmail(email.toLowerCase());
if (!user) {
  console.error(`no such user: ${email} — they must register first`);
  process.exit(1);
}
await store.setRole(user.id, role);
console.log(`[make-admin] ${email} → ${role} (store=${store.kind})`);
