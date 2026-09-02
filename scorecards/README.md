# webmcp.com scorecards

On-demand scorecards from [webmcp.com](https://webmcp.com)'s scanner, kept here
because **the grade appears nowhere public** — not in `/api/v1/sites/<host>`, not
on `/sites/<host>`. A scan is the only way to see one, and a scan is
point-in-time. Without these files a "we were an A" claim has nothing behind it.

Two hosts are tracked. Both serve the same script: `lobby.host` from its own
`public/lobby-webmcp.js`, and `arenna.link` through `lobby.host/embed.js`. One
lobby-web deploy moves both.

## How to run one

```
POST https://webmcp.com/api/scan   {"email":"…","url":"https://lobby.host","rescan":true,"phId":""}
  -> {jobId};  then poll GET /api/scan/<jobId> until stage === "done"   (~15-20s)
```

The scorecard is on `full` (`score`, `grade`, `dimensions`, `highlights`,
`perToolNotes`) and `mechanical` (`toolsCount`, `pagesScanned`, `timings`).

Two things to know before running one:

- **It emails the scorecard to the address submitted.** Do not use somebody's
  address without asking.
- A repeat POST for the same URL returns the **same** `jobId` with
  `cached: true`. `rescan: false` is not a second write path.
- A scan does **not** refresh the public directory listing. Score and listing are
  separate systems and the listing has no self-serve refresh.

## Scan only to confirm nothing broke

The useful signals are `toolsCount`, `workingToolsCount`, `hasCrash` and
`errors` — did every tool still load and execute. **The dimension scores are not
a lever, and this directory is the evidence.** Two deliberate attempts to move
them returned zero:

| date | change shipped | result |
|---|---|---|
| 2026-09-01 | Every tool's return shape stated in its `description`, the one field the grader demonstrably reads | lobby.host 88 A → **88 A**; arenna.link 71 B → **71 B**. Usability 80 and 65, **unchanged**. |
| 2026-09-02 | `cancel_booking` — a real capability gap, closed | lobby.host 88 A → **88 A**; arenna.link 80 A- → **80 A-**. All four dimensions **unchanged** on both. |

Both times the qualitative text moved a great deal and the number did not move at
all. The second is the sharper case: arenna.link's own prior scorecard called the
missing cancel tool *"a real gap given bookings are created here"*, and its
coverage score stayed at 60 after the gap was closed. Its summary went from
*"lacks any cancel/reschedule/modify capability"* to *"coverage of the full
booking lifecycle … is complete"*, the criticism disappeared from the highlights
and was replaced by a third positive, and the score was identical.

The one score change ever observed came from **their** side: on 2026-09-02
arenna.link went 71 B → 80 A- with no deploy of ours in between, when the scanner
started capturing `outputSchema` — a field it had been discarding on capture and
then penalising the absence of.

So: never justify work by "it should raise the score", and do not rescan to
measure an improvement of this kind.

## The two remaining criticisms, and why neither is being worked

Both hosts now report the same pair:

- **"All tools on one page / thin page coverage."** Their page de-duplication:
  lobby.host's 11-then-12 tools are registered per route across six scanned
  pages, and are reported as one. Raised with them; not ours to fix.
- **"Concierge vs lookup intent overlap."** Deliberate. `ask_concierge` is the
  judgement-and-nuance fallback and its description explicitly steers agents to
  the free typed lookups first. Removing the overlap would mean removing the
  fallback.

## Files

| file | what |
|---|---|
| `2026-09-02-lobby.host.json`, `2026-09-02-arenna.link.json` | raw payloads, 09:24 UTC — the pre-`cancel_booking` baseline |
| `2026-09-02-summary.md` | that pair read side by side, vs the 09-01 numbers |
| `2026-09-02-post-cancel-*.json` | raw payloads, 10:12 UTC, prod verified serving `cancel_booking` first |
| `2026-09-02-cancel-booking-before-after.md` | the before/after, and the zero result |
