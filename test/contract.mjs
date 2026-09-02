/**
 * Contract tests — offline, no network, no spent conversations.
 *
 * These assert the things the webmcp.com scorecard actually grades, so a
 * regression is caught here rather than by a rescan a week later:
 *
 *   Quality (20%)    every tool has a precise name, description, input schema
 *                    AND a declared output schema; names are stable snake_case.
 *                    The description must also SPELL OUT the return shape:
 *                    webmcp.com drops outputSchema on capture and then scores
 *                    its absence, so prose is the only channel that survives.
 *   Usability (60%)  each of the four evaluation journeys completes through
 *                    typed tools, without falling back to ask_concierge; the
 *                    committing action refuses to commit unconfirmed.
 *   Coverage (20%)   each route registers the tool set that route needs.
 *
 * And the rule that caused the original deduction: a capability the business
 * has not configured must produce NO tool. A concierge without booking must be
 * structurally unable to offer one.
 *
 * Run: node test/contract.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/lobby-webmcp.js'),
  'utf8',
);

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const r = fn();
    if (r instanceof Promise) {
      return r.then(
        () => { passed++; },
        (e) => { failures.push(`${name}: ${e.message}`); },
      );
    }
    passed++;
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
  }
  return Promise.resolve();
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const PROFILE_NO_BOOKING = {
  slug: 'plainco',
  name: 'Plain Co',
  intro_message: 'Hello from Plain Co.',
  services: [
    { title: 'Consultation', description: 'A first conversation.' },
    { title: 'Retainer', description: 'Ongoing work.' },
  ],
  suggested_intents: ['What do you do?', 'What does it cost?'],
  contact: { email: 'hi@plainco.test' },
  plan_tier: 'free',
};

const PROFILE_WITH_BOOKING = {
  ...PROFILE_NO_BOOKING,
  slug: 'bookco',
  name: 'Book Co',
  plan_tier: 'paid',
  booking: { enabled: true },
  services: [
    { title: 'Intro call', description: '15 minutes.', bookable: true },
    { title: 'Retainer', description: 'Ongoing work.' },
  ],
};

const PRODUCT = {
  currency: 'USD',
  conversation_definition: 'One visitor session, however many messages.',
  overage: 'A pack of 100 extra conversations is $15.',
  plans: [
    {
      id: 'free', name: 'Free', price_monthly: 0, price_annual: 0,
      monthly_conversations: 20, shows_lobby_badge: true,
      includes_booking: false, features: ['20 conversations a month'],
      signup_url: 'https://lobby.host/signup',
    },
    {
      id: 'paid', name: 'Lobby', price_monthly: 39, price_annual: 390,
      monthly_conversations: 200, shows_lobby_badge: false,
      includes_booking: true, features: ['200 conversations a month'],
      signup_url: 'https://lobby.host/signup?plan=paid',
    },
  ],
  setup_options: [
    { id: 'embed', name: 'Embed on your site', when_to_use: 'You have a website.',
      steps: ['Copy the snippet', 'Paste before </body>'], snippet: '<script src="..."></script>' },
    { id: 'hosted', name: 'Hosted concierge page', when_to_use: 'No website yet.',
      steps: ['Pick your address', 'Share the link'], snippet: null },
  ],
};

/**
 * The booking endpoints' responses — from the BACKEND's schema, not from here.
 *
 * These three used to be consts typed out in this file, and the availability one
 * was written to match `check_availability`'s own outputSchema. The real endpoint
 * sent no top-level `timezone` and called each slot's display string `display`
 * rather than `start_local`, so an agent was told an `Asia/Jerusalem` business
 * runs on UTC and read `undefined` off every slot — in production, with all 28
 * of these tests green. The fixture and the tools agreed because one
 * understanding wrote both.
 *
 * `backend-shapes.mjs` builds them from a captured slice of the backend's own
 * OpenAPI spec instead. Values are still invented; every KEY is the backend's.
 */
const { OPTIONS_BODY, AVAILABILITY_BODY, BOOKING_BODY, CANCELLED_BODY } =
  await import('./backend-shapes.mjs');
const BOOKING_OPTIONS = OPTIONS_BODY;
const AVAILABILITY = AVAILABILITY_BODY;

// ── Harness ─────────────────────────────────────────────────────────────────

/**
 * Load a fresh copy of the script against a stubbed WebMCP host and a stubbed
 * backend. Each call gets its own module closure, so state never leaks between
 * scenarios.
 */
