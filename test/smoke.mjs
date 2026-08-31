/**
 * Smoke test — the real Lobby API, over the network.
 *
 * Complements test/contract.mjs (offline, exhaustive) by proving the shapes
 * this script assumes are the shapes the live backend actually sends. A field
 * rename on the backend passes every contract test and fails here, which is
 * the point.
 *
 * Run: node test/smoke.mjs [slug]
 *      node test/smoke.mjs arenna --ask     also spends one conversation
 *      node test/smoke.mjs --product        product surface only, no concierge
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const slug = args.find((a) => !a.startsWith('--')) || 'arenna';
const askToo = flags.includes('--ask');
const productOnly = flags.includes('--product');
const surface = productOnly ? 'product' : 'both';

const registered = [];
const host = { registerTool: (t) => registered.push(t) };

// Node's global `navigator` is getter-only, so override via defineProperty.
// Registering on `document` exercises the branch current drafts specify.
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
globalThis.document = { modelContext: host, currentScript: null, querySelector: () => null };
globalThis.window = globalThis;
globalThis.location = { pathname: '/', assign() {} };
globalThis.dispatchEvent = () => {};
globalThis.CustomEvent = class { constructor(n, o) { this.detail = o?.detail; } };

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/lobby-webmcp.js'),
  'utf8',
);
new Function(src)();

const api = await globalThis.LobbyWebMCP.init(
  productOnly ? { surface } : { slug, surface },
);

console.log('surface:', api.surface);
console.log('capabilities:', JSON.stringify(api.capabilities));
console.log('registered:', registered.map((t) => t.name).join(', '));

const byName = Object.fromEntries(registered.map((t) => [t.name, t]));
const data = (r) => JSON.parse(r.content[0].text);
let failed = 0;

async function probe(name, args = {}, expect = () => true) {
  if (!byName[name]) {
    console.log(`\n${name} → not registered on this surface (skipped)`);
    return;
  }
  const out = data(await byName[name].execute(args));
  const line = JSON.stringify(out).slice(0, 500);
  if (out.ok !== true) {
    console.error(`\n✗ ${name} → ${line}`);
    failed++;
    return;
  }
  try {
    expect(out);
    console.log(`\n✓ ${name} → ${line}`);
  } catch (e) {
    console.error(`\n✗ ${name} shape → ${e.message}\n  ${line}`);
    failed++;
  }
}

// ── Product surface: proves /webmcp/product.json is live and well-shaped ────
await probe('get_pricing', {}, (o) => {
  if (!Array.isArray(o.plans) || o.plans.length < 2) throw new Error('expected 2 plans');
  const ids = o.plans.map((p) => p.id).sort();
  if (ids.join(',') !== 'free,paid') throw new Error(`plan ids: ${ids}`);
  for (const p of o.plans) {
    if (typeof p.monthly_conversations !== 'number') {
      throw new Error(`${p.id} has no numeric allowance`);
    }
  }
});
await probe('recommend_plan', { expected_monthly_conversations: 500 }, (o) => {
  if (o.recommended_plan_id !== 'paid') throw new Error('500/mo should recommend paid');
});
await probe('get_setup_instructions', {}, (o) => {
  if (!o.options.some((x) => x.id === 'embed')) throw new Error('no embed option');
});
await probe('list_customer_examples', { limit: 3 }, (o) => {
  if (!o.examples.length) throw new Error('no live concierges found');
});
await probe('open_signup', {}, (o) => {
  if (o.navigated !== false) throw new Error('navigated without being asked');
});

// ── Concierge surface: proves the public profile shape ──────────────────────
await probe('get_business_info', {}, (o) => {
  if (!o.name) throw new Error('no business name');
  if (typeof o.booking_available !== 'boolean') throw new Error('booking_available missing');
});
await probe('list_offerings', {}, (o) => {
  for (const x of o.offerings) {
    if (typeof x.bookable !== 'boolean') throw new Error(`${x.name} has no bookable flag`);
  }
});

// ── Booking, only where the concierge actually has it ──────────────────────
if (byName.get_booking_options) {
  await probe('get_booking_options', {}, (o) => {
    if (!o.booking_types.length) throw new Error('booking enabled but nothing bookable');
  });
  const opts = data(await byName.get_booking_options.execute({}));
  if (opts.ok) {
    const today = new Date().toISOString().slice(0, 10);
    await probe('check_availability', {
      booking_type_id: opts.booking_types[0].id, from_date: today,
    }, (o) => {
      if (!Array.isArray(o.slots)) throw new Error('slots is not an array');
    });
  }
  // The confirmation gate, against the live backend: this must NOT book.
  const gate = data(await byName.start_booking.execute({
    booking_type_id: 'smoke-test', start_utc: '2099-01-01T00:00:00.000Z',
    guest_name: 'Smoke Test', guest_email: 'smoke@example.test',
  }));
  if (gate.error?.code !== 'confirmation_required') {
    console.error('\n✗ start_booking gate → unconfirmed call was not refused');
    failed++;
  } else {
    console.log('\n✓ start_booking gate → refused unconfirmed, nothing booked');
  }
} else {
  console.log('\n(booking tools not registered — this concierge has none configured)');
}

if (askToo) {
  await probe('ask_concierge', {
    question: 'In one sentence, what does this business do?',
  }, (o) => { if (!o.answer) throw new Error('empty answer'); });
} else {
  console.log('\n(ask_concierge skipped — pass --ask to spend a conversation)');
}

console.log(failed ? `\nSMOKE FAILED (${failed})` : '\nSMOKE OK');
process.exit(failed ? 1 : 0);
