# lobby-webmcp

**One concierge, two doors: WebMCP tools for any [Lobby](https://lobby.host) concierge.**

Lobby gives a business an AI concierge on its website — a chat (and voice)
widget that knows the business and speaks with its guests. This repository is
the second door: a zero-dependency script that registers the **same
concierge** as structured [WebMCP](https://webmachinelearning.github.io/webmcp/)
tools, so a visiting agent — ChatGPT's in-app browser, Chrome with WebMCP
enabled — can do whatever a human guest can do.

Whatever a guest can ask through the widget, an agent can ask through the
tools. Same backend, same knowledge, same conversation engine.

Because the script keys off a concierge **slug**, one integration makes every
business that installs Lobby agent-accessible without writing a line of code.

## Live demo

**https://lobby.host/c/arenna** — open it in ChatGPT's in-app browser or
Chrome with WebMCP enabled and ask the agent about the business. It will use
the registered tools instead of scraping the page.

## The tools

Two sets, composed per page. A business's own site gets the concierge set;
lobby.host's marketing pages get the product set; lobby.host's homepage gets
both, because it genuinely is both — a live concierge and the product story.

### Concierge — one business (needs a slug)

| Tool | What it does | Cost |
|---|---|---|
| `ask_concierge` | Ask anything a guest could ask. Keeps conversation context across calls, so follow-ups work. | Starts a real concierge conversation |
| `get_business_info` | Structured public facts: name, introduction, contact, suggested topics, and whether booking is possible. | Free, instant |
| `list_offerings` | The business's services as structured data, each with an explicit `bookable` flag. | Free, instant |

### Booking — only where the business configured it

| Tool | What it does |
|---|---|
| `get_booking_options` | What can be booked, and for how long. |
| `check_availability` | Real openings for one booking type: published hours minus what is already on the calendar. |
| `start_booking` | Books a slot. **Two-step by construction** — see below. |

### Product — lobby.host itself

| Tool | What it does |
|---|---|
| `get_pricing` | Plans, prices, allowances, overage. Read live from the site, never hardcoded here. |
| `recommend_plan` | Which plan fits a described business, with reasons. Deterministic, not a guess. |
| `get_setup_instructions` | Embed script or hosted page, with the actual steps. |
| `list_customer_examples` | Live concierges an agent can go and try. |
| `open_signup` | The signup URL, and optionally navigate there. |

## Design rules

Three rules do most of the work, and each exists because breaking it cost us
something measurable.

**A capability the business has not configured produces no tool.** A concierge
without booking exposes no booking tool — not a booking tool that returns
"sorry". An agent's tool list is a promise, and a tool that fails is worse than
an absent one. The WebMCP directory's evaluator docked Lobby's first version for
exactly this: the homepage said "I can book that for you right now" and no tool
could book anything.

**Every tool declares its result shape.** `outputSchema` on all of them, and a
single envelope — `{ ok, error: { code, message }, ...payload }` — so failure is
data an agent can branch on rather than prose it has to interpret. Output
schemas are the least settled part of the proposal, so registration retries
once without the key if a host rejects it: a tool loses its declared contract
rather than its existence.

**The one committing action cannot commit by accident.** `start_booking` called
without `confirmed: true` makes no network call at all and returns the summary
the visitor must agree to. Confirmation is a required second call, not a flag
an agent can set on the first.

## Use it on any page

```html
<script src="lobby-webmcp.js" data-lobby-slug="your-concierge-slug"></script>
```

or programmatically:

```html
<script src="lobby-webmcp.js"></script>
<script>
  LobbyWebMCP.init({ slug: 'your-concierge-slug' });
</script>
```

A bare slug means the concierge set, always. The surface is never inferred from
the URL unless you ask for it with `data-lobby-surface="auto"` — otherwise a
customer whose concierge sits on their homepage would have `/` read as
lobby.host's homepage and start serving Lobby's own pricing tools to their
visitors. Explicit values are `concierge`, `product` and `both`.

`init()` returns a promise. It registers synchronously so `.tools` is populated
immediately, then reads the concierge's profile and adds any capability-gated
tools. Await it if you need the final list.

Any **live** Lobby concierge slug works (create one at
[lobby.host](https://lobby.host)). No API key — the script talks to Lobby's
public, unauthenticated concierge API, the same one the widget uses.

### Page integration events

The host page can surface the agent's conversation to the human sitting at
the same page:

```js
window.addEventListener('lobby-webmcp:exchange', (e) => {
  // e.detail = { conversation_id, question, reply }
});
```

Also emitted: `lobby-webmcp:registered`, `lobby-webmcp:conversation`,
`lobby-webmcp:unavailable`.

## Try it without an agent

Open [`demo/index.html`](demo/index.html) — it loads the script, reports
whether a WebMCP host is present, and gives you buttons to invoke each tool
by hand against any slug.

## How it works

- `get_business_info` / `list_offerings` → `GET /lobby/agents/:slug/public`
  (cached per page load). The same call yields the capability flags.
- `ask_concierge` → lazily `POST /lobby/agents/:slug/conversations` once per
  page session, then `POST /lobby/conversations/:id/messages`, accumulating
  the SSE `token` events into a complete reply.
- Booking tools → `GET|POST /lobby/agents/:slug/booking/*`.
- Product tools → `GET <site>/webmcp/product.json`, served by lobby-web from
  its own pricing content, so an agent and a person are never quoted different
  numbers. The one exception is `list_customer_examples`, which reads
  `GET /lobby/public/agents`.
- Registration prefers `document.modelContext` (current drafts) and falls back
  to `navigator.modelContext`, and to `provideContext()` where hosts differ.

## Tests

```
npm test              # contract tests + manifest end-to-end, both offline
npm run test:smoke    # against the live API; --ask spends a conversation
```

`test/contract.mjs` asserts what the directory actually grades: every tool has a
description, an input schema and an output schema; a concierge without booking
registers no booking tool; the four evaluation journeys complete through typed
tools without falling back to `ask_concierge`; and `start_booking` refuses to
commit unconfirmed.

`test/manifest-e2e.mjs` feeds the real other side to the real tools — lobby-web's
`product.json` output, and the backend's booking contract — so a shape drift
between repos fails a test rather than a rescan.

**Every fixture standing in for another service is captured, never written.**
That rule is the outcome of 1 Sep 2026, when the availability endpoint and
`check_availability` disagreed on two fields in production while all 28 contract
tests passed: the fixture had been hand-written to match the tool's own output
schema, so the fixture and the tools agreed with each other and neither had ever
seen the endpoint. The booking bodies now come from a captured slice of the
backend's OpenAPI spec (`test/fixtures-openapi-booking.json`, refreshed by
`node test/extract-booking-schema.mjs`) via `test/backend-shapes.mjs`, and the
profile is a real `GET /lobby/agents/hello/public` response.

`npm run test:smoke` hits the live API and is deliberately out of CI — a backend
blip should not fail an unrelated PR. Its assertions look at FIELDS, not just at
whether an array came back; that was the other half of why the same two defects
survived a live smoke run.

## Prior work vs. challenge work

This repo was built for the [OpenAI WebMCP Challenge](https://webmcp.devpost.com/)
(submission period Aug 25 – Sep 3, 2026).

- **Pre-existing:** the Lobby platform itself — the concierge product at
  lobby.host, its backend and public API, and its embeddable widget. That
  platform predates the challenge and is not part of this repository.
- **New, built during the submission period:** everything in this repository —
  the WebMCP tool layer, the demo page, and the wiring that loads this layer
  on Lobby's hosted concierge pages. The commit history of this repo is the
  boundary.

## License

[MIT](LICENSE)
