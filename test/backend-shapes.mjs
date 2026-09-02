/**
 * Response bodies for the booking endpoints, built from the BACKEND's schema.
 *
 * Shared by `contract.mjs` (offline, exhaustive) and `manifest-e2e.mjs` (the
 * cross-repo agreement), so both stub the backend from one source and that
 * source is the backend's own published spec — a slice of `unitism-backend`'s
 * `openapi.json`, refreshed by `extract-booking-schema.mjs`.
 *
 * ## Why this file exists at all
 *
 * `contract.mjs` used to declare its own `AVAILABILITY` const, typed out by hand
 * to match `check_availability`'s outputSchema: a top-level `timezone`, and
 * `start_local` on every slot. The real endpoint sent neither — no `timezone`,
 * and `display` instead of `start_local` — so an agent was told an
 * `Asia/Jerusalem` business runs on UTC and read `undefined` off every slot, in
 * production, with 28 contract tests green. The fixture and the tools agreed
 * with each other because the same understanding wrote both.
 *
 * **Every key here comes from the spec; only the values are invented.** That is
 * the whole point: a hand-typed payload is a statement about what we believe the
 * other side sends, and this is the one contract in the product with no shared
 * type and no compiler to check that belief.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BOOKING_SPEC = JSON.parse(
  readFileSync(join(HERE, 'fixtures-openapi-booking.json'), 'utf8'),
);

/** `$ref` → the schema it names, within the captured slice. */
function deref(node) {
  if (!node?.$ref) return node;
  const name = node.$ref.split('/').pop();
  const found = BOOKING_SPEC.components.schemas[name];
  if (!found) throw new Error(`fixture has no schema ${name} — re-extract it`);
  return found;
}

/**
 * A response body shaped by `schema`.
 *
 * Arrays get two items, so a test can tell "the list came through" from "the
 * first element came through". `hint` is the property name, used only to make a
 * few values realistic enough that the tools' own input validation passes.
 */
export function fromSchema(node, hint = '') {
  const schema = deref(node);
  if (schema.type === 'array') {
    return [fromSchema(schema.items, hint), fromSchema(schema.items, hint)];
  }
  if (schema.type === 'integer' || schema.type === 'number') return 15;
  if (schema.type === 'boolean') return true;
  if (schema.type === 'object' || schema.properties) {
    const out = {};
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
      out[key] = fromSchema(prop, key);
    }
    return out;
  }
  if (hint === 'timezone') return 'Asia/Jerusalem';
  if (hint === 'start_utc' || hint === 'starts_at') return '2026-09-08T12:00:00.000Z';
  if (hint === 'end_utc' || hint === 'ends_at') return '2026-09-08T12:15:00.000Z';
  if (hint === 'start_local') return 'Tue, Sep 8, 3:00 PM';
  if (hint === 'status') return 'confirmed';
  // 48 hex characters, the shape `randomBytes(24).toString('hex')` produces and
  // the `length >= 32` CHECK on the column enforces. The generic `stub-<hint>`
  // was 17 characters, so `cancel_booking` refused it as too short and the
  // cancellation leg of the e2e failed for a reason that was purely about this
  // file — which is worth a hint rather than a weaker guard.
  if (hint === 'cancel_token') return 'a1b2c3d4e5f6'.repeat(4);
  if (hint === 'guest_email') return 'guest@example.test';
  if (hint === 'currency') return 'ILS';
  if (hint === 'price') return '0.00';
  return `stub-${hint || 'string'}`;
}

const responseSchema = (path, method) =>
  BOOKING_SPEC.paths[path][method].responses['200'].content['application/json']
    .schema;

export const OPTIONS_BODY = fromSchema(
  responseSchema('/lobby/agents/{slug}/booking/options', 'get'),
);
export const AVAILABILITY_BODY = fromSchema(
  responseSchema('/lobby/agents/{slug}/booking/availability', 'get'),
);
export const BOOKING_BODY = fromSchema(
  responseSchema('/lobby/agents/{slug}/booking/bookings', 'post'),
);

/**
 * Set realistic values on a spec-shaped body WITHOUT letting an override
 * invent a key.
 *
 * `fromSchema`'s value hints are keyed on the property name alone, so `status`
 * gets `'confirmed'` everywhere — right for a created booking, wrong for a
 * cancelled one. Overriding the value is fine (this file's whole contract is
 * "every KEY is the backend's, values are invented"), but a plain spread would
 * also happily ADD `status` back if the backend renamed it, which is the one
 * failure this file exists to catch. So an override for a key the schema does
 * not declare is an error, not a merge.
 */
function withValues(node, values) {
  const body = fromSchema(node);
  for (const [key, value] of Object.entries(values)) {
    if (!(key in body)) {
      throw new Error(
        `cannot override ${key}: the captured schema does not declare it — ` +
          're-extract the fixture, and check whether the backend renamed it',
      );
    }
    body[key] = value;
  }
  return body;
}

/**
 * The guest cancellation response.
 *
 * `status` is overridden because the shared hint says `'confirmed'`, and a
 * cancellation that reports `confirmed` would let the tool hardcode
 * `'cancelled'` and still pass — hiding exactly the echo-the-argument defect
 * that `summary.what` and `start_local` both were.
 */
export const CANCELLED_BODY = withValues(
  responseSchema('/lobby/bookings/{cancelToken}/cancel', 'post'),
  { status: 'cancelled' },
);

/** Field names the backend declares, for a test that wants to name one. */
export const declaredKeys = (schemaName) =>
  Object.keys(BOOKING_SPEC.components.schemas[schemaName].properties ?? {});

/**
 * Validate a value against a tool's OWN declared `outputSchema`.
 *
 * Shallow on purpose — required keys, declared types, one level into array
 * items. A full JSON Schema validator would be a dependency for a repo that
 * deliberately has none, and every drift found so far was a missing or renamed
 * field at the top level or one step in.
 */
export function validateAgainstOutputSchema(tool, value, at = tool.name) {
  const problems = [];
  const walk = (schema, v, path) => {
    if (!schema || v === undefined) return;
    for (const key of schema.required ?? []) {
      if (v[key] === undefined) problems.push(`${path}.${key} is required and missing`);
    }
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
      const child = v[key];
      if (child === undefined || child === null) continue;
      if (prop.type === 'array') {
        if (!Array.isArray(child)) { problems.push(`${path}.${key} should be an array`); continue; }
        for (const [i, item] of child.entries()) walk(prop.items, item, `${path}.${key}[${i}]`);
      } else if (prop.type === 'object' || prop.properties) {
        walk(prop, child, `${path}.${key}`);
      } else if (prop.type === 'integer' || prop.type === 'number') {
        if (typeof child !== 'number') problems.push(`${path}.${key} should be a number, got ${typeof child}`);
      } else if (prop.type === 'string') {
        if (typeof child !== 'string') problems.push(`${path}.${key} should be a string, got ${typeof child}`);
      } else if (prop.type === 'boolean') {
        if (typeof child !== 'boolean') problems.push(`${path}.${key} should be a boolean, got ${typeof child}`);
      }
    }
  };
  walk(tool.outputSchema, value, at);
  return problems;
}
