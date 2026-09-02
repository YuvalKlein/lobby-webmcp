/**
 * End-to-end: the REAL other side, fed to the REAL tools.
 *
 * Two upstreams, both captured rather than authored:
 *
 *  1. **lobby-web's `/webmcp/product.json`** (`fixtures-product.json`) → the
 *     product-surface tools.
 *  2. **unitism-backend's booking contract** (`fixtures-openapi-booking.json`,
 *     a slice of the spec the backend generates from its own DTOs) plus a real
 *     public profile (`fixtures-profile-hello.json`) → the concierge-surface
 *     booking tools.
 *
 * ## Why (2) exists, and why it is built from the SPEC
 *
 * On 1 Sep 2026 the booking endpoints and these tools disagreed on two fields at
 * once, in production, with every test in both repos green:
 *
 *  - the availability response had no top-level `timezone`, and
 *    `check_availability` requires it and falls back to `'UTC'` — so an agent was
 *    told an `Asia/Jerusalem` business runs on UTC
 *  - each slot carried `display`, while the published schema says `start_local`
 *    — so an agent read `undefined` off every slot
 *
 * Nothing threw. Nothing could: this is the one contract in the product with no
 * shared type, no codegen and no compiler between the two sides.
 *
 * **The reason CI was green is the lesson.** `test/contract.mjs`'s `AVAILABILITY`
 * fixture was hand-written to match this file's own outputSchema, so the fixture
 * and the tools agreed with each other and neither had ever seen the endpoint. A
 * fixture standing in for another service tests your belief about that service.
 *
 * So the booking payloads here are **synthesised from the backend's OpenAPI
 * schema** — the field names come from the backend's DTOs, not from a hand. A
 * rename on that side changes the fixture on refresh and fails these checks by
 * name. Every tool result is then validated against the tool's own declared
 * `outputSchema`, which is the check that catches a field the tools claim to
 * return and do not.
 *
 * Refresh the fixtures when a SHAPE changes (not when a price or a slug does):
 *   curl -s https://lobby.host/webmcp/product.json > test/fixtures-product.json
 *   curl -s $API/lobby/agents/hello/public > test/fixtures-profile-hello.json
 *   node test/extract-booking-schema.mjs   # from unitism-backend's openapi.json
 *
 * Run: node test/manifest-e2e.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f) => JSON.parse(readFileSync(join(HERE, f), 'utf8'));
const SRC = readFileSync(join(HERE, '../src/lobby-webmcp.js'), 'utf8');

const MANIFEST = read('fixtures-product.json');
const PROFILE = read('fixtures-profile-hello.json');

// The booking bodies are built from the BACKEND's own schema, not typed out
// here. See backend-shapes.mjs for why that distinction is the whole point.
const {
  BOOKING_SPEC,
  OPTIONS_BODY,
  AVAILABILITY_BODY,
  BOOKING_BODY,
  CANCELLED_BODY,
  declaredKeys,
  validateAgainstOutputSchema: validate,
} = await import('./backend-shapes.mjs');

let bad = 0;
const say = (okFlag, label, detail) => {
  console.log(`${okFlag ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!okFlag) bad++;
};

/**
 * Load a fresh copy of the script against a stubbed host and a stubbed backend.
 *
 * `routes` maps a URL substring to a JSON body. An unexpected URL throws rather
 * than answering `{}`, so a tool that starts calling something new fails here
 * instead of silently receiving an empty object.
 */
function load({ pathname = '/', routes = {} } = {}) {
  const registered = [];
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
  globalThis.document = { modelContext: { registerTool: (t) => registered.push(t) },
                          currentScript: null, querySelector: () => null };
  globalThis.window = globalThis;
  globalThis.location = { pathname, assign() {} };
  globalThis.dispatchEvent = () => {};
  globalThis.CustomEvent = class { constructor(n, o) { this.detail = o?.detail; } };
  globalThis.fetch = async (u) => {
    const url = String(u);
    for (const [match, body] of Object.entries(routes)) {
      if (url.includes(match)) {
        return { ok: true, status: 200, json: async () => body };
      }
    }
    throw new Error('unexpected fetch: ' + url);
  };
  new Function(SRC)();
  return { api: globalThis.LobbyWebMCP, registered };
}

const byName = (registered) =>
  Object.fromEntries(registered.map((t) => [t.name, t]));
const d = (r) => JSON.parse(r.content[0].text);

