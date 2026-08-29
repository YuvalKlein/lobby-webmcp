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

| Tool | What it does | Cost |
|---|---|---|
| `ask_concierge` | Ask anything a guest could ask. Keeps conversation context across calls, so follow-ups work. | Starts a real concierge conversation |
| `get_business_info` | Structured public facts: name, introduction, contact, suggested topics. | Free, instant |
| `list_offerings` | The business's services as structured data — comparable, filterable. | Free, instant |

Design principle: the tools expose **exactly what the human-facing concierge
exposes, nothing more**. `ask_concierge` goes through the same conversation
engine (including the business's tone and boundary rules); the two lookup
tools return only the public profile that already renders on the hosted page.

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
  (cached per page load).
- `ask_concierge` → lazily `POST /lobby/agents/:slug/conversations` once per
  page session, then `POST /lobby/conversations/:id/messages`, accumulating
  the SSE `token` events into a complete reply.
- Registration prefers `navigator.modelContext.registerTool()` and falls back
  to `document.modelContext` / `provideContext()` where hosts differ.

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
