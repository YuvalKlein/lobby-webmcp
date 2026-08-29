/**
 * Smoke test: loads the browser script in a minimal fake-DOM environment,
 * registers against a stub modelContext, and exercises all three tools
 * against the real Lobby public API.
 *
 * Run: node test/smoke.mjs [slug]
 * A slug argument avoids spending a conversation on the default concierge.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const slug = process.argv[2] || 'arenna';
const askToo = process.argv.includes('--ask');

// Minimal WebMCP host stub. Node's global `navigator` is getter-only, so
// override via defineProperty.
const registered = [];
Object.defineProperty(globalThis, 'navigator', {
  value: { modelContext: { registerTool: (t) => registered.push(t) } },
  configurable: true,
});
globalThis.window = globalThis;
globalThis.document = undefined;
globalThis.dispatchEvent = () => {};
globalThis.CustomEvent = class { constructor(name, opts) { this.name = name; this.detail = opts?.detail; } };

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/lobby-webmcp.js'),
  'utf8',
);
new Function(src)();

globalThis.LobbyWebMCP.init({ slug });

if (registered.length !== 3) {
  throw new Error(`expected 3 registered tools, got ${registered.length}`);
}
console.log('registered:', registered.map((t) => t.name).join(', '));

const byName = Object.fromEntries(registered.map((t) => [t.name, t]));

const info = await byName.get_business_info.execute({});
console.log('\nget_business_info →\n', info.content[0].text);

const offerings = await byName.list_offerings.execute({});
console.log('\nlist_offerings →\n', offerings.content[0].text.slice(0, 400));

if (askToo) {
  const answer = await byName.ask_concierge.execute({
    question: 'In one sentence, what does this business do?',
  });
  console.log('\nask_concierge →\n', answer.content[0].text);
} else {
  console.log('\n(ask_concierge skipped — pass --ask to spend a conversation)');
}
console.log('\nSMOKE OK');
