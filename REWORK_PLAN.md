# Rework Campaign Plan — dnd-multiplayer

> **Note:** the combat + level-up campaign has moved to [COMBAT_REWORK_PLAN.md](COMBAT_REWORK_PLAN.md) (complete). Sections here that describe tactical grid combat are historical; the open P2/P3 units below are still live.

Branch: `rework/refactor-ui` (off `main`). Local commits per verified unit; **no push to GitHub until user says so**.
Decisions (user-confirmed 2026-07-19): keep vanilla no-build frontend and restructure it; UI = visual overhaul on the existing CSS token/theme system (parchment-fantasy identity stays).

Process per unit (Marinara lessons): one Opus implementer per small scoped unit → orchestrator reviews the diff → tests + server boot check → commit. Phase-end: review pass + browser verification via preview server. Overlapping-file units run sequentially; disjoint units run in parallel.

## Phase 1 — Safety net (IN PROGRESS)

- **U1.1 Backend dead code** *(dispatched, running)*: delete `server/index-modular-example.js`, `server/services/gameRules.js` (server copy only), `AI_RESPONSE_PREFIX` plumbing, stale `X-Game-Password/X-Admin-Password` CORS headers. Keep `tagParser` parsers (Phase 3 consolidates onto them) and `asyncHandler` (Phase 3 adopts it).
- **U1.2 Frontend dead code** *(dispatched, running)*: delete `modals/admin.js` stub, `modals/sessionNew.js` shim, `state.subscribe`, legacy `handleSectionToggleClick`, `toggleInventory` (if grep-dead); fix `formatSpellSlots` ordinal bug ("2st/3st"); strip debug console.logs in main.js/characters.js/tts.js.
- **U1.3 Test harness**: `node:test` + package.json `test` script; tests for currently-pure logic: `tagParser.parseChoices`, `findCharacterByName`, `lib/validation.js`, XP thresholds. Tests are committed (own repo — unlike Marinara upstream local-only rule).
- **U1.4 Helper unification**: one canonical `getActiveApiConfig` shape (kill the dual `{api_endpoint,api_key,api_model}` vs `{endpoint,api_key,model}` and the defensive `x.api_endpoint || x.endpoint` normalizations in sessions.js/characters.js); single `estimateTokens` (currently defined in both aiService.js:285 and turnProcessor.js:14).

## Phase 2 — Summarization rework (user's explicit pain point) — DONE

Root cause of "vanishing space between summarizations": the compact trigger counted `estimateTokens(JSON.stringify(recentHistory))` — stored entries **including per-character `povs`** (one full scene rewrite per player) + JSON overhead — while the model is only ever sent `entry.content`. With N players the counter ran ~(N+1)× hot, so the 8000-token threshold tripped faster and faster. Compounded by `compacted_count = length-1` leaving exactly 1 raw entry post-compaction.

- **U2.1 Merge turn processors** — DONE (9d21280): merged `processAITurn`/`streamAITurn` into one `runAITurn(deps, ...opts)` with the stream-vs-non-stream difference isolated to the acquisition block; thin wrappers preserve the exports + index.js fallback. Pure refactor, −245 lines, verified byte-identical.
- **U2.2 Compaction fix** — DONE (831286e): trigger now counts the actual outgoing payload via `buildConversationMessages` + `estimatePromptTokens` (content + summary only; ~34× less than old count on a 3-player fixture); keeps a `COMPACT_TAIL=10` raw-entry tail; default threshold 8000→16000 (still overridable via `max_tokens_before_compact`); summary cap 4000→8000. Decision logic extracted to pure `planCompaction`.
- **U2.3 Tests** — DONE (831286e): `tests/turnProcessor.test.js`, 11 tests (message building, inflation proof, all planCompaction branches incl. tail retention). Adversarially verified across 3 lenses (payload-accuracy / convergence / regression) — all CORRECT.
- **Also fixed** (b7ba691): a `ReferenceError` (dangling `aiCallConfig`) that U1.4 left on the non-streaming POV path.