function load({ pathname = '/', profile = null, posts = {}, hostKind = 'document' } = {}) {
  const registered = [];
  const calls = [];
  const host = { registerTool: (t) => registered.push(t) };

  Object.defineProperty(globalThis, 'navigator', {
    value: hostKind === 'navigator' ? { modelContext: host } : {},
    configurable: true,
  });
  globalThis.document = hostKind === 'document'
    ? { modelContext: host, currentScript: null, querySelector: () => null }
    : { currentScript: null, querySelector: () => null };
  globalThis.window = globalThis;
  globalThis.location = { pathname, assign() {} };
  globalThis.dispatchEvent = () => {};
  globalThis.CustomEvent = class { constructor(n, o) { this.name = n; this.detail = o?.detail; } };

  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method || 'GET' });
    const u = String(url);
    const json = (body, status = 200) => ({
      ok: status < 400, status, json: async () => body,
    });
    if (u.includes('/webmcp/product.json')) return json(PRODUCT);
    if (u.includes('/lobby/public/agents')) {
      return json({ data: [{ slug: 'arenna', updated_at: '2026-08-01' },
                            { slug: 'groundwork', updated_at: '2026-08-02' }],
                    total: 2, truncated: false });
    }
    // Before the others: the cancel path is `/lobby/bookings/<token>/cancel`,
    // which shares no substring with `/booking/<thing>`, so it would otherwise
    // fall through to the `unexpected fetch` throw.
    if (u.includes('/cancel')) {
      if (posts.cancelStatus && posts.cancelStatus >= 400) {
        return json({}, posts.cancelStatus);
      }
      return json(CANCELLED_BODY);
    }
    if (u.includes('/booking/options')) return json(BOOKING_OPTIONS);
    if (u.includes('/booking/availability')) return json(AVAILABILITY);
    if (u.includes('/booking/bookings')) {
      if (posts.bookingStatus && posts.bookingStatus >= 400) {
        return json({}, posts.bookingStatus);
      }
      // Spec-derived too. The hand-written version invented `cancel_url` — a
      // field the backend has never sent (it returns a `cancel_token`), so the
      // tool's `cancel_url` reads null on every real response and this fixture
      // was the only place it ever looked populated.
      //
      // It still reads null, but for a different reason since 2026-09-01: a
      // guest cancellation page now exists and the token to build the URL is in
      // the create response, and the tool declines to pass it on — that token is
      // the visitor's only credential for their appointment. See the note at
      // the `cancel_url` mapping.
      return json(BOOKING_BODY);
    }
    if (u.includes('/public')) {
      if (!profile) return json({}, 404);
      return json(profile);
    }
    throw new Error('unexpected fetch: ' + u);
  };

  new Function(SRC)();
  return { api: globalThis.LobbyWebMCP, registered, calls };
}

const byName = (registered) =>
  Object.fromEntries(registered.map((t) => [t.name, t]));

/** Unwrap the structured object from a tool result. */
const data = (result) => {
  assert(Array.isArray(result.content), 'result has no content array');
  assert(result.content[0]?.type === 'text', 'result content is not text');
  const parsed = JSON.parse(result.content[0].text);
  assert(result.structuredContent, 'result has no structuredContent');
  assert(
    JSON.stringify(result.structuredContent) === JSON.stringify(parsed),
    'structuredContent and content JSON disagree',
  );
  return parsed;
};

// ── Quality: schema hygiene on every tool, on every surface ─────────────────

const RESERVED = new Set(['ok', 'error']);

