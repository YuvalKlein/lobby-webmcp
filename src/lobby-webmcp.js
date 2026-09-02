/*!
 * lobby-webmcp — WebMCP tools for Lobby.
 *
 * Lobby (https://lobby.host) gives a business an AI concierge on its website.
 * This script is the second door: it registers the same concierge as
 * structured WebMCP tools, so a visiting agent (ChatGPT's in-app browser,
 * Chrome with WebMCP enabled) can do whatever a human guest can do —
 * ask questions, read the business's facts, browse its offerings, and, where
 * the business has configured it, book — and cancel, which is the half of
 * "whatever a guest can do" that a booking tool alone quietly withholds.
 *
 * Zero dependencies, no build step.
 *
 * Two tool sets, composed per page:
 *
 *   concierge  one business's concierge. Needs a slug. Registered on the
 *              hosted page (/c/<slug>) and on any customer site running the
 *              embed.
 *   product    Lobby itself — plans, setup, examples, signup. Registered on
 *              lobby.host's own marketing pages.
 *
 * lobby.host's homepage registers BOTH: it runs a live self-demo concierge, so
 * an agent landing there can ask the concierge a question AND compare plans.
 *
 * Usage (script tag):
 *   <script src="lobby-webmcp.js" data-lobby-slug="arenna"></script>
 *   <script src="lobby-webmcp.js" data-lobby-surface="product"></script>
 *   <script src="lobby-webmcp.js" data-lobby-slug="hello"
 *           data-lobby-surface="both"></script>
 *
 * A bare slug means the concierge tool set — the surface is never guessed from
 * the URL unless you ask for it with data-lobby-surface="auto".
 *
 * Usage (programmatic):
 *   LobbyWebMCP.init({ slug: 'arenna' });
 *   LobbyWebMCP.init({ surface: 'both', slug: 'hello' });
 *
 * License: MIT
 */
