/*!
 * lobby-webmcp — WebMCP tools for any Lobby concierge.
 *
 * Lobby (https://lobby.host) gives a business an AI concierge on its website.
 * This script is the second door: it registers the same concierge as
 * structured WebMCP tools, so a visiting agent (ChatGPT's in-app browser,
 * Chrome with WebMCP enabled) can do whatever a human guest can do —
 * ask questions, read the business's facts, browse its offerings.
 *
 * Zero dependencies, no build step. Works against Lobby's public,
 * unauthenticated concierge API for any live concierge slug.
 *
 * Usage (script tag):
 *   <script src="lobby-webmcp.js" data-lobby-slug="arenna"></script>
 *
 * Usage (programmatic):
 *   LobbyWebMCP.init({ slug: 'arenna' });
 *
 * License: MIT
 */
(function (global) {
  'use strict';

  var DEFAULT_API_BASE =
    'https://unitism-backend-production.up.railway.app/api/v1';

  // ── State ──────────────────────────────────────────────────────────────────

  var state = {
    slug: null,
    apiBase: DEFAULT_API_BASE,
    conversationId: null, // one conversation per page session, lazily created
    profileCache: null, // GET agents/:slug/public, cached per page load
    registered: [],
  };

  // ── Lobby public API (see unitism-backend API_GUIDE.md) ───────────────────

  function api(path) {
    return state.apiBase.replace(/\/$/, '') + path;
  }

  /** Public-safe concierge profile: name, intro, services, contact, intents. */
  async function fetchProfile() {
    if (state.profileCache) return state.profileCache;
    var res = await fetch(
      api('/lobby/agents/' + encodeURIComponent(state.slug) + '/public'),
    );
    if (!res.ok) {
      throw new Error(
        'Lobby concierge "' + state.slug + '" unavailable (' + res.status + ')',
      );
    }
    state.profileCache = await res.json();
    return state.profileCache;
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

  // ── The tools ──────────────────────────────────────────────────────────────

  function buildTools() {
    return [
      {
        name: 'ask_concierge',
        description:
          "Ask this business's concierge anything a guest could ask — " +
          'hours, services, pricing, booking, policies, recommendations. ' +
          'Replies come from the same knowledge and conversation engine the ' +
          'human-facing chat on this page uses. The conversation keeps ' +
          'context across calls, so follow-up questions work.',
        inputSchema: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: "The visitor's question, in natural language.",
            },
          },
          required: ['question'],
        },
        execute: async function (args) {
          var result = await sendMessage(String(args.question));
          return {
            content: [{ type: 'text', text: result.reply }],
          };
        },
      },
      {
        name: 'get_business_info',
        description:
          'Structured public facts about this business: name, introduction, ' +
          'contact details, and suggested topics. Free, instant, no ' +
          'conversation started — prefer this for simple lookups before ' +
          'asking the concierge.',
        inputSchema: { type: 'object', properties: {} },
        execute: async function () {
          var p = await fetchProfile();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    name: p.name,
                    introduction: p.intro_message,
                    contact: p.contact,
                    suggested_topics: p.suggested_intents,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        },
      },
      {
        name: 'list_offerings',
        description:
          'The services this business offers, as structured data an agent ' +
          'can compare, filter, or present. Free and instant.',
        inputSchema: { type: 'object', properties: {} },
        execute: async function () {
          var p = await fetchProfile();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ services: p.services || [] }, null, 2),
              },
            ],
          };
        },
      },
    ];
  }

  // ── WebMCP registration ────────────────────────────────────────────────────

  /**
   * Find the Model Context surface. The proposal exposes
   * `navigator.modelContext`; some hosts expose `document.modelContext`.
   * Support both, prefer the spec'd one.
   */
  function modelContext() {
    if (typeof navigator !== 'undefined' && navigator.modelContext) {
      return navigator.modelContext;
    }
    if (typeof document !== 'undefined' && document.modelContext) {
      return document.modelContext;
    }
    return null;
  }

  function register(tools) {
    var ctx = modelContext();
    if (!ctx) {
      // No agent host on this page. Tools stay reachable for the demo UI
      // and for debugging via `LobbyWebMCP.tools`.
      emit('unavailable', {});
      return false;
    }
    if (typeof ctx.registerTool === 'function') {
      for (var i = 0; i < tools.length; i++) {
        ctx.registerTool(tools[i]);
        state.registered.push(tools[i].name);
      }
    } else if (typeof ctx.provideContext === 'function') {
      ctx.provideContext({ tools: tools });
      state.registered = tools.map(function (t) {
        return t.name;
      });
    } else {
      emit('unavailable', {});
      return false;
    }
    emit('registered', { tools: state.registered.slice() });
    return true;
  }

  // ── Public entry ───────────────────────────────────────────────────────────

  var LobbyWebMCP = {
    /** The tools (also usable directly, e.g. by the demo page). */
    tools: [],

    /** True when a WebMCP host accepted the registration. */
    active: false,

    init: function (options) {
      options = options || {};
      state.slug = options.slug || state.slug;
      state.apiBase = options.apiBase || state.apiBase;
      if (!state.slug) {
        throw new Error(
          'lobby-webmcp: a concierge slug is required ' +
            '(data-lobby-slug attribute or init({ slug })).',
        );
      }
      this.tools = buildTools();
      this.active = register(this.tools);
      return this;
    },
  };

  // Auto-init from the script tag: <script ... data-lobby-slug="arenna">.
  // `document.currentScript` is null for module scripts and some injection
  // paths, so fall back to finding our own tag by its data attribute.
  if (typeof document !== 'undefined') {
    var tag =
      document.currentScript ||
      document.querySelector('script[data-lobby-slug]');
    var ds = (tag && tag.dataset) || {};
    if (ds.lobbySlug) {
      LobbyWebMCP.init({ slug: ds.lobbySlug, apiBase: ds.lobbyApiBase });
    }
  }

  global.LobbyWebMCP = LobbyWebMCP;
})(typeof window !== 'undefined' ? window : globalThis);