await check('every tool declares name, description, inputSchema, outputSchema', async () => {
  const { api, registered } = load({ pathname: '/', profile: PROFILE_WITH_BOOKING });
  await api.init({ slug: 'bookco', surface: 'both' });
  assert(registered.length >= 9, `expected 9+ tools across both surfaces, got ${registered.length}`);
  for (const t of registered) {
    assert(/^[a-z][a-z0-9_]*$/.test(t.name), `${t.name} is not stable snake_case`);
    assert(typeof t.description === 'string' && t.description.length > 200,
      `${t.name} has no substantive description`);
    // The scanner's capture format has no slot for outputSchema (keys are
    // name, kind, impl, description, inputSchema, executable, handlerField,
    // page), so it is discarded before grading and its absence is then scored
    // against us. The result shape has to be stated in the prose the grader
    // does read. Assert it is, and that it stays honest: every field the tool
    // actually returns must be named there.
    assert(/Returns \{/.test(t.description),
      `${t.name} does not state its return shape in its description`);
    for (const key of Object.keys(t.outputSchema.properties)) {
      if (key === 'error') continue; // the shared envelope, documented once
      assert(t.description.includes(key),
        `${t.name} returns ${key} but its description never names it`);
    }
    assert(t.inputSchema && t.inputSchema.type === 'object',
      `${t.name} has no object inputSchema`);
    assert(t.outputSchema && t.outputSchema.type === 'object',
      `${t.name} declares no outputSchema`);
    assert(Array.isArray(t.outputSchema.required) && t.outputSchema.required.includes('ok'),
      `${t.name} outputSchema does not require ok`);
    assert(t.outputSchema.properties.error, `${t.name} declares no error shape`);
    // Every declared input property must describe itself.
    for (const [k, v] of Object.entries(t.inputSchema.properties || {})) {
      assert(typeof v.description === 'string' && v.description.length > 10,
        `${t.name}.${k} has no useful description`);
      assert(!RESERVED.has(k), `${t.name}.${k} collides with the envelope`);
    }
    assert(typeof t.execute === 'function', `${t.name} has no execute`);
  }
});

await check('no duplicate tool names on a combined surface', async () => {
  const { api, registered } = load({ pathname: '/', profile: PROFILE_WITH_BOOKING });
  await api.init({ slug: 'bookco', surface: 'both' });
  const names = registered.map((t) => t.name);
  assert(new Set(names).size === names.length, `duplicates: ${names.join(', ')}`);
});

// ── The honesty rule: capability absent ⇒ tool absent ───────────────────────

await check('a concierge without booking registers NO booking tool', async () => {
  const { api, registered } = load({ pathname: '/c/plainco', profile: PROFILE_NO_BOOKING });
  await api.init({ slug: 'plainco' });
  const names = registered.map((t) => t.name);
  for (const forbidden of ['get_booking_options', 'check_availability', 'start_booking',
                           'cancel_booking']) {
    assert(!names.includes(forbidden),
      `${forbidden} registered on a concierge with no booking configured`);
  }
  assert(names.length === 3, `expected exactly the 3 core tools, got ${names.join(', ')}`);
});

await check('a concierge without booking reports booking_available false', async () => {
  const { api, registered } = load({ pathname: '/c/plainco', profile: PROFILE_NO_BOOKING });
  await api.init({ slug: 'plainco' });
  const info = data(await byName(registered).get_business_info.execute({}));
  assert(info.ok === true, 'lookup failed');
  assert(info.booking_available === false, 'claimed booking on a concierge without it');
});

await check('offerings are never bookable when the concierge cannot book', async () => {
  const { api, registered } = load({ pathname: '/c/plainco', profile: PROFILE_NO_BOOKING });
  await api.init({ slug: 'plainco' });
  const out = data(await byName(registered).list_offerings.execute({}));
  assert(out.booking_available === false, 'booking_available leaked true');
  for (const o of out.offerings) {
    assert(o.bookable === false, `${o.name} marked bookable with no booking capability`);
    assert(o.contact_required === true, `${o.name} should require contact`);
  }
});

await check('an unknown booking shape fails closed', () => {
  const { api } = load({ pathname: '/', profile: PROFILE_NO_BOOKING });
  const cap = api._internals.capabilitiesFrom;
  assert(cap({}).booking === false, 'missing booking key read as enabled');
  assert(cap({ booking: {} }).booking === false, 'empty booking object read as enabled');
  assert(cap({ booking: { enabled: 'yes' } }).booking === false, 'truthy string read as enabled');
  assert(cap({ booking: { enabled: true } }).booking === true, 'explicit true not honoured');
});

await check('a concierge WITH booking registers all four booking tools', async () => {
  const { api, registered } = load({ pathname: '/c/bookco', profile: PROFILE_WITH_BOOKING });
  await api.init({ slug: 'bookco' });
  const names = registered.map((t) => t.name);
  for (const wanted of ['get_booking_options', 'check_availability', 'start_booking',
                        'cancel_booking']) {
    assert(names.includes(wanted), `${wanted} missing on a booking-enabled concierge`);
  }
});

// ── Coverage: route → surface ───────────────────────────────────────────────

await check('routes map to the tool set that route needs', () => {
  const { api } = load({ pathname: '/', profile: PROFILE_NO_BOOKING });
  const s = api._internals.surfaceForPath;
  assert(s('/') === 'both', 'homepage should expose both sets');
  assert(s('/pricing') === 'product', '/pricing should be product');
  assert(s('/signup') === 'product', '/signup should be product');
  assert(s('/c/arenna') === 'concierge', '/c/<slug> should be concierge');
  assert(s('/c/arenna/') === 'concierge', 'trailing slash changed the surface');
  assert(s('/nope') === null, 'unknown route should defer to the caller');
});

await check('the product surface needs no slug', async () => {
  const { api, registered } = load({ pathname: '/pricing' });
  await api.init({ surface: 'product' });
  const names = registered.map((t) => t.name);
  for (const wanted of ['get_pricing', 'recommend_plan', 'get_setup_instructions',
                        'list_customer_examples', 'open_signup']) {
    assert(names.includes(wanted), `${wanted} missing on the product surface`);
  }
  assert(!names.includes('ask_concierge'), 'concierge tool leaked onto /pricing');
});

await check('the concierge surface refuses to initialise without a slug', () => {
  const { api } = load({ pathname: '/c/x' });
  let threw = false;
  try { api.init({ surface: 'concierge' }); } catch (_) { threw = true; }
  assert(threw, 'a slugless concierge surface should be a hard error');
});

// ── Host compatibility ──────────────────────────────────────────────────────

await check('registers against navigator.modelContext too', async () => {
  const { api, registered } = load({ pathname: '/pricing', hostKind: 'navigator' });
  await api.init({ surface: 'product' });
  assert(registered.length === 5, `navigator host got ${registered.length} tools`);
  assert(api.active === true, 'registration not reported active');
});

await check('a host that rejects outputSchema still gets the tool', async () => {
  const kept = [];
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
  globalThis.document = {
    currentScript: null, querySelector: () => null,
    modelContext: {
      registerTool: (t) => {
        if ('outputSchema' in t) throw new TypeError('unknown key outputSchema');
        kept.push(t);
      },
    },
  };
  globalThis.window = globalThis;
  globalThis.location = { pathname: '/pricing', assign() {} };
  globalThis.dispatchEvent = () => {};
  globalThis.CustomEvent = class { constructor(n, o) { this.detail = o?.detail; } };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => PRODUCT });
  new Function(SRC)();
  await globalThis.LobbyWebMCP.init({ surface: 'product' });
  assert(kept.length === 5, `degraded path registered ${kept.length} of 5 tools`);
  assert(kept.every((t) => !('outputSchema' in t)), 'outputSchema survived the downgrade');
});

