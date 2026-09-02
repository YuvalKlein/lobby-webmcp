# webmcp.com — before / after `cancel_booking`

Both scans 2026-09-02, `rescan: true`, email `yuval@arenna.co`, `emailFailed: false`.
**Before** = the 09:24 UTC rescan (12 tools not yet deployed). **After** = 10:12 UTC,
with prod verified serving `cancel_booking` first.

| | lobby.host before | lobby.host after | arenna.link before | arenna.link after |
|---|---|---|---|---|
| **Grade** | **A** | **A** | **A-** | **A-** |
| **Score** | **88/100** | **88/100** | **80/100** | **80/100** |
| Coverage | 100 | 100 | 60 | 60 |
| Quality | 100 | 100 | 100 | 100 |
| Usability | 80 | 80 | 80 | 80 |
| Executable | 100 | 100 | 100 | 100 |
| Tools detected | 11 | 12 | 6 | 7 |
| Tools working | 11 | 12 | 6 | 7 |
| Pages scanned | 6 | 6 | 2 | 2 |
| Errors | none | none | none | none |

## Verdict: not one point moved, on either host

lobby.host A/88 → A/88. arenna.link A-/80 → A-/80. All four dimensions identical
on both, including the coverage score on arenna.link — whose *own* previous
scorecard named the missing cancel tool as "a real gap given bookings are created
here." The gap was closed and coverage stayed 60.

The scanner did see it. It read the tool, understood the security model, and
praised it — the prose moved a lot. The number did not move at all.

### lobby.host — what the scanner said

| | before | after |
|---|---|---|
| 1 | Consistent ok/error envelope across all tools | Consistent ok/error envelope across all tools |
| 2 | Excellent booking safety and confirmation flow | Excellent booking/cancel confirmation & token safety |
| 3 | ask_concierge overlaps with lookup tools | All tools on one page — thin coverage |
| 4 | All tools on one page; thin page coverage | Concierge vs lookup intent overlap |

Summary, before:

> This is a strong, coherent tool surface for a Lobby concierge/marketing site, with a consistent result envelope, precise input/output schemas, and well-articulated safety guidance (notably the two-step booking confirmation and UTC slot handling). Coverage spans info, offerings, pricing, recommendation, setup, examples, signup, and a complete booking flow, with clear guidance on when to prefer cheap lookups over the concierge. Minor gaps keep it from a 5: all tools live on a single page, ask_concierge overlaps intent with several lookup tools, and a few enums/constraints could be tighter. Overall an agent could call these reliably.

Summary, after:

> This is a strong, coherent WebMCP surface with a consistent result envelope, precise input/output schemas, and unusually careful guidance around cost-avoidance, confirmation flows, and security-sensitive tokens. The booking lifecycle (options → availability → start → cancel) is well-sequenced with explicit two-step confirmation and clear UTC/timezone handling. It falls short of a 5 mainly due to all tools living on a single page (thin page coverage) and some intent overlap between the concierge and the factual lookup tools that relies on prose disambiguation rather than structural separation.

Its note on the new tool: *"Careful token-only auth, idempotency, and null-time-before-confirm handling."*

### arenna.link — what the scanner said

| | before | after |
|---|---|---|
| 1 | Consistent ok/error envelope across all tools | Consistent ok/error envelope across all tools |
| 2 | Strong two-step confirm + timezone handling | Excellent two-step confirm and token-safety guidance |
| 3 | No cancel/reschedule tool coverage | Precise schemas, tight constraints, clear UTC/local split |
| 4 | Single-page surface only | Single-page coverage; concierge vs lookup overlap |

Summary, before:

> A well-designed concierge/booking surface with a consistent result envelope, precise input constraints, and unusually clear guidance on tool sequencing and cost tradeoffs. The booking flow enforces a safe two-step confirmation and handles timezones carefully, while lookup tools clearly disambiguate their intent from the free-form concierge. Coverage is limited to a single page and lacks any cancel/reschedule/modify capability, which is a real gap given bookings are created here.

Summary, after:

> This is a strong, cohesive concierge-and-booking surface with a consistent result envelope, precise input constraints, and unusually clear guidance on confirmation flows, token handling, and timezone semantics. Coverage of the full booking lifecycle (discovery, availability, book, cancel) is complete and the descriptions actively steer agents away from common mistakes. Gaps are minor: all pages map to '/', so page coverage is thin, and there is some intentional intent overlap between the concierge and the free lookup tools that relies on prose to disambiguate.

Its note on the new tool: *"Token-vs-id distinction and idempotency clearly stated; null-time-before-confirm is well explained."*

## Per-tool notes, after

**lobby.host**

- `ask_concierge` — Clear, but broad catch-all; overlap with lookups managed only via description.
- `get_business_info` — Well-scoped facts tool with precise output; good 'call first' guidance.
- `list_offerings` — Strong schema with explicit bookable/contact_required flags; filter param is well constrained.
- `get_pricing` — Authoritative and detailed; plan enum and fields well defined.
- `recommend_plan` — Deterministic with sensible bounded inputs; reasons/caveats aid transparency.
- `get_setup_instructions` — Returns concrete steps/snippet; optional narrowing param is clear.
- `list_customer_examples` — Useful proof tool; simple bounded limit param.
- `get_booking_options` — Good precondition sequencing and timezone semantics; solid enums.
- `check_availability` — Excellent range constraints, empty-list semantics, and UTC vs local handling.
- `start_booking` — Exemplary two-step commit with strong anti-hallucination and cancel_url secrecy notes.
- `cancel_booking` — Careful token-only auth, idempotency, and null-time-before-confirm handling.

**arenna.link**

- `ask_concierge` — Clear fallback role; explicitly deprioritized vs free lookups, avoiding true overlap. Well-scoped.
- `get_business_info` — Good zero-arg factual entry point; envelope documented once here. Solid output schema.
- `list_offerings` — Structured, filterable, with careful bookable-flag warnings. Price type union is pragmatic.
- `get_booking_options` — Correctly positioned before availability; duration/timezone rationale is explicit and helpful.
- `check_availability` — Strong range constraints and empty-list semantics; local vs UTC distinction well handled.
- `start_booking` — Exemplary confirmation and cancel_url secrecy handling; unambiguous status semantics.
- `cancel_booking` — Token-vs-id distinction and idempotency clearly stated; null-time-before-confirm is well explained.

## What this confirms

This is the second experiment with the same result. Stating output shapes in prose
bought zero points on 2026-09-01; closing a coverage gap the scanner itself named
bought zero points on 2026-09-02. Both times the qualitative text changed
substantially and the dimension score did not budge.

Treat these numbers as insensitive to this class of change. The cancel tool was
worth shipping because an agent could book and not undo — not for the scorecard,
which was never the reason and is now demonstrably not a lever.