(function (global) {
  'use strict';

  var DEFAULT_API_BASE =
    'https://unitism-backend-production.up.railway.app/api/v1';

  /** Where the product manifest lives. Same-origin on lobby.host itself. */
  var DEFAULT_PRODUCT_BASE = 'https://lobby.host';

  var SURFACES = ['concierge', 'product', 'both'];

  /**
   * `surface: 'auto'` — derive the surface from the URL path.
   *
   * Opt-in, never the default, and this is a safety property rather than a
   * preference. This script also runs on CUSTOMERS' websites, injected by
   * embed.js, where it is handed a slug and nothing else. If path detection
   * were the default, a customer whose concierge sits on their homepage would
   * have `/` matched as Lobby's own homepage and would silently start serving
   * Lobby's pricing and signup tools to their visitors' agents — pointing at
   * their origin for a product manifest that does not exist there.
   *
   * So: an explicit surface wins, `'auto'` asks for path detection, and a bare
   * slug means `concierge` — which is exactly what every existing embed sends,
   * so their behaviour is unchanged.
   */
  var AUTO_SURFACE = 'auto';

  // ── State ──────────────────────────────────────────────────────────────────

  var state = {
    slug: null,
    surface: null,
    apiBase: DEFAULT_API_BASE,
    productBase: DEFAULT_PRODUCT_BASE,
    conversationId: null, // one conversation per page session, lazily created
    profileCache: null, // GET agents/:slug/public, cached per page load
    productCache: null, // GET <productBase>/webmcp/product.json, ditto
    capabilities: null, // derived from the profile — see capabilitiesFrom
    registered: [],
  };

  // ── HTTP ───────────────────────────────────────────────────────────────────

  function api(path) {
    return state.apiBase.replace(/\/$/, '') + path;
  }

  function productUrl(path) {
    return state.productBase.replace(/\/$/, '') + path;
  }

  /**
   * One fetch shape for every read.
   *
   * [label] names the thing being fetched so a failure reaches the agent as a
   * sentence it can act on ("Lobby's plan information is unavailable") rather
   * than a bare status code.
   */
  async function getJson(url, label) {
    var res;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json' } });
    } catch (e) {
      throw new Error(label + ' could not be reached (network error).');
    }
    if (!res.ok) {
      throw new Error(label + ' is unavailable (HTTP ' + res.status + ').');
    }
    return res.json();
  }

  // ── Lobby public API (see unitism-backend API_GUIDE.md) ────────────────────

  /** Public-safe concierge profile: name, intro, services, contact, intents. */
  async function fetchProfile() {
    if (state.profileCache) return state.profileCache;
    if (!state.slug) {
      throw new Error(
        'No concierge is configured on this page, so business-specific ' +
          'lookups are not available here.',
      );
    }
    state.profileCache = await getJson(
      api('/lobby/agents/' + encodeURIComponent(state.slug) + '/public'),
      'This business’s concierge profile',
    );
    state.capabilities = capabilitiesFrom(state.profileCache);
    return state.profileCache;
  }

  /**
   * Lobby's own product facts — plans, prices, allowances, setup steps.
   *
   * Served by lobby-web from `content/pricing.ts`, not restated here. Prices
   * and allowances change, and a copy of them inside a script that customers
   * self-host would start lying the day after the first price change. The one
   * place they are authored is the one place they are read.
   */
  async function fetchProduct() {
    if (state.productCache) return state.productCache;
    state.productCache = await getJson(
      productUrl('/webmcp/product.json'),
      'Lobby’s plan and setup information',
    );
    return state.productCache;
  }

  /** Start (or reuse) the agent's conversation with the concierge. */
  async function ensureConversation() {
    if (state.conversationId) return state.conversationId;
    var res = await fetch(
      api('/lobby/agents/' + encodeURIComponent(state.slug) + '/conversations'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    if (!res.ok) {
      throw new Error('Could not start a conversation (' + res.status + ')');
    }
    var body = await res.json();
    state.conversationId = body.conversation_id;
    emit('conversation', {
      conversation_id: body.conversation_id,
      opening_message: body.opening_message,
    });
    return state.conversationId;
  }

  /**
   * Send one message and collect the streamed reply.
   *
   * The reply arrives as SSE (`data: {"type":"token","text":...}` lines,
   * terminated by `{"type":"done"}`). Agents want the whole answer, not a
   * stream, so this accumulates tokens and resolves with the full text.
   */
  async function sendMessage(content) {
    var conversationId = await ensureConversation();
    var res = await fetch(
      api('/lobby/conversations/' + conversationId + '/messages'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: content }),
      },
    );
    if (!res.ok || !res.body) {
      throw new Error('The concierge did not answer (' + res.status + ')');
    }

    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var reply = '';
    var done = false;

    while (!done) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      var lines = buffer.split('\n');
      buffer = lines.pop(); // keep the trailing partial line
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.indexOf('data:') !== 0) continue;
        var payload = line.slice(5).trim();
        if (!payload) continue;
        var event;
        try {
          event = JSON.parse(payload);
        } catch (_) {
          // Non-JSON data line: treat as a raw token (mirrors the widget).
          reply += payload;
          continue;
        }
        if (event.type === 'token' && typeof event.text === 'string') {
          reply += event.text;
        } else if (event.type === 'done') {
          done = true;
        }
        // audio / audio_end events (voice mode) are irrelevant here.
      }
    }

    emit('exchange', {
      conversation_id: conversationId,
      question: content,
      reply: reply,
    });
    return { reply: reply, conversation_id: conversationId };
  }

  // ── Capabilities ───────────────────────────────────────────────────────────

  /**
   * What this concierge can actually DO, derived from its public profile.
   *
   * A capability-specific tool is registered only when its capability is
   * present. This is the rule that keeps the tool surface honest: a concierge
   * with no booking configured exposes no booking tool, so a visiting agent
   * cannot be told "yes, I can book that" by a tool list that then fails.
   *
   * The webmcp.com scorecard docked Lobby for exactly this shape of mismatch —
   * page copy implying a booking capability the tools did not have. The fix is
   * structural, not a wording change: capability absent ⇒ tool absent.
   *
   * `booking` stays false against any backend that predates the field, which is
   * the safe direction to fail — an unknown capability is treated as missing,
   * never as present.
   */
  function capabilitiesFrom(profile) {
    var booking = (profile && profile.booking) || null;
    var contact = (profile && profile.contact) || null;
    return {
      booking: Boolean(booking && booking.enabled === true),
      contact: Boolean(
        contact && (contact.email || contact.phone || contact.url),
      ),
    };
  }

  // ── Page integration events ────────────────────────────────────────────────
  //
  // The host page (e.g. the Lobby widget itself) can listen and surface the
  // agent's conversation to the human sitting at the same page:
  //   window.addEventListener('lobby-webmcp:exchange', (e) => ...e.detail)

  function emit(name, detail) {
    try {
      global.dispatchEvent(
        new CustomEvent('lobby-webmcp:' + name, { detail: detail }),
      );
    } catch (_) {
      /* CustomEvent unavailable — non-browser context; events are optional */
    }
  }

  // ── Result contract ────────────────────────────────────────────────────────
  //
  // Every tool resolves to the SAME envelope shape, and every tool declares it
  // with an `outputSchema`. Two reasons this is worth the ceremony:
  //
  //  1. An agent that knows the result shape in advance can plan a journey
  //     ("call list_offerings, filter on `bookable`, then call start_booking")
  //     instead of re-reading prose on every hop. The webmcp.com scorecard
  //     weights usability at 60% and docked all three original tools for having
  //     no declared result shape at all.
  //  2. Failure becomes data. A tool that answers "I'm not sure that's
  //     available" in prose forces the agent to guess whether it should retry,
  //     ask the human, or give up. `{ ok: false, error: { code } }` says which.
  //
  // Native WebMCP support for output schemas is still moving (the proposal has
  // shifted from `navigator.modelContext` to `document.modelContext` inside a
  // year), so the schema travels in the tool definition and the structured
  // object travels in BOTH `structuredContent` (hosts that read schemas) and
  // `content` as JSON text (hosts that don't). No host sees an empty result
  // because it implements the older half of the proposal.

  function envelope(data) {
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      structuredContent: data,
    };
  }

  function ok(data) {
    var out = { ok: true };
    for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = data[k];
    return envelope(out);
  }

  /**
   * An explicit unavailable / refused state.
   *
   * [code] is a stable machine token, [message] is for the human the agent is
   * speaking to. Codes used: `not_configured` (the business has not set this
   * up), `unavailable` (configured but nothing to offer right now),
   * `confirmation_required` (a committing action needs an explicit yes),
   * `invalid_input`, `upstream_error`.
   */
  function failed(code, message, extra) {
    var out = { ok: false, error: { code: code, message: message } };
    for (var k in extra || {}) {
      if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k];
    }
    return envelope(out);
  }

  /** The `ok`/`error` pair every outputSchema shares. */
  function baseOutput(properties, required) {
    var props = {
      ok: {
        type: 'boolean',
        description: 'False when the request could not be fulfilled.',
      },
      error: {
        type: ['object', 'null'],
        description: 'Present only when ok is false.',
        properties: {
          code: {
            type: 'string',
            enum: [
              'not_configured',
              'unavailable',
              'confirmation_required',
              'invalid_input',
              'upstream_error',
            ],
          },
          message: { type: 'string' },
        },
        required: ['code', 'message'],
      },
    };
    for (var k in properties) {
      if (Object.prototype.hasOwnProperty.call(properties, k)) {
        props[k] = properties[k];
      }
    }
    return {
      type: 'object',
      properties: props,
      required: ['ok'].concat(required || []),
    };
  }

  /** Wrap an execute so a thrown error becomes a typed result, never a crash. */
  function guarded(code, fn) {
    return async function (args) {
      try {
        return await fn(args || {});
      } catch (e) {
        return failed(code, (e && e.message) || 'Something went wrong.');
      }
    };
  }

  // ── Offerings ──────────────────────────────────────────────────────────────

  /**
   * Normalise one service into a stable offering shape.
   *
   * `bookable` is the field that stops an agent assuming everything on the list
   * can be scheduled. It is derived from the concierge's booking capability and
   * the offering's own flag — never defaulted to true. An offering the business
   * has not marked bookable is not bookable, even on a concierge that can book
   * other things.
   */
  function toOffering(service, index, canBook) {
    var title = String((service && service.title) || 'Untitled');
    return {
      id:
        (service && service.id) ||
        title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') ||
        'offering-' + (index + 1),
      name: title,
      description: String((service && service.description) || ''),
      price: (service && service.price) != null ? service.price : null,
      currency: (service && service.currency) || null,
      bookable: Boolean(canBook && service && service.bookable === true),
      action_url: (service && service.action_url) || null,
      contact_required: !(canBook && service && service.bookable === true),
    };
  }

  var OFFERING_SCHEMA = {
    type: 'array',
    description: 'The business’s services, comparable and filterable.',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Stable id to pass to other tools.' },
        name: { type: 'string' },
        description: { type: 'string' },
        price: {
          type: ['number', 'string', 'null'],
          description: 'Null when the business does not publish a price.',
        },
        currency: { type: ['string', 'null'] },
        bookable: {
          type: 'boolean',
          description:
            'True only when this specific offering can be scheduled through ' +
            'the booking tools. Never assume a bookable offering from the ' +
            'presence of a booking tool.',
        },
        action_url: { type: ['string', 'null'], format: 'uri' },
        contact_required: {
          type: 'boolean',
          description:
            'True when arranging this offering needs a human — use the ' +
            'contact details from get_business_info.',
        },
      },
      required: ['id', 'name', 'description', 'bookable'],
    },
  };

  // ── Concierge tools ────────────────────────────────────────────────────────

  function conciergeTools() {
    return [
      {
        name: 'ask_concierge',
        description:
          "Ask this business's concierge a question in natural language — " +
          'hours, policies, recommendations, anything a guest would ask at the ' +
          'desk. Replies come from the same knowledge and conversation engine ' +
          'the human-facing chat on this page uses, and context is kept across ' +
          'calls so follow-ups work. Use this for judgement and nuance. Do NOT ' +
          'use it for facts the free lookup tools already return — prefer ' +
          'get_business_info for contact details and list_offerings for ' +
          'services, which are instant and cost nothing. ' +
          'Returns { ok, answer, conversation_id }.',
        inputSchema: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              minLength: 2,
              maxLength: 2000,
              description:
                "The visitor's question, in natural language. One question " +
                'per call; the concierge answers conversationally.',
            },
          },
          required: ['question'],
        },
        outputSchema: baseOutput(
          {
            answer: {
              type: 'string',
              description: "The concierge's reply, in full.",
            },
            conversation_id: {
              type: 'string',
              description:
                'The conversation this reply belongs to. Stable across calls ' +
                'on this page.',
            },
          },
          ['answer'],
        ),
        execute: guarded('upstream_error', async function (args) {
          var question = String(args.question == null ? '' : args.question).trim();
          if (question.length < 2) {
            return failed('invalid_input', 'Ask a question of at least two characters.');
          }
          var result = await sendMessage(question);
          return ok({
            answer: result.reply,
            conversation_id: result.conversation_id,
          });
        }),
      },

      {
        name: 'get_business_info',
        description:
          'Verified public facts about this business: name, how it introduces ' +
          'itself, published contact details, the topics it invites questions ' +
          'about, and whether it can take a booking. Free and instant, no ' +
          'conversation started. Call this FIRST for anything factual — it is ' +
          'cheaper and more reliable than asking the concierge. ' +
          'Returns { ok, name, introduction, contact { email, phone, url }, ' +
          'suggested_topics[], booking_available }. Every Lobby tool returns ' +
          'that same envelope: `ok`, plus `error` with `code` and `message` ' +
          'when `ok` is false, alongside its own payload.',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: baseOutput(
          {
            name: { type: 'string' },
            introduction: {
              type: 'string',
              description: 'How the business introduces itself to a visitor.',
            },
            contact: {
              type: ['object', 'null'],
              description: 'Published contact details, or null if none.',
              properties: {
                email: { type: ['string', 'null'] },
                phone: { type: ['string', 'null'] },
                url: { type: ['string', 'null'], format: 'uri' },
              },
            },
            suggested_topics: {
              type: 'array',
              items: { type: 'string' },
              description: 'Topics this concierge is prepared to discuss.',
            },
            booking_available: {
              type: 'boolean',
              description:
                'True when this concierge exposes booking tools. When false, ' +
                'nothing here can be scheduled — offer the contact details ' +
                'instead of implying a booking is possible.',
            },
          },
          ['name', 'introduction', 'booking_available'],
        ),
        execute: guarded('upstream_error', async function () {
          var p = await fetchProfile();
          return ok({
            name: p.name,
            introduction: p.intro_message,
            contact: p.contact || null,
            suggested_topics: p.suggested_intents || [],
            booking_available: state.capabilities.booking,
          });
        }),
      },

      {
        name: 'list_offerings',
        description:
          'The services this business offers, as structured data an agent can ' +
          'compare, filter or present. Each offering carries an explicit ' +
          '`bookable` flag — check it before attempting to schedule anything. ' +
          'Free and instant. Returns { ok, offerings[] of { id, name, ' +
          'description, price, currency, bookable, action_url, ' +
          'contact_required }, total, booking_available }.',
        inputSchema: {
          type: 'object',
          properties: {
            bookable_only: {
              type: 'boolean',
              description:
                'When true, return only offerings that can be scheduled ' +
                'through the booking tools. Default false (return all).',
            },
          },
        },
        outputSchema: baseOutput(
          {
            offerings: OFFERING_SCHEMA,
            total: { type: 'integer' },
            booking_available: {
              type: 'boolean',
              description:
                'Whether this concierge can book at all. False means every ' +
                'offering is contact-only regardless of its own flag.',
            },
          },
          ['offerings', 'total', 'booking_available'],
        ),
        execute: guarded('upstream_error', async function (args) {
          var p = await fetchProfile();
          var canBook = state.capabilities.booking;
          var offerings = (p.services || []).map(function (s, i) {
            return toOffering(s, i, canBook);
          });
          if (args.bookable_only === true) {
            offerings = offerings.filter(function (o) {
              return o.bookable;
            });
          }
          return ok({
            offerings: offerings,
            total: offerings.length,
            booking_available: canBook,
          });
        }),
      },
    ];
  }

  // ── Booking tools (capability-gated) ───────────────────────────────────────
  //
  // Registered ONLY when the concierge's profile reports booking enabled. On
  // every other concierge these tools do not exist, which is the point: an
  // agent's tool list is a promise, and a promise that fails is worse than an
  // absent capability. `get_business_info.booking_available` tells an agent
  // which world it is in without it having to probe.
  //
  // `start_booking` and `cancel_booking` are the two committing actions in this
  // script, and both are two-step by construction: called without
  // `confirmed: true` they change nothing and return the exact summary the
  // visitor must agree to.
  //
  // They are authorised completely differently, and that asymmetry is the
  // interesting part. Booking needs no credential — anyone may ask for a free
  // slot, which is what a public booking page is. Cancelling acts on an
  // appointment that already exists and belongs to someone, so it is gated on
  // the guest's `cancel_token` and never on a `booking_id`: an id identifies a
  // booking, a token proves you are its guest. See `cancel_booking`.

  function bookingTools() {
    return [
      {
        name: 'get_booking_options',
        description:
          'What can be booked with this business, and for how long. Returns ' +
          'the bookable appointment types with their durations. Call this ' +
          'before check_availability — availability is always relative to one ' +
          'booking type, because duration determines which slots fit. ' +
          'Returns { ok, booking_types[] of { id, name, description, ' +
          'duration_minutes, price, currency, location_kind }, timezone }.',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: baseOutput(
          {
            booking_types: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  duration_minutes: { type: 'integer', minimum: 1 },
                  price: { type: ['number', 'null'] },
                  currency: { type: ['string', 'null'] },
                  location_kind: {
                    type: 'string',
                    enum: ['video_call', 'phone', 'in_person', 'unspecified'],
                  },
                },
                required: ['id', 'name', 'duration_minutes'],
              },
            },
            timezone: {
              type: 'string',
              description:
                'IANA zone the business keeps its hours in. Slot times are ' +
                'returned as absolute UTC instants regardless, so a visitor ' +
                'in another zone is never offered a time that does not exist.',
            },
          },
          ['booking_types', 'timezone'],
        ),
        execute: guarded('upstream_error', async function () {
          var data = await getJson(
            api(
              '/lobby/agents/' +
                encodeURIComponent(state.slug) +
                '/booking/options',
            ),
            'This business’s booking options',
          );
          if (!data || !(data.booking_types || []).length) {
            return failed(
              'not_configured',
              'This business has not published anything bookable.',
            );
          }
          return ok({
            booking_types: data.booking_types,
            timezone: data.timezone || 'UTC',
          });
        }),
      },

      {
        name: 'check_availability',
        description:
          'Free times for one booking type in a date range. Every slot is a ' +
          'real opening: the business’s published hours minus anything already ' +
          'on its calendar. An empty list is a definite "nothing free in that ' +
          'range", not an error — widen the range or offer to take a message. ' +
          'Returns { ok, slots[] of { start_utc, end_utc, start_local }, ' +
          'total, timezone, searched { from_date, to_date } }.',
        inputSchema: {
          type: 'object',
          properties: {
            booking_type_id: {
              type: 'string',
              description: 'From get_booking_options.',
            },
            from_date: {
              type: 'string',
              format: 'date',
              description: 'First date to consider, YYYY-MM-DD.',
            },
            to_date: {
              type: 'string',
              format: 'date',
              description:
                'Last date to consider, YYYY-MM-DD, INCLUSIVE. Omit for a ' +
                'single day. At most 60 days after from_date.',
            },
            visitor_timezone: {
              type: 'string',
              description:
                "The visitor's IANA timezone, if known (e.g. " +
                "'Europe/Berlin'). Slot times are echoed in it for display. " +
                'Omit and the business’s own zone is used.',
            },
          },
          required: ['booking_type_id', 'from_date'],
        },
        outputSchema: baseOutput(
          {
            slots: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  start_utc: { type: 'string', format: 'date-time' },
                  end_utc: { type: 'string', format: 'date-time' },
                  start_local: {
                    type: 'string',
                    description:
                      'Same instant, formatted in visitor_timezone, for ' +
                      'showing a person. Never pass this back — pass ' +
                      'start_utc.',
                  },
                },
                required: ['start_utc', 'end_utc'],
              },
            },
            total: { type: 'integer' },
            timezone: { type: 'string' },
            searched: {
              type: 'object',
              properties: {
                from_date: { type: 'string', format: 'date' },
                to_date: { type: 'string', format: 'date' },
              },
            },
          },
          ['slots', 'total', 'timezone'],
        ),
        execute: guarded('upstream_error', async function (args) {
          if (!args.booking_type_id) {
            return failed(
              'invalid_input',
              'booking_type_id is required — call get_booking_options first.',
            );
          }
          if (!/^\d{4}-\d{2}-\d{2}$/.test(String(args.from_date || ''))) {
            return failed('invalid_input', 'from_date must be YYYY-MM-DD.');
          }
          var q =
            '?booking_type_id=' +
            encodeURIComponent(args.booking_type_id) +
            '&from_date=' +
            encodeURIComponent(args.from_date);
          // Sent ALWAYS, defaulting to a single day. The endpoint requires
          // `to_date` and answers HTTP 400 without it, while this tool declares
          // it optional — so an agent asking "what is free on Tuesday" with one
          // date got `upstream_error` from a perfectly valid request. Found
          // against production by test/smoke.mjs on 2026-09-01. Defaulting here
          // rather than relaxing the endpoint keeps the range explicit on the
          // wire, and matches what this tool already echoed in `searched`.
          q += '&to_date=' + encodeURIComponent(args.to_date || args.from_date);
          if (args.visitor_timezone) {
            q += '&timezone=' + encodeURIComponent(args.visitor_timezone);
          }
          var data = await getJson(
            api(
              '/lobby/agents/' +
                encodeURIComponent(state.slug) +
                '/booking/availability' +
                q,
            ),
            'Availability for this business',
          );
          return ok({
            slots: data.slots || [],
            total: (data.slots || []).length,
            timezone: data.timezone || 'UTC',
            searched: {
              from_date: args.from_date,
              to_date: args.to_date || args.from_date,
            },
          });
        }),
      },

      {
        name: 'start_booking',
        description:
          'Book one of the free slots from check_availability. THIS COMMITS ' +
          'the visitor to an appointment and emails the business, so it is ' +
          'deliberately two-step: call it first WITHOUT `confirmed`, show the ' +
          'returned summary to the visitor in their own words, and only call ' +
          'it again with `confirmed: true` once they have explicitly agreed. ' +
          'Never set `confirmed: true` on the first call, and never infer ' +
          'agreement from the visitor merely having asked about times. ' +
          'Returns { ok, status, summary { what, when_utc, duration_minutes, ' +
          'guest_name, guest_email, business }, booking_id }. The visitor is ' +
          'emailed a confirmation with a calendar invitation attached and ' +
          'their own cancellation link. `cancel_url` is null here and stays ' +
          'null on purpose: that link is the visitor’s only credential for ' +
          'their appointment and it is not handed to a tool caller. If the ' +
          'visitor later wants to cancel, ask them for the token in that ' +
          'email and use cancel_booking — do not send them to the business, ' +
          'and do not try their booking_id.',
        inputSchema: {
          type: 'object',
          properties: {
            booking_type_id: { type: 'string', description: 'From get_booking_options.' },
            start_utc: {
              type: 'string',
              format: 'date-time',
              description:
                'Exactly as returned by check_availability. Do not construct ' +
                'or round this yourself.',
            },
            guest_name: {
              type: 'string',
              minLength: 1,
              maxLength: 120,
              description:
                'The name the visitor gave you, as they gave it. This is what ' +
                'the business will see on the appointment.',
            },
            guest_email: {
              type: 'string',
              format: 'email',
              maxLength: 320,
              description:
                'Where the confirmation goes. Ask the visitor; never invent, ' +
                'guess or reuse an address from elsewhere on the page.',
            },
            notes: {
              type: 'string',
              maxLength: 1000,
              description: 'Anything the business should know beforehand.',
            },
            confirmed: {
              type: 'boolean',
              description:
                'The visitor has seen the summary and explicitly agreed. ' +
                'Omit or false on the first call.',
            },
          },
          required: ['booking_type_id', 'start_utc', 'guest_name', 'guest_email'],
        },
        outputSchema: baseOutput(
          {
            status: {
              type: 'string',
              enum: ['needs_confirmation', 'booked'],
              description:
                '`needs_confirmation` means NOTHING was booked yet. `booked` ' +
                'means the appointment exists, is on the business’s calendar, ' +
                'and a confirmation email has gone to the address given — ' +
                'carrying a calendar invitation and the visitor’s own ' +
                'cancellation link. Tell them to expect it. The appointment ' +
                'itself does not depend on that email: `booked` is the record, ' +
                'and a mail delay is not a booking that failed.',
            },
            summary: {
              type: 'object',
              description:
                'Exactly what will be, or has been, booked. Read this back to ' +
                'the visitor verbatim before confirming.',
              properties: {
                what: { type: 'string' },
                when_utc: { type: 'string', format: 'date-time' },
                duration_minutes: { type: 'integer' },
                guest_name: { type: 'string' },
                guest_email: { type: 'string' },
                business: { type: 'string' },
              },
            },
            booking_id: {
              type: ['string', 'null'],
              description: 'Set only when status is `booked`.',
            },
            cancel_url: { type: ['string', 'null'], format: 'uri' },
          },
          ['status'],
        ),
        execute: guarded('upstream_error', async function (args) {
          var email = String(args.guest_email || '').trim();
          var name = String(args.guest_name || '').trim();
          if (!name) return failed('invalid_input', 'guest_name is required.');
          // Deliberately permissive: the backend is the authority on address
          // validity. This only catches "the agent passed a placeholder".
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
            return failed(
              'invalid_input',
              'guest_email must be a real email address the visitor gave you.',
            );
          }
          if (!args.start_utc || !args.booking_type_id) {
            return failed(
              'invalid_input',
              'booking_type_id and start_utc are both required — take ' +
                'start_utc from check_availability.',
            );
          }

          var p = await fetchProfile();

          // ── The confirmation gate ──
          // No network call happens on this branch. An agent that stops here
          // has booked nothing, which is the correct outcome for a visitor who
          // was only browsing times.
          if (args.confirmed !== true) {
            return failed(
              'confirmation_required',
              'Nothing has been booked. Read the summary back to the visitor ' +
                'and call start_booking again with confirmed: true only if ' +
                'they agree.',
              {
                status: 'needs_confirmation',
                summary: {
                  what: String(args.booking_type_id),
                  when_utc: String(args.start_utc),
                  guest_name: name,
                  guest_email: email,
                  business: p.name,
                },
              },
            );
          }

          var res = await fetch(
            api(
              '/lobby/agents/' +
                encodeURIComponent(state.slug) +
                '/booking/bookings',
            ),
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                booking_type_id: args.booking_type_id,
                start_utc: args.start_utc,
                guest_name: name,
                guest_email: email,
                notes: args.notes ? String(args.notes) : undefined,
                source: 'webmcp',
              }),
            },
          );
          if (res.status === 409) {
            return failed(
              'unavailable',
              'That time was taken while you were confirming. Call ' +
                'check_availability again and offer the visitor another slot.',
            );
          }
          if (!res.ok) {
            return failed(
              'upstream_error',
              'The booking could not be completed (HTTP ' + res.status + ').',
            );
          }
          var body = await res.json();
          emit('booking', { booking_id: body.id });
          return ok({
            status: 'booked',
            booking_id: body.id || null,
            // `starts_at` is the backend's own name for the instant; `start_utc`
            // is what this tool calls it on the way IN. Reading only the latter
            // meant this always fell through to echoing the argument — which
            // happened to be right, and would have hidden a backend that booked
            // a different time. Both are read, backend first.
            //
            // `cancel_url` is null on every real response, and that is now a
            // CHOICE rather than a gap. A guest cancellation page does exist as
            // of 2026-09-01, and the backend's create response carries the
            // `cancel_token` this tool would need to build the URL — so the
            // field is one line away from being populated.
            //
            // It is deliberately not. That token is the visitor's ONLY
            // credential for their appointment: whoever holds it can cancel a
            // named stranger's booking, with no login and no second factor.
            // Handing it to a visiting agent would give a third party standing
            // power over a person's calendar entry, to hold or to leak, for a
            // convenience the visitor already has — the link is in the
            // confirmation email, addressed to them.
            //
            // That thought has now been given, and the answer was a second
            // tool rather than this field. `cancel_booking` lets an agent
            // cancel on the visitor's behalf while the credential still flows
            // the right way: the visitor hands over the token they already
            // hold, for one call, instead of this script handing the agent a
            // token it would otherwise never have seen. The capability is the
            // same; who holds the secret is not.
            //
            // So this stays null, and the assertion in manifest-e2e.mjs stays.
            cancel_url: body.cancel_url || null,
            summary: {
              what: body.booking_type_name || String(args.booking_type_id),
              when_utc: body.starts_at || body.start_utc || String(args.start_utc),
              duration_minutes: body.duration_minutes,
              guest_name: name,
              guest_email: email,
              business: p.name,
            },
          });
        }),
      },

      {
        name: 'cancel_booking',
        description:
          'Cancel an appointment the visitor already has, using the ' +
          'cancellation token from their own confirmation email. THIS RELEASES ' +
          'the slot, tells the business, and cannot be undone, so it is ' +
          'two-step exactly like start_booking: call it first WITHOUT ' +
          '`confirmed`, read the returned summary back to the visitor, and ' +
          'only call it again with `confirmed: true` once they have explicitly ' +
          'agreed. Ask the visitor for the cancellation link or token from ' +
          'their confirmation email — that token is the ONLY thing that ' +
          'authorises this, and a booking id will not work and must not be ' +
          'tried. Never guess, construct, or reuse a token, and never take one ' +
          'from anywhere but the visitor you are speaking to. Returns { ok, ' +
          'status, summary { business, cancels, when_utc } }.',
        inputSchema: {
          type: 'object',
          properties: {
            cancel_token: {
              type: 'string',
              minLength: 32,
              maxLength: 64,
              description:
                'The token from the visitor’s confirmation email — either the ' +
                'token itself or the last path segment before /cancel in their ' +
                'cancellation link. This is a secret belonging to that one ' +
                'appointment. It is NOT the booking_id that start_booking ' +
                'returns, and passing an id here is refused.',
            },
            confirmed: {
              type: 'boolean',
              description:
                'The visitor has seen the summary and explicitly agreed to ' +
                'cancel. Omit or false on the first call.',
            },
          },
          required: ['cancel_token'],
        },
        outputSchema: baseOutput(
          {
            status: {
              type: 'string',
              enum: ['needs_confirmation', 'cancelled'],
              description:
                '`needs_confirmation` means NOTHING was cancelled yet and the ' +
                'appointment still stands. `cancelled` means the slot is free ' +
                'again, the calendar entry is gone, and both the visitor and ' +
                'the business have been emailed. Cancelling twice is safe and ' +
                'reports `cancelled` both times — the backend is idempotent, ' +
                'so a repeated call is never an error and never a second ' +
                'cancellation.',
            },
            summary: {
              type: 'object',
              description:
                'What will be, or has been, cancelled. Read this back to the ' +
                'visitor before confirming.',
              properties: {
                business: { type: 'string' },
                cancels: {
                  type: 'string',
                  description:
                    'Plain-language description of the appointment the token ' +
                    'belongs to, for reading aloud.',
                },
                when_utc: {
                  type: ['string', 'null'],
                  format: 'date-time',
                  description:
                    'When the cancelled appointment was to start, as the ' +
                    'backend reports it. NULL before confirmation: nothing ' +
                    'previews a booking by token, so the time is genuinely ' +
                    'not known until the cancellation is made. Do not invent ' +
                    'a time for the visitor on the first call — ask them to ' +
                    'confirm from their own email instead.',
                },
              },
              required: ['business', 'cancels'],
            },
          },
          ['status'],
        ),
        execute: guarded('upstream_error', async function (args) {
          var token = String(args.cancel_token || '').trim();

          if (!token) {
            return failed(
              'invalid_input',
              'A cancellation token is required. Ask the visitor for the ' +
                'cancellation link in their confirmation email.',
            );
          }

          // ── The enumeration guard ──
          // A booking id is a 36-character UUID, so it clears any length test,
          // and it is the value an agent is most likely to have to hand: it is
          // sitting in `start_booking`'s own result from earlier in the same
          // conversation. Accepting it would turn this tool into a way to
          // cancel a stranger's appointment by guessing an identifier instead
          // of holding their secret, which is the one thing it must never be.
          if (
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              token,
            )
          ) {
            return failed(
              'invalid_input',
              'That is a booking id, not a cancellation token. Only the token ' +
                'in the visitor’s own confirmation email can cancel their ' +
                'appointment — ask them for that link.',
            );
          }

          // Mirrors the backend's own guard and the column's CHECK, so a short
          // token is not even a request. Deliberately a length test and not a
          // format test: the token is opaque, and a tool that hardcoded today's
          // hex alphabet would reject a future one.
          if (token.length < 32) {
            return failed(
              'invalid_input',
              'That cancellation link is not valid. Ask the visitor to paste ' +
                'the whole link from their confirmation email.',
            );
          }

          // ── The confirmation gate ──
          // Stricter than start_booking's, which is allowed a profile fetch:
          // this one makes NO network call at all. The profile is already in
          // hand — this tool only exists because it reported booking enabled —
          // and there is no endpoint that previews a booking by token, so
          // there is nothing to ask and asking would only be a probe.
          var profile = state.profileCache || {};
          var business = profile.name || 'this business';

          if (args.confirmed !== true) {
            return failed(
              'confirmation_required',
              'Nothing has been cancelled. Confirm with the visitor that they ' +
                'want to release this appointment, then call cancel_booking ' +
                'again with confirmed: true.',
              {
                status: 'needs_confirmation',
                summary: {
                  business: business,
                  cancels:
                    'the appointment this cancellation link belongs to at ' +
                    business,
                  when_utc: null,
                },
              },
            );
          }

          // Slug-free by design: the token is the entire authorization, so the
          // path names no business. A visitor can therefore cancel from any
          // Lobby page, not only the one they booked on.
          var res = await fetch(
            api('/lobby/bookings/' + encodeURIComponent(token) + '/cancel'),
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
            },
          );

          if (res.status === 404) {
            return failed(
              'invalid_input',
              'That cancellation link is not valid. It may have been mistyped ' +
                '— ask the visitor to paste it again from their confirmation ' +
                'email.',
            );
          }
          if (res.status === 400) {
            return failed(
              'unavailable',
              'That appointment can no longer be cancelled — it has already ' +
                'happened. Offer to contact the business on the visitor’s ' +
                'behalf instead.',
            );
          }
          if (!res.ok) {
            // Anything else, 429 included. Kept distinct from the 404 on
            // purpose: telling a visitor their good link is invalid sends them
            // hunting through their inbox for a second one that does not exist.
            return failed(
              'upstream_error',
              'The cancellation could not be completed just now (HTTP ' +
                res.status +
                '). The appointment still stands. Try again in a moment.',
            );
          }

          var body = await res.json();
          // No token in the event, and no token in the result below. This is
          // the one place it could outlive the call — into a page listener, a
          // transcript, or a model's context.
          emit('cancellation', { when_utc: body.starts_at || null });
          return ok({
            // The backend's own word for what happened, not a constant. The
            // fixture makes a hardcoded 'cancelled' indistinguishable from a
            // real one, which is how `summary.what` and `start_local` both hid.
            status: body.status || 'cancelled',
            summary: {
              business: business,
              cancels: 'the appointment this cancellation link belonged to',
              when_utc: body.starts_at || null,
            },
          });
        }),
      },
    ];
  }

  // ── Product tools (lobby.host itself) ──────────────────────────────────────
  //
  // These are what let an agent complete Lobby's own commercial journey —
  // understand it, pick a plan, start signup — without funnelling every step
  // through `ask_concierge`. The scorecard's "thin coverage" finding was
  // literally this: the only tooled route in the product was the hosted
  // concierge page, so the pricing and signup pages an agent needs in order to
  // become a customer were invisible to it.

  function productTools() {
    return [
      {
        name: 'get_pricing',
        description:
          "Lobby's plans: prices, monthly conversation allowances, what each " +
          'tier includes, and what happens on going over. Authoritative and ' +
          'free — use this rather than reading prices off the page, and rather ' +
          'than asking the concierge. Returns { ok, currency, plans[] of ' +
          '{ id, name, price_monthly, price_annual, monthly_conversations, ' +
          'shows_lobby_badge, includes_booking, features[], signup_url }, ' +
          'overage, what_counts_as_a_conversation }.',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: baseOutput(
          {
            currency: { type: 'string' },
            plans: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', enum: ['free', 'paid'] },
                  name: { type: 'string' },
                  price_monthly: { type: ['number', 'null'] },
                  price_annual: { type: ['number', 'null'] },
                  monthly_conversations: { type: ['integer', 'null'] },
                  shows_lobby_badge: { type: 'boolean' },
                  includes_booking: {
                    type: 'boolean',
                    description:
                      'Whether concierges on this plan can take bookings.',
                  },
                  features: { type: 'array', items: { type: 'string' } },
                  signup_url: { type: 'string', format: 'uri' },
                },
                required: ['id', 'name', 'features'],
              },
            },
            overage: { type: ['string', 'null'] },
            what_counts_as_a_conversation: { type: ['string', 'null'] },
          },
          ['plans', 'currency'],
        ),
        execute: guarded('upstream_error', async function () {
          var d = await fetchProduct();
          return ok({
            currency: d.currency || 'USD',
            plans: d.plans || [],
            overage: d.overage || null,
            what_counts_as_a_conversation: d.conversation_definition || null,
          });
        }),
      },

      {
        name: 'recommend_plan',
        description:
          'Which Lobby plan fits a described business, and why. Deterministic ' +
          '— it compares the stated needs against the published allowances and ' +
          'features, it does not guess. Prefer this over asking the concierge ' +
          '"which plan should I pick", which cannot see the numbers. ' +
          'Returns { ok, recommended_plan_id, recommended_plan_name, ' +
          'price_monthly, reasons[], caveats[], signup_url }.',
        inputSchema: {
          type: 'object',
          properties: {
            expected_monthly_conversations: {
              type: 'integer',
              minimum: 0,
              maximum: 1000000,
              description:
                'Roughly how many visitor sessions a month. One visitor ' +
                'session is one conversation however many messages it holds.',
            },
            number_of_sites: {
              type: 'integer',
              minimum: 1,
              description: 'How many websites need a concierge.',
            },
            needs_own_branding: {
              type: 'boolean',
              description:
                'True when the business wants the "Built with Lobby" footer ' +
                'gone.',
            },
            needs_booking: {
              type: 'boolean',
              description:
                'True when visitors should be able to book an appointment ' +
                'through the concierge.',
            },
          },
        },
        outputSchema: baseOutput(
          {
            recommended_plan_id: { type: 'string', enum: ['free', 'paid'] },
            recommended_plan_name: { type: 'string' },
            price_monthly: { type: ['number', 'null'] },
            reasons: {
              type: 'array',
              items: { type: 'string' },
              description: 'Why this plan, in order of weight.',
            },
            caveats: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Things the visitor should know before committing. May be ' +
                'empty.',
            },
            signup_url: { type: 'string', format: 'uri' },
          },
          ['recommended_plan_id', 'recommended_plan_name', 'reasons', 'signup_url'],
        ),
        execute: guarded('upstream_error', async function (args) {
          var d = await fetchProduct();
          var plans = d.plans || [];
          var free = plans.filter(function (p) { return p.id === 'free'; })[0];
          var paid = plans.filter(function (p) { return p.id === 'paid'; })[0];
          if (!free || !paid) {
            return failed('upstream_error', 'Plan information is incomplete.');
          }

          var reasons = [];
          var caveats = [];
          var choose = free;

          var volume = args.expected_monthly_conversations;
          if (typeof volume === 'number' && volume >= 0) {
            if (free.monthly_conversations != null && volume > free.monthly_conversations) {
              choose = paid;
              reasons.push(
                'About ' + volume + ' conversations a month is past the free ' +
                  'allowance of ' + free.monthly_conversations + '.',
              );
            } else {
              reasons.push(
                'About ' + volume + ' conversations a month fits inside the ' +
                  'free allowance of ' + free.monthly_conversations + '.',
              );
            }
            if (paid.monthly_conversations != null && volume > paid.monthly_conversations) {
              caveats.push(
                'That volume is also past the paid allowance of ' +
                  paid.monthly_conversations + ' — extra conversation packs ' +
                  'cover the difference.',
              );
            }
          }

          if (args.needs_own_branding === true) {
            choose = paid;
            reasons.push('Removing the "Built with Lobby" footer is a paid-plan feature.');
          }
          if (args.needs_booking === true) {
            choose = paid;
            reasons.push('Taking bookings through the concierge is a paid-plan feature.');
          }
          if (typeof args.number_of_sites === 'number' && args.number_of_sites > 1) {
            caveats.push(
              'A plan covers one concierge. ' + args.number_of_sites +
                ' sites means one concierge each — check with Lobby about ' +
                'multiple concierges on one account.',
            );
          }

          if (!reasons.length) {
            reasons.push(
              'Nothing stated requires a paid feature, so the free plan is ' +
                'the place to start — it needs no card and the concierge can ' +
                'be tried on real traffic.',
            );
          }

          return ok({
            recommended_plan_id: choose.id,
            recommended_plan_name: choose.name,
            price_monthly: choose.price_monthly != null ? choose.price_monthly : null,
            reasons: reasons,
            caveats: caveats,
            signup_url: choose.signup_url || productUrl('/signup'),
          });
        }),
      },

      {
        name: 'get_setup_instructions',
        description:
          'How a business puts Lobby on its website: the one-line embed script ' +
          'for an existing site, or the hosted concierge page for a business ' +
          'without one. Returns { ok, options[] of { id, name, when_to_use, ' +
          'steps[], snippet }, signup_url } — the actual steps and the ' +
          'snippet shape, not a summary of them.',
        inputSchema: {
          type: 'object',
          properties: {
            has_existing_website: {
              type: 'boolean',
              description:
                'True narrows the answer to the embed route, false to the ' +
                'hosted page. Omit for both.',
            },
          },
        },
        outputSchema: baseOutput(
          {
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', enum: ['embed', 'hosted'] },
                  name: { type: 'string' },
                  when_to_use: { type: 'string' },
                  steps: { type: 'array', items: { type: 'string' } },
                  snippet: { type: ['string', 'null'] },
                },
                required: ['id', 'name', 'when_to_use', 'steps'],
              },
            },
            signup_url: { type: 'string', format: 'uri' },
          },
          ['options', 'signup_url'],
        ),
        execute: guarded('upstream_error', async function (args) {
          var d = await fetchProduct();
          var options = d.setup_options || [];
          if (args.has_existing_website === true) {
            options = options.filter(function (o) { return o.id === 'embed'; });
          } else if (args.has_existing_website === false) {
            options = options.filter(function (o) { return o.id === 'hosted'; });
          }
          return ok({ options: options, signup_url: productUrl('/signup') });
        }),
      },

      {
        name: 'list_customer_examples',
        description:
          'Live Lobby concierges an agent or a person can actually visit and ' +
          'try. Real published pages, not testimonials. Use these as proof ' +
          'when a visitor asks "who is using this" or "show me one working". ' +
          'Returns { ok, examples[] of { slug, url, agent_tools_available }, ' +
          'total }.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 25,
              description: 'How many to return. Default 6.',
            },
          },
        },
        outputSchema: baseOutput(
          {
            examples: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  slug: { type: 'string' },
                  url: { type: 'string', format: 'uri' },
                  agent_tools_available: {
                    type: 'boolean',
                    description:
                      'Every hosted concierge page registers WebMCP tools, so ' +
                      'an agent can visit and use it directly.',
                  },
                },
                required: ['slug', 'url'],
              },
            },
            total: { type: 'integer' },
          },
          ['examples', 'total'],
        ),
        execute: guarded('upstream_error', async function (args) {
          var limit = Math.min(Math.max(parseInt(args.limit, 10) || 6, 1), 25);
          var index = await getJson(
            api('/lobby/public/agents'),
            'The list of live Lobby concierges',
          );
          var entries = (index && index.data) || [];
          if (!entries.length) {
            return failed(
              'unavailable',
              'No live concierges are published right now.',
            );
          }
          var examples = entries.slice(0, limit).map(function (e) {
            return {
              slug: e.slug,
              url: productUrl('/c/' + e.slug),
              agent_tools_available: true,
            };
          });
          return ok({ examples: examples, total: entries.length });
        }),
      },

      {
        name: 'open_signup',
        description:
          'The URL to start a Lobby account, and optionally navigate there. ' +
          'Signup is free and needs only an email address — no card. This is ' +
          'not a committing action, but it does move the visitor off the ' +
          'current page when `navigate` is true, so prefer returning the URL ' +
          'and letting them click unless they asked to be taken there. ' +
          'Returns { ok, url, navigated, requirements[] }.',
        inputSchema: {
          type: 'object',
          properties: {
            plan: {
              type: 'string',
              enum: ['free', 'paid'],
              description: 'Which plan to start on. Default free.',
            },
            navigate: {
              type: 'boolean',
              description:
                'When true, navigate this page to signup. Default false — ' +
                'navigating away ends the current conversation.',
            },
          },
        },
        outputSchema: baseOutput(
          {
            url: { type: 'string', format: 'uri' },
            navigated: { type: 'boolean' },
            requirements: {
              type: 'array',
              items: { type: 'string' },
              description: 'What the visitor needs in order to sign up.',
            },
          },
          ['url', 'navigated'],
        ),
        execute: guarded('upstream_error', async function (args) {
          var url = productUrl('/signup');
          if (args.plan === 'paid') url += '?plan=paid';
          var navigated = false;
          if (args.navigate === true && typeof global.location !== 'undefined') {
            try {
              global.location.assign(url);
              navigated = true;
            } catch (_) {
              /* blocked by the host — the URL is still useful */
            }
          }
          return ok({
            url: url,
            navigated: navigated,
            requirements: [
              'An email address.',
              'No payment card for the free plan.',
              'Your website URL, or a description of the business if there is no site yet.',
            ],
          });
        }),
      },
    ];
  }

  // ── Which tools belong on this page ────────────────────────────────────────

  /**
   * Route → surface, for lobby.host's own pages.
   *
   * Deliberately explicit rather than "register everything everywhere".
   * Repeating one identical tool set on every route would raise the mechanical
   * coverage number while making the surface less useful: an agent on /pricing
   * wants the pricing tools, and an agent on a hosted concierge page has no use
   * for Lobby's signup flow. The one overlap that IS meaningful is the
   * homepage, which genuinely runs both a live concierge and the product story.
   */
  function surfaceForPath(pathname) {
    var path = String(pathname || '/').replace(/\/+$/, '') || '/';
    if (/^\/c\/[^/]+/.test(path)) return 'concierge';
    if (path === '/') return 'both';
    if (/^\/(pricing|signup|login|onboarding|privacy|terms)$/.test(path)) {
      return 'product';
    }
    return null; // unknown route — caller decides
  }

  function toolsForSurface(surface) {
    var tools = [];
    if (surface === 'concierge' || surface === 'both') {
      tools = tools.concat(conciergeTools());
      // Capability-gated. `state.capabilities` is populated by fetchProfile,
      // which init() awaits before registering whenever a slug is present, so
      // booking tools appear in the FIRST tool list an agent sees rather than
      // materialising after a lookup it may never make.
      if (state.capabilities && state.capabilities.booking) {
        tools = tools.concat(bookingTools());
      }
    }
    if (surface === 'product' || surface === 'both') {
      tools = tools.concat(productTools());
    }
    return tools;
  }

  // ── WebMCP registration ────────────────────────────────────────────────────

  /**
   * Find the Model Context surface.
   *
   * The proposal has moved: current drafts centre on `document.modelContext`
   * while earlier examples and some shipping hosts expose
   * `navigator.modelContext`. Both are checked, and the whole question is
   * confined to this function so the tool definitions above never have to know
   * which era of the API they are running against.
   */
  function modelContext() {
    if (typeof document !== 'undefined' && document.modelContext) {
      return document.modelContext;
    }
    if (typeof navigator !== 'undefined' && navigator.modelContext) {
      return navigator.modelContext;
    }
    return null;
  }

  /** A copy of the tool without `outputSchema`, for hosts that reject it. */
  function withoutOutputSchema(tool) {
    var copy = {};
    for (var k in tool) {
      if (Object.prototype.hasOwnProperty.call(tool, k) && k !== 'outputSchema') {
        copy[k] = tool[k];
      }
    }
    return copy;
  }

  /**
   * Register, degrading rather than failing.
   *
   * Output schemas are the least settled part of the proposal, so a host that
   * rejects an unknown key must not cost us the tool itself: each registration
   * is retried once without `outputSchema`. The structured object still reaches
   * the agent as JSON in `content`, so a downgraded tool loses its declared
   * contract, not its usefulness.
   */
  function register(tools) {
    var ctx = modelContext();
    if (!ctx) {
      // No agent host on this page. Tools stay reachable for the demo UI and
      // for debugging via `LobbyWebMCP.tools`.
      emit('unavailable', {});
      return false;
    }

    var degraded = [];

    if (typeof ctx.registerTool === 'function') {
      for (var i = 0; i < tools.length; i++) {
        try {
          ctx.registerTool(tools[i]);
        } catch (_) {
          try {
            ctx.registerTool(withoutOutputSchema(tools[i]));
            degraded.push(tools[i].name);
          } catch (_e) {
            continue; // this host will not take this tool at all
          }
        }
        state.registered.push(tools[i].name);
      }
    } else if (typeof ctx.provideContext === 'function') {
      try {
        ctx.provideContext({ tools: tools });
      } catch (_) {
        ctx.provideContext({ tools: tools.map(withoutOutputSchema) });
        degraded = tools.map(function (t) { return t.name; });
      }
      state.registered = tools.map(function (t) { return t.name; });
    } else {
      emit('unavailable', {});
      return false;
    }

    emit('registered', {
      tools: state.registered.slice(),
      output_schemas_accepted: degraded.length === 0,
      degraded: degraded,
    });
    return state.registered.length > 0;
  }

  // ── Public entry ───────────────────────────────────────────────────────────

  var LobbyWebMCP = {
    /** The tools registered on this page (also usable directly by the demo). */
    tools: [],

    /** True when a WebMCP host accepted the registration. */
    active: false,

    /** Which tool set(s) this page exposes. */
    surface: null,

    /** What this concierge can do, once the profile has been read. */
    capabilities: null,

    /**
     * Compose and register the tools for this page.
     *
     * Returns a promise, because a concierge's capabilities are a property of
     * the business rather than of the script and have to be read before the
     * tool list is final. Callers that do not care can ignore it — the previous
     * synchronous contract (`LobbyWebMCP.init({slug}).tools`) still holds for
     * the product surface and for the three original concierge tools.
     */
    init: function (options) {
      options = options || {};
      state.slug = options.slug || state.slug;
      state.apiBase = options.apiBase || state.apiBase;
      state.productBase = options.productBase || state.productBase;

      var surface = options.surface || null;
      if (
        surface &&
        surface !== AUTO_SURFACE &&
        SURFACES.indexOf(surface) === -1
      ) {
        throw new Error(
          'lobby-webmcp: surface must be one of ' +
            SURFACES.concat([AUTO_SURFACE]).join(', ') +
            '.',
        );
      }
      if (surface === AUTO_SURFACE) {
        surface =
          typeof global.location !== 'undefined'
            ? surfaceForPath(global.location.pathname)
            : null;
      }
      // A bare slug is a concierge. See AUTO_SURFACE above for why this is not
      // path detection.
      if (!surface) surface = state.slug ? 'concierge' : 'product';
      if (surface !== 'product' && !state.slug) {
        throw new Error(
          'lobby-webmcp: a concierge slug is required for the "' + surface +
            '" surface (data-lobby-slug attribute or init({ slug })).',
        );
      }
      state.surface = surface;
      this.surface = surface;

      var self = this;

      // Synchronous first pass so `.tools` is populated immediately and a host
      // that reads it during script evaluation is not handed an empty list.
      self.tools = toolsForSurface(surface);
      self.active = register(self.tools);

      if (surface === 'product' || !state.slug) {
        self.capabilities = state.capabilities;
        return Promise.resolve(self);
      }

      // Then read the profile and add any capability-gated tools. A concierge
      // with booking configured gets its booking tools here; one without gets
      // nothing extra, and the failure of this read never costs the page its
      // core tools.
      return fetchProfile()
        .then(function () {
          self.capabilities = state.capabilities;
          if (!state.capabilities.booking) return self;
          var extra = bookingTools().filter(function (t) {
            return state.registered.indexOf(t.name) === -1;
          });
          if (extra.length) {
            register(extra);
            self.tools = self.tools.concat(extra);
            self.active = self.active || state.registered.length > 0;
          }
          return self;
        })
        .catch(function () {
          // Profile unreadable: the concierge tools already registered will
          // report the failure themselves when called. Nothing to add.
          self.capabilities = state.capabilities;
          return self;
        });
    },

    /** Exposed for tests and for the demo page. */
    _internals: {
      surfaceForPath: surfaceForPath,
      toolsForSurface: toolsForSurface,
      capabilitiesFrom: capabilitiesFrom,
      toOffering: toOffering,
      state: state,
    },
  };

  // Auto-init from the script tag:
  //   <script ... data-lobby-slug="arenna">
  //   <script ... data-lobby-surface="product">
  // `document.currentScript` is null for module scripts and some injection
  // paths, so fall back to finding our own tag by its data attributes.
  if (typeof document !== 'undefined') {
    var tag =
      document.currentScript ||
      document.querySelector('script[data-lobby-slug]') ||
      document.querySelector('script[data-lobby-surface]');
    var ds = (tag && tag.dataset) || {};
    if (ds.lobbySlug || ds.lobbySurface) {
      LobbyWebMCP.init({
        slug: ds.lobbySlug,
        surface: ds.lobbySurface,
        apiBase: ds.lobbyApiBase,
        productBase: ds.lobbyProductBase,
      });
    }
  }

  global.LobbyWebMCP = LobbyWebMCP;
})(typeof window !== 'undefined' ? window : globalThis);