// ── Usability: the committing action cannot commit by accident ──────────────

await check('start_booking books nothing without explicit confirmation', async () => {
  const { api, registered, calls } = load({ pathname: '/c/bookco', profile: PROFILE_WITH_BOOKING });
  await api.init({ slug: 'bookco' });
  const before = calls.filter((c) => c.method === 'POST').length;
  const out = data(await byName(registered).start_booking.execute({
    booking_type_id: 'intro-15',
    start_utc: '2026-09-06T09:00:00.000Z',
    guest_name: 'Dana',
    guest_email: 'dana@example.test',
  }));
  assert(out.ok === false, 'unconfirmed booking reported success');
  assert(out.error.code === 'confirmation_required', `wrong code: ${out.error.code}`);
  assert(out.status === 'needs_confirmation', 'status did not say nothing happened');
  assert(out.summary && out.summary.guest_email === 'dana@example.test',
    'no summary to read back to the visitor');
  const after = calls.filter((c) => c.method === 'POST').length;
  assert(after === before, 'an unconfirmed booking hit the backend');
});

await check('start_booking commits only with confirmed:true', async () => {
  const { api, registered, calls } = load({ pathname: '/c/bookco', profile: PROFILE_WITH_BOOKING });
  await api.init({ slug: 'bookco' });
  const out = data(await byName(registered).start_booking.execute({
    booking_type_id: 'intro-15',
    start_utc: '2026-09-06T09:00:00.000Z',
    guest_name: 'Dana',
    guest_email: 'dana@example.test',
    confirmed: true,
  }));
  assert(out.ok === true, `confirmed booking failed: ${JSON.stringify(out.error)}`);
  assert(out.status === 'booked', 'status is not booked');
  assert(out.booking_id === BOOKING_BODY.id, `no booking id returned: ${out.booking_id}`);
  // The summary a visitor hears must come from the response, not from the
  // arguments echoed back. `what` fell back to the raw booking_type_id for as
  // long as the backend did not send `booking_type_name`.
  assert(out.summary.what === BOOKING_BODY.booking_type_name,
    `summary.what is not the type NAME: ${out.summary.what}`);
  assert(out.summary.when_utc === BOOKING_BODY.starts_at,
    `summary.when_utc is not the backend's instant: ${out.summary.when_utc}`);
  assert(calls.some((c) => c.method === 'POST' && c.url.includes('/booking/bookings')),
    'confirmed booking never reached the backend');
});