// ── Upstream 1: lobby-web's product manifest ────────────────────────────────

{
  const { api, registered } = load({
    pathname: '/pricing',
    routes: {
      '/webmcp/product.json': MANIFEST,
      '/lobby/public/agents': { data: [{ slug: 'arenna' }], total: 1 },
    },
  });
  await api.init({ surface: 'product' });
  const t = byName(registered);

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
}

// ── Upstream 2: the backend's booking contract ──────────────────────────────

{
  const { api, registered } = load({
    pathname: '/c/hello',
    routes: {
      '/booking/options': OPTIONS_BODY,
      '/booking/availability': AVAILABILITY_BODY,
      '/booking/bookings': BOOKING_BODY,
      // `/lobby/bookings/<token>/cancel` — no slug in the path, so it shares no
      // substring with the three above.
      '/cancel': CANCELLED_BODY,
      // Least specific last: `/public` also matches the paths above on some
      // backends, so ordering here is load-bearing.
      '/public': PROFILE,
    },
  });
  await api.init({ slug: 'hello' });
  const t = byName(registered);

  say(!!t.check_availability && !!t.get_booking_options && !!t.start_booking
        && !!t.cancel_booking,
      'a live profile with booking.enabled registers the booking tools',
      Object.keys(t).length + ' tools');

  const options = d(await t.get_booking_options.execute({}));
  const optionProblems = validate(t.get_booking_options, options);
  say(options.ok && !optionProblems.length, 'get_booking_options matches its own schema',
      optionProblems.join('; ') || `timezone ${options.timezone}`);

  const avail = d(await t.check_availability.execute({
    booking_type_id: options.booking_types[0].id,
    from_date: '2026-09-08',
    visitor_timezone: 'America/New_York',
  }));
  const availProblems = validate(t.check_availability, avail);
  say(avail.ok && !availProblems.length, 'check_availability matches its own schema',
      availProblems.join('; ') || `${avail.total} slots`);

  // The two fields that were actually wrong in production, named individually so
  // a regression says WHICH one moved rather than "schema mismatch".
  say(avail.timezone === 'Asia/Jerusalem',
      'the business timezone survives the backend → tool hop',
      avail.timezone === 'UTC'
        ? 'got UTC — the response has no `timezone` and the tool defaulted it'
        : `timezone ${avail.timezone}`);

  const slotKeys = Object.keys(avail.slots[0] ?? {});
  say(slotKeys.includes('start_local'),
      'every slot carries `start_local`, the name the schema publishes',
      slotKeys.join(', ') || 'no slots');

  say(avail.slots.every((s) => typeof s.start_utc === 'string' && s.start_utc.endsWith('Z')),
      'slots are absolute UTC instants — the value passed back to book');

  // A field the backend declares that no tool reads is not a failure, but it is
  // worth seeing: it is usually a capability nobody wired up.
  const declaredSlotKeys = declaredKeys('LobbyBookingSlotDto');
  const unread = declaredSlotKeys.filter((k) => !slotKeys.includes(k));
  say(true, 'backend slot fields', `${declaredSlotKeys.join(', ')}${unread.length ? ` (unread: ${unread.join(', ')})` : ''}`);

  // The committing action, against a spec-shaped booking response.
  const gate = d(await t.start_booking.execute({
    booking_type_id: options.booking_types[0].id,
    start_utc: avail.slots[0].start_utc,
    guest_name: 'E2E Test',
    guest_email: 'e2e@example.test',
  }));
  say(gate.error?.code === 'confirmation_required',
      'start_booking refuses to commit unconfirmed', gate.error?.code);

  const booked = d(await t.start_booking.execute({
    booking_type_id: options.booking_types[0].id,
    start_utc: avail.slots[0].start_utc,
    guest_name: 'E2E Test',
    guest_email: 'e2e@example.test',
    confirmed: true,
  }));
  const bookedProblems = validate(t.start_booking, booked);
  say(booked.ok && !bookedProblems.length, 'start_booking matches its own schema',
      bookedProblems.join('; ') || `status ${booked.status}, id ${booked.booking_id}`);

  // The summary is read back to a PERSON, so every field in it has to be a fact
  // the backend actually sent. `what` fell back to `String(booking_type_id)` and
  // showed a visitor a UUID, because `booking_type_name` was read off a response
  // that never carried it — the same defect class as `display`/`start_local`, in
  // the create response instead of the availability one, found by this file.
  const summaryFromArgs = [];
  if (booked.summary?.what === options.booking_types[0].id) {
    summaryFromArgs.push('what fell back to the booking_type_id — a visitor is shown an id');
  }
  if (booked.summary?.duration_minutes === undefined) summaryFromArgs.push('duration_minutes is absent');
  say(!summaryFromArgs.length,
      'the summary read back to the visitor is built from the backend’s answer',
      summaryFromArgs.join('; ') || `“${booked.summary.what}”, ${booked.summary.duration_minutes} min`);

  say(booked.summary?.when_utc === avail.slots[0].start_utc,
      'the booked instant is the backend’s, not an echo of the argument',
      booked.summary?.when_utc);

  // Null is the CORRECT answer here, not a gap — the backend's create response
  // carries the `cancel_token`, and the tool deliberately does not pass it on:
  // it is the visitor's only credential for their appointment, and their cancel
  // link reaches them by email. A populated value means somebody handed a
  // visiting agent standing power over a stranger's booking, so this asserts.
  say(booked.cancel_url === null,
      'cancel_url is withheld — the cancel token is the visitor’s credential',
      booked.cancel_url === null
        ? 'null — the visitor’s cancel link goes to them by email'
        : `LEAKED: ${booked.cancel_url}`);

  // ── Cancellation, the other half of the booking capability ────────────────
  //
  // The token here is the one the backend just sent in the create response.
  // That is the ONLY place it legitimately comes from in this test, and in
  // production it reaches the agent one step further round: through the
  // visitor's email, and then out of the visitor's own mouth.
  const token = BOOKING_BODY.cancel_token;
  say(typeof token === 'string' && token.length >= 32,
      'the backend’s create response carries a usable cancel_token',
      `${typeof token} of length ${String(token).length}`);

  const gateOff = d(await t.cancel_booking.execute({ cancel_token: token }));
  say(gateOff.error?.code === 'confirmation_required',
      'cancel_booking refuses to cancel unconfirmed', gateOff.error?.code);
  say(gateOff.summary?.when_utc === null,
      'the unconfirmed summary invents no appointment time',
      gateOff.summary?.when_utc === null
        ? 'null — nothing previews a booking by token'
        : `INVENTED: ${gateOff.summary?.when_utc}`);

  const cancelled = d(await t.cancel_booking.execute({
    cancel_token: token, confirmed: true,
  }));
  const cancelProblems = validate(t.cancel_booking, cancelled);
  say(cancelled.ok && !cancelProblems.length, 'cancel_booking matches its own schema',
      cancelProblems.join('; ') || `status ${cancelled.status}`);

  // The same echo-the-argument defect that hid in `summary.what` and
  // `start_local`: the fixture says `cancelled` where the shared value hint
  // would have said `confirmed`, so a hardcoded constant here shows up.
  say(cancelled.status === CANCELLED_BODY.status,
      'the cancelled status is the backend’s word, not a constant',
      `${cancelled.status} (backend sent ${CANCELLED_BODY.status})`);
  say(cancelled.summary?.when_utc === CANCELLED_BODY.starts_at,
      'the cancelled instant is the backend’s, not an echo',
      cancelled.summary?.when_utc);

  // The whole security model in one line. A booking id is in scope for an
  // agent — it is in `booked.booking_id` right here — so this is the mistake
  // that is actually available to make.
  const byId = d(await t.cancel_booking.execute({
    cancel_token: booked.booking_id, confirmed: true,
  }));
  say(byId.ok === false && byId.error?.code === 'invalid_input',
      'a booking id cannot cancel a booking',
      byId.ok ? 'ACCEPTED — cancellable by enumeration' : byId.error?.code);

  // The token must not survive the call in anything the caller keeps.
  const anyEcho = [gateOff, cancelled].some((r) => JSON.stringify(r).includes(token));
  say(!anyEcho, 'no cancel_booking result repeats the token back',
      anyEcho ? 'ECHOED — the credential outlives the call' : 'withheld');

  const cancelKeys = declaredKeys('LobbyBookingCancelledDto');
  say(true, 'backend cancellation fields', cancelKeys.join(', '));
}

console.log(bad
  ? `\nE2E FAILED (${bad})`
  : '\nE2E OK — the product manifest, the booking contract and the tools all agree');
process.exit(bad ? 1 : 0);