**Verified follow-ups (NOT done — deliberate future work, do not smuggle into other units):**
1. *Context-entry aging*: every turn pushes a fresh `type:'context'` party-status entry (full character sheets incl. backstories) into history, and ALL past ones within the window are re-sent to the model each turn. Sending only the latest context (drop/collapse stale ones) would cut real prompt size substantially. This CHANGES what's sent → needs its own scoped unit + verification. Good Phase 3 candidate.
2. *maxTokens floor vs tail cost*: if someone sets `max_tokens_before_compact` below the cost of the 10-entry tail + summary, mild re-compact thrash can recur (still far milder than the old bug, not hit at default 16000). Optional hardening: floor the setting relative to tail cost.

## Phase 3 — Backend consolidation (IN PROGRESS)

- **U3.1 Single tag grammar**: consolidate the 4 diverging XP/MONEY/ITEM/HP/SPELL/AC parse implementations onto `tagParser` (structured output); `tagApplicator` becomes parse→apply. Canonical semantics = current live applicator behavior (incl. fuzzy item matching).
- **U3.2 Session-scoped broadcasts (security fix)** — DONE (65d327d): replaced all 27 global `io.emit('character_*')` sites with a room-scoped `emitCharacterUpdate(charId, event, payload)` helper in index.js. Sockets join a `user:<id>` room (and admins an `admins` room) on connect; character events target the union of the character's session rooms ∪ owner room ∪ admin room. Delete resolves recipients before removing the row; reassign notifies old + new owner. Verified: 0 residual `io.emit('character_`, `node --check` on all 6 files, 26/26 call sites in-scope, 52 tests green, frontend contract (socket.js:252-273) preserved for participants/owner/admins. Bonus: fixes cross-session level-up notification spam.
  - *Adjacent findings (NOT in U3.2 scope):* (a) sessions.js recalc routes (1080/1180/1260/1486) already emit **session-scoped** `sendToSession('character_updated')` — safe, no leak; fold onto `emitCharacterUpdate` during U3.3 so owner-on-Characters-tab + admins also get recalc updates. (b) sessions.js:229/266 globally `io.emit('session_created'/'session_deleted')` — session *metadata* (not char sheets), a separate visibility concern; candidate for a later session-scoping unit, deliberately not smuggled into U3.2.
- **U3.3 Recalculate routes**: rewrite the four `recalculate-*` handlers (sessions.js:1035-1492, ~460 lines) as "re-run the shared parser/applier over history"; unify their `sendToSession('character_updated')` onto `emitCharacterUpdate`.
- **U3.4 Extract services**: character mutation service (select→mutate JSON col→UPDATE→emit cycle recurs ~15×); shared brace-counting marker-JSON extractor (triplicated in characters.js levelup/edit/ai-create); prompt strings gathered into one module.
  - **U3.4a marker-JSON extractor** — DONE (a9561f8): lifted the triplicated brace-counting scan into `lib/markerJson.js` `extractMarkerJson(text, marker)`, reproducing the exact algorithm; rewired all 3 characters.js sites; 8 tests. Suite 60 green. Remaining U3.4: char-mutation service + prompts module.

### Risk boundary (2026-07-22, autonomous session)
U3.2 (security) + U3.4a (extractor) are DONE + committed + fully verified (unit tests + node --check + grep proofs). The remaining Phase-3 units cross into changes that **cannot be verified locally** because the server can't boot (better-sqlite3 native binding won't compile on Node 24; prod is Node 18):
- **U3.1 / U3.3** rewrite live gameplay-state math (tag parse+apply, recalc replay). Only safety net without a boot is unit tests + reasoning; a parse-parity harness is mandatory before touching the live path, and even then no end-to-end playtest is possible here.
- **U3.5 stat bounds** has a frontend payload-contract risk (quick-update/edit may send stats as numeric strings; a strict `isNumber` guard would reject them) — needs the real payload shape confirmed.
Options for the user: (a) unblock local boot (Node 18 shim / Docker + env vars) so changes can be playtested; (b) proceed unit-by-unit with the user playtesting the deploy between; (c) build exhaustive parity/contract harnesses per unit and proceed test-only. Held for user direction before proceeding with U3.1/U3.3/U3.5.
- **U3.5 Error handling + validation**: adopt `asyncHandler`, consistent status codes (action vs process currently return 200-with-error vs 500 for the same failure), stop leaking raw `e.message`; apply `schemas.character` stat bounds to `POST /api/characters`, `quick-update`, `ai-create`, `edit`.

## Phase 4 — Frontend structure

- **U4.1 Event delegation**: data-action attributes + one delegated listener per view; retire the ~96 `window.*` exports in main.js and inline onclick in HTML strings (this is the load-bearing coupling; also unblocks CSP tightening in Phase 5).
- **U4.2 Split `modules/sessions.js`** (1,728 lines) along its comment-banner seams: session list/CRUD + new-session modal, story renderer (+POV), virtual scroller, dice+inspiration (self-contained state at :757-1102), choices, slash commands, actions/turn/recalc.
- **U4.3 Split `characterBuilder.js`** (1,282 lines) by wizard step; fix full-innerHTML-re-render-per-keystroke listener churn.
- **U4.4 Unify card rendering**: one card function behind `renderCharactersList`/`updatePartyList` (near-identical ~130-line duplicates).
- **U4.5 Adopt `modalManager`** (already written, unused) for open/close/Escape; collapse the triple-wired section-toggle (inline onclick + delegated listener + capture-phase handler).
- **U4.6 Shared post-mutation helper** for the `characters[idx]=result; setState; render; loadCharacters` block repeated ~7× in spellSlots.js/inventory.js.

## Phase 5 — UI overhaul (on existing tokens)

- **U5.1 In-app dialog system** (confirm/prompt/alert replacement) styled on the token system — kills all native `confirm()/alert()/prompt()` flows.
- **U5.2 UX fixes**: real spell-slot editor (replaces raw-JSON text input in Quick Edit), recalc results rendered in-app (replaces `alert()` dumps), split Character-Edit vs Level-Up shared modal DOM.
- **U5.3 Visual refresh pass** per component group (cards, drawer, action bar, dice roller, builder, settings) keeping parchment identity; accessibility: `role="tabpanel"`, clickable divs → buttons, focus order.
- **U5.4 CSP tighten**: drop `'unsafe-inline'` for scripts (enabled by U4.1); notable because the DM prompt makes the AI emit raw HTML that is rendered client-side.
- **U5.5 Verification sweep**: preview server, light+dark themes, mobile+desktop widths.

## Environment note

Local `node_modules` lacks the compiled `better-sqlite3` native binding (local Node is v24) — `node server/index.js` fails at `config/database.js:21` before any app code runs. Run `npm rebuild better-sqlite3` (may need the Task Scheduler escape if the sandbox blocks native builds) before any local boot / browser verification. Until then, verify units via `node --check` + direct `require()` load tests.

## Resume state (for post-compaction pickup)

- Tasks #1-#5 mirror the phases (Task #1 in_progress; deps 2←1, 3←2, 4←1, 5←4).
- U1.1 + U1.2 implementers were dispatched 2026-07-19; their diffs land uncommitted in the working tree → review, run `node --check`/boot check, commit each separately.
- Then dispatch U1.3 + U1.4 (parallel-safe? U1.4 touches turnProcessor/aiService/sessions/characters — run U1.3 and U1.4 in parallel only if U1.3 stays inside tests/ + package.json; otherwise sequential).
- Full audit evidence (file:line) lives in the session that produced this plan; the plan above carries everything needed to execute.