await check('a taken slot is a typed, actionable failure', async () => {
  const { api, registered } = load({
    pathname: '/c/bookco', profile: PROFILE_WITH_BOOKING, posts: { bookingStatus: 409 },
  });
  await api.init({ slug: 'bookco' });
  const out = data(await byName(registered).start_booking.execute({
    booking_type_id: 'intro-15', start_utc: '2026-09-06T09:00:00.000Z',
    guest_name: 'Dana', guest_email: 'dana@example.test', confirmed: true,
  }));
  assert(out.ok === false && out.error.code === 'unavailable',
    `a 409 should be unavailable, got ${JSON.stringify(out.error)}`);
});

await check('a placeholder email is refused before any network call', async () => {
  const { api, registered } = load({ pathname: '/c/bookco', profile: PROFILE_WITH_BOOKING });
  await api.init({ slug: 'bookco' });
  const out = data(await byName(registered).start_booking.execute({
    booking_type_id: 'intro-15', start_utc: '2026-09-06T09:00:00.000Z',
    guest_name: 'Dana', guest_email: 'not-an-email', confirmed: true,
  }));
  assert(out.ok === false && out.error.code === 'invalid_input',
    'an invalid address was accepted');
});

// ── Cancellation: the token IS the authorization ────────────────────────────
//
// `cancel_booking` is the only tool that acts on a booking made in an earlier
// session, so it is the only one whose authorization cannot come from the page
// it runs on. It comes from the guest's own cancellation token, pasted in from
// their confirmation email. Two properties matter more than anything else here
// and both are asserted below:
//
//   1. It can NEVER be driven by a booking id. A booking id is a database
//      identifier that appears in `start_booking`'s own output and in an
//      owner's dashboard; accepting one would mean any caller could cancel any
//      stranger's appointment by guessing or enumerating ids. The token is a
//      48-hex-character secret with a uniqueness constraint behind it.
//   2. It never repeats the token back. The result is the one place a token
//      could leak into a transcript, a log, or a model's context window that
//      outlives the call.

const CANCEL_TOKEN = 'a1b2c3d4e5f6'.repeat(4); // 48 hex chars, like the backend's

await check('cancel_booking takes a cancel_token and NO booking id', async () => {
  const { api, registered } = load({ pathname: '/c/bookco', profile: PROFILE_WITH_BOOKING });
  await api.init({ slug: 'bookco' });
  const t = byName(registered).cancel_booking;
  const props = Object.keys(t.inputSchema.properties);
  assert(props.includes('cancel_token'), 'cancel_booking does not take a cancel_token');
  assert(t.inputSchema.required.includes('cancel_token'), 'cancel_token is not required');
  for (const forbidden of ['booking_id', 'id', 'guest_email', 'booking']) {
    assert(!props.includes(forbidden),
      `cancel_booking accepts ${forbidden} — a booking can then be cancelled by ` +
      'enumeration rather than by the guest\'s own secret');
  }
  assert(props.length === 2, `unexpected inputs: ${props.join(', ')}`);
});

await check('cancel_booking cancels nothing, and calls NOTHING, unconfirmed', async () => {
  const { api, registered, calls } = load({ pathname: '/c/bookco', profile: PROFILE_WITH_BOOKING });
  await api.init({ slug: 'bookco' });
  const before = calls.length;
  const out = data(await byName(registered).cancel_booking.execute({
    cancel_token: CANCEL_TOKEN,
  }));
  assert(out.ok === false, 'an unconfirmed cancellation reported success');
  assert(out.error.code === 'confirmation_required', `wrong code: ${out.error.code}`);
  assert(out.status === 'needs_confirmation', 'status did not say nothing happened');
  assert(out.summary && out.summary.business === 'Book Co',
    'no summary naming the business to read back to the visitor');
  // Stricter than start_booking's gate, which is allowed its profile fetch.
  // There is no endpoint that previews a booking by token, so an unconfirmed
  // cancel has nothing to ask and must ask nothing.
  assert(calls.length === before,
    `the confirmation gate made ${calls.length - before} network call(s)`);
});

