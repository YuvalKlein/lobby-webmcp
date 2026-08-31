/**
 * End-to-end: lobby-web's REAL /webmcp/product.json output, fed to the REAL
 * tools. Proves the two repos agree without needing a deployment.
 *
 * `test/fixtures-product.json` is a captured copy of what lobby-web's route
 * handler emits from `content/pricing.ts`. It is checked in on purpose: this
 * test's whole job is to fail when the manifest's shape drifts away from what
 * the tools read, and a fixture fetched live would silently follow the drift
 * instead of catching it.
 *
 * Refresh it when the manifest shape changes (not when a price changes):
 *   curl -s https://lobby.host/webmcp/product.json > test/fixtures-product.json
 *
 * Run: node test/manifest-e2e.mjs
 */
import { readFileSync } from 'node:fs';
const SRC = readFileSync('src/lobby-webmcp.js', 'utf8');
const MANIFEST = JSON.parse(readFileSync('test/fixtures-product.json', 'utf8'));

const registered = [];
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
globalThis.document = { modelContext: { registerTool: (t) => registered.push(t) },
                        currentScript: null, querySelector: () => null };
globalThis.window = globalThis;
globalThis.location = { pathname: '/pricing', assign() {} };
globalThis.dispatchEvent = () => {};
globalThis.CustomEvent = class { constructor(n, o) { this.detail = o?.detail; } };
globalThis.fetch = async (u) => {
  if (String(u).includes('/webmcp/product.json')) {
    return { ok: true, status: 200, json: async () => MANIFEST };
  }
  if (String(u).includes('/lobby/public/agents')) {
    return { ok: true, status: 200,
             json: async () => ({ data: [{ slug: 'arenna' }], total: 1 }) };
  }
  throw new Error('unexpected: ' + u);
};

new Function(SRC)();
await globalThis.LobbyWebMCP.init({ surface: 'product' });
const t = Object.fromEntries(registered.map((x) => [x.name, x]));
const d = (r) => JSON.parse(r.content[0].text);
let bad = 0;
const say = (okFlag, label, detail) => {
  console.log(`${okFlag ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!okFlag) bad++;
};

const pricing = d(await t.get_pricing.execute({}));
say(pricing.ok && pricing.plans.length === 2, 'get_pricing',
    `${pricing.plans?.map((p) => `${p.id} $${p.price_monthly}/${p.monthly_conversations}`).join(', ')}`);

// The journey question webmcp.com actually asked, with real numbers.
const r1 = d(await t.recommend_plan.execute({ expected_monthly_conversations: 15 }));
say(r1.recommended_plan_id === 'free', 'recommend_plan (15/mo → free)', r1.reasons[0]);

const r2 = d(await t.recommend_plan.execute({ expected_monthly_conversations: 150, needs_booking: true }));
say(r2.recommended_plan_id === 'paid', 'recommend_plan (booking wanted → paid)', r2.reasons.join(' | '));

const r3 = d(await t.recommend_plan.execute({ expected_monthly_conversations: 900 }));
say(r3.recommended_plan_id === 'paid' && r3.caveats.length > 0,
    'recommend_plan (900/mo → paid + caveat)', r3.caveats[0]);

const setup = d(await t.get_setup_instructions.execute({ has_existing_website: true }));
say(setup.ok && setup.options.length === 1 && setup.options[0].id === 'embed',
    'get_setup_instructions (has site → embed only)', setup.options[0]?.steps?.length + ' steps');

const ex = d(await t.list_customer_examples.execute({}));
say(ex.ok && ex.examples.length === 1, 'list_customer_examples', ex.examples?.[0]?.url);

console.log(bad ? `\nE2E FAILED (${bad})` : '\nE2E OK — lobby-web’s manifest and lobby-webmcp’s tools agree');
process.exit(bad ? 1 : 0);