await check('the cancel token is never echoed back in the result', async () => {
  const { api, registered } = load({ pathname: '/c/bookco', profile: PROFILE_WITH_BOOKING });
  await api.init({ slug: 'bookco' });
  const t = byName(registered).cancel_booking;
  for (const args of [{ cancel_token: CANCEL_TOKEN },
                      { cancel_token: CANCEL_TOKEN, confirmed: true }]) {
    const raw = JSON.stringify(data(await t.execute(args)));
    assert(!raw.includes(CANCEL_TOKEN),
      `the token appears in the result of ${JSON.stringify(args)} — it is the ` +
      'visitor\'s only credential and must not outlive the call');
  }
});

await check('cancel_booking commits only with confirmed:true', async () => {
  const { api, registered, calls } = load({ pathname: '/c/bookco', profile: PROFILE_WITH_BOOKING });
  await api.init({ slug: 'bookco' });
  const out = data(await byName(registered).cancel_booking.execute({
    cancel_token: CANCEL_TOKEN, confirmed: true,
  }));
  assert(out.ok === true, `confirmed cancellation failed: ${JSON.stringify(out.error)}`);
  assert(out.status === 'cancelled', `status is not cancelled: ${out.status}`);
  // From the backend's body, not hardcoded — the fixture deliberately makes
  // these two distinguishable.
  assert(out.summary.when_utc === CANCELLED_BODY.starts_at,
    `when_utc is not the backend's instant: ${out.summary.when_utc}`);
  const posted = calls.filter((c) => c.method === 'POST' && c.url.includes('/cancel'));
  assert(posted.length === 1, `expected one POST to cancel, got ${posted.length}`);
  assert(posted[0].url.includes('/lobby/bookings/'),
    `cancel hit the wrong path: ${posted[0].url}`);
  assert(!posted[0].url.includes('/agents/'),
    'the cancel path names a business — the token is the whole authorization');
});

await check('a booking id passed as the token is refused before any network call', async () => {
  const { api, registered, calls } = load({ pathname: '/c/bookco', profile: PROFILE_WITH_BOOKING });
  await api.init({ slug: 'bookco' });
  const before = calls.length;
  // 36 characters, so a bare length check would let it through — this is the
  // mistake an agent actually makes: it has `booking_id` from start_booking.
  const out = data(await byName(registered).cancel_booking.execute({
    cancel_token: '3f8a1c2e-9b47-4d51-8e0a-7c6b5d4e3f2a', confirmed: true,
  }));
  assert(out.ok === false && out.error.code === 'invalid_input',
    `a booking id was accepted as a cancel token: ${JSON.stringify(out)}`);
  assert(/cancellation link|booking id/i.test(out.error.message),
    `the message does not explain the mixup: ${out.error.message}`);
  assert(calls.length === before, 'a rejected token still reached the backend');
});

await check('a too-short token is refused before any network call', async () => {
  const { api, registered, calls } = load({ pathname: '/c/bookco', profile: PROFILE_WITH_BOOKING });
  await api.init({ slug: 'bookco' });
  const before = calls.length;
  const out = data(await byName(registered).cancel_booking.execute({
    cancel_token: 'abc123', confirmed: true,
  }));
  assert(out.ok === false && out.error.code === 'invalid_input',
    'a 6-character token was sent to the backend');
  assert(calls.length === before, 'a short-token probe reached the backend');
});

await check('an unknown token is a typed failure, not a crash', async () => {
  const { api, registered } = load({
    pathname: '/c/bookco', profile: PROFILE_WITH_BOOKING, posts: { cancelStatus: 404 },
  });
  await api.init({ slug: 'bookco' });
  const out = data(await byName(registered).cancel_booking.execute({
    cancel_token: CANCEL_TOKEN, confirmed: true,
  }));
  assert(out.ok === false && out.error.code === 'invalid_input',
    `a 404 should be invalid_input, got ${JSON.stringify(out.error)}`);
});

await check('an appointment too late to cancel is typed and actionable', async () => {
  const { api, registered } = load({
    pathname: '/c/bookco', profile: PROFILE_WITH_BOOKING, posts: { cancelStatus: 400 },
  });
  await api.init({ slug: 'bookco' });
  const out = data(await byName(registered).cancel_booking.execute({
    cancel_token: CANCEL_TOKEN, confirmed: true,
  }));
  assert(out.ok === false && out.error.code === 'unavailable',
    `a 400 should be unavailable, got ${JSON.stringify(out.error)}`);
  assert(/contact|business/i.test(out.error.message),
    `the message offers no next step: ${out.error.message}`);
});

await check('a throttled cancellation says so rather than reading as invalid', async () => {
  const { api, registered } = load({
    pathname: '/c/bookco', profile: PROFILE_WITH_BOOKING, posts: { cancelStatus: 429 },
  });
  await api.init({ slug: 'bookco' });
  const out = data(await byName(registered).cancel_booking.execute({
    cancel_token: CANCEL_TOKEN, confirmed: true,
  }));
  assert(out.ok === false && out.error.code === 'upstream_error',
    `a 429 should be upstream_error, got ${JSON.stringify(out.error)}`);
  assert(!/not valid/i.test(out.error.message),
    'a throttle was reported as an invalid link — the visitor would re-check a good token');
});

// ── The four evaluation journeys (handoff §12) ──────────────────────────────

await check('journey 1: product and pricing, without ask_concierge', async () => {
  const { api, registered } = load({ pathname: '/', profile: PROFILE_NO_BOOKING });
  await api.init({ slug: 'plainco', surface: 'both' });
  const t = byName(registered);
  const pricing = data(await t.get_pricing.execute({}));
  assert(pricing.ok && pricing.plans.length === 2, 'pricing incomplete');
  const rec = data(await t.recommend_plan.execute({
    expected_monthly_conversations: 400, needs_own_branding: true,
  }));
  assert(rec.ok && rec.recommended_plan_id === 'paid', 'high volume did not recommend paid');
  assert(rec.reasons.length >= 2, 'recommendation gave no reasons');
  assert(rec.caveats.some((c) => c.includes('past the paid allowance')),
    'over-the-paid-cap volume produced no caveat');
  const signup = data(await t.open_signup.execute({ plan: 'paid' }));
  assert(signup.ok && signup.url.includes('/signup'), 'no signup url');
  assert(signup.navigated === false, 'open_signup navigated without being asked');
});

await check('journey 1b: a low-volume business is steered to free, not upsold', async () => {
  const { api, registered } = load({ pathname: '/pricing' });
  await api.init({ surface: 'product' });
  const rec = data(await byName(registered).recommend_plan.execute({
    expected_monthly_conversations: 10,
  }));
  assert(rec.recommended_plan_id === 'free', 'low volume was upsold to paid');
});

await check('journey 2: proof and examples', async () => {
  const { api, registered } = load({ pathname: '/', profile: PROFILE_NO_BOOKING });
  await api.init({ slug: 'plainco', surface: 'both' });
  const out = data(await byName(registered).list_customer_examples.execute({ limit: 2 }));
  assert(out.ok && out.examples.length === 2, 'no examples returned');
  assert(out.examples.every((e) => e.url.startsWith('https://lobby.host/c/')),
    'example urls are not visitable concierge pages');
});

await check('journey 3: booking asked of a concierge that cannot book', async () => {
  const { api, registered } = load({ pathname: '/c/plainco', profile: PROFILE_NO_BOOKING });
  await api.init({ slug: 'plainco' });
  const t = byName(registered);
  assert(!t.check_availability, 'a non-booking concierge exposed check_availability');
  const info = data(await t.get_business_info.execute({}));
  assert(info.booking_available === false, 'did not say booking is unavailable');
  assert(info.contact && info.contact.email, 'no contact alternative to offer');
});

await check('journey 3b: booking asked of a concierge that can', async () => {
  const { api, registered } = load({ pathname: '/c/bookco', profile: PROFILE_WITH_BOOKING });
  await api.init({ slug: 'bookco' });
  const t = byName(registered);
  const options = data(await t.get_booking_options.execute({}));
  assert(options.ok && options.booking_types[0].duration_minutes === 15, 'no booking types');
  assert(options.timezone === 'Asia/Jerusalem',
    `the business zone did not survive: ${options.timezone}`);
  const avail = data(await t.check_availability.execute({
    booking_type_id: options.booking_types[0].id, from_date: '2026-09-06',
  }));
  // Named individually, because these are the two fields that were actually
  // wrong on production and "schema mismatch" would not say which.
  assert(avail.timezone === 'Asia/Jerusalem',
    `availability reported zone ${avail.timezone} — a 'UTC' here is the tool's fallback showing through`);
  assert(avail.slots.every((s) => typeof s.start_local === 'string'),
    `a slot has no start_local: ${Object.keys(avail.slots[0] ?? {}).join(', ')}`);
  assert(avail.ok && avail.total === 2, `expected 2 slots, got ${avail.total}`);
  assert(avail.slots.every((s) => s.start_utc.endsWith('Z')),
    'slots are not absolute UTC instants');
});

await check('journey 4: customer concierge picks a service and a next step', async () => {
  const { api, registered } = load({ pathname: '/c/bookco', profile: PROFILE_WITH_BOOKING });
  await api.init({ slug: 'bookco' });
  const t = byName(registered);
  const all = data(await t.list_offerings.execute({}));
  assert(all.total === 2, 'wrong offering count');
  const bookable = data(await t.list_offerings.execute({ bookable_only: true }));
  assert(bookable.total === 1, 'bookable_only did not filter');
  assert(bookable.offerings[0].name === 'Intro call', 'wrong offering marked bookable');
  assert(bookable.offerings[0].contact_required === false,
    'a bookable offering should not require contact');
});

// ── Input validation is typed, not prose ────────────────────────────────────

await check('bad availability input is refused with a code', async () => {
  const { api, registered } = load({ pathname: '/c/bookco', profile: PROFILE_WITH_BOOKING });
  await api.init({ slug: 'bookco' });
  const t = byName(registered);
  const noType = data(await t.check_availability.execute({ from_date: '2026-09-06' }));
  assert(noType.error?.code === 'invalid_input', 'missing booking_type_id not caught');
  const badDate = data(await t.check_availability.execute({
    booking_type_id: 'intro-15', from_date: '6 September',
  }));
  assert(badDate.error?.code === 'invalid_input', 'malformed date not caught');
});

await check('an empty question is refused before spending a conversation', async () => {
  const { api, registered, calls } = load({ pathname: '/c/plainco', profile: PROFILE_NO_BOOKING });
  await api.init({ slug: 'plainco' });
  const out = data(await byName(registered).ask_concierge.execute({ question: ' ' }));
  assert(out.error?.code === 'invalid_input', 'empty question accepted');
  assert(!calls.some((c) => c.url.includes('/conversations')),
    'an empty question started a conversation');
});

await check('an unreachable profile degrades to a typed error, not a crash', async () => {
  const { api, registered } = load({ pathname: '/c/gone', profile: null });
  await api.init({ slug: 'gone' });
  const out = data(await byName(registered).get_business_info.execute({}));
  assert(out.ok === false, 'a 404 profile reported success');
  assert(out.error.code === 'upstream_error', `wrong code: ${out.error.code}`);
  assert(/unavailable/i.test(out.error.message), 'error message is not actionable');
});

// ── Customer-site safety: never register Lobby's own tools on someone else's site

await check('a bare slug on a customer homepage registers ONLY concierge tools', async () => {
  // Exactly what embed.js sends: a slug, no surface, on the customer's own
  // page — which is very often at "/".
  const { api, registered } = load({ pathname: '/', profile: PROFILE_NO_BOOKING });
  await api.init({ slug: 'plainco' });
  const names = registered.map((t) => t.name);
  for (const leak of ['get_pricing', 'recommend_plan', 'open_signup',
                      'get_setup_instructions', 'list_customer_examples']) {
    assert(!names.includes(leak),
      `${leak} leaked onto a customer site — Lobby's own tools must never register there`);
  }
  assert(api.surface === 'concierge', `surface was ${api.surface}, expected concierge`);
});

await check('surface auto opts in to path detection', async () => {
  const { api, registered } = load({ pathname: '/', profile: PROFILE_NO_BOOKING });
  await api.init({ slug: 'hello', surface: 'auto' });
  const names = registered.map((t) => t.name);
  assert(api.surface === 'both', `auto on / gave ${api.surface}`);
  assert(names.includes('get_pricing') && names.includes('ask_concierge'),
    'auto on / should give both sets');
});

await check('an unknown surface is a hard error', () => {
  const { api } = load({ pathname: '/' });
  let threw = false;
  try { api.init({ surface: 'everything' }); } catch (_) { threw = true; }
  assert(threw, 'a typo in surface should not silently pick a default');
});

// ── Report ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('CONTRACT OK');
