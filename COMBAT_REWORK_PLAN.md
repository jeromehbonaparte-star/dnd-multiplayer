# Combat Rework + Level-Up Hardening Plan (2026-08-06)

Orchestrator: Fable lead. Builders: Opus 5 subagents, one scoped unit each; lead reviews every diff before commit.

## Goals
1. **Remove tactical grid combat** and replace it with **Narrative Turn-Based Combat (NTC)**: text-based, initiative via dice roll, per-turn Action Point + Bonus Point economy, AI adjudicates freeform player actions and decides costs, enemies take AI-driven turns. Combat plays out in the story stream.
2. **Seamless migration**: sessions with an active tactical fight (`combats.is_active = 1`, schema-1 grid blob) transcode into NTC state on first load and continue mid-fight. `deferredTurn.openingResolution` MUST be preserved.
3. **Fix the level-up system**: real subclass data for all 12 classes, resilient class-name resolution (the "Wild Magic Sorcerer" bug), validation at every write boundary, repair migration for corrupted characters, and guards so a level-up can never reduce spell slots.

## NTC design

### State (stored in `combats.combatants`, `schema: 2`)
```js
{
  schema: 2, name, environment,            // environment kept as scene flavor text
  phase: 'initiative' | 'active',
  round, turnIndex, turnOrder: [unitId],
  pendingInitiative: [unitId],             // party units that haven't rolled yet
  outcome: null | 'victory' | 'defeat' | 'resolved',
  units: [{ id, sourceCharacterId?, name, side: 'party'|'enemy', imageUrl,
            hp, maxHp, ac, attackBonus, damageDie, damageBonus, initiativeBonus,
            initiative,                    // rolled total; null until rolled
            ap, apMax, bp, bpMax,          // action/bonus points, reset at turn start (default 1/1)
            conditions: [],                // free strings: 'prone', 'unconscious', ...
            spellSlots?, powers?, powerUses? }],
  log: [{type, text, round}],              // capped 80
  seed, rngState,                          // xorshift PRNG kept for server rolls
  version,                                 // optimistic concurrency counter, ++ per mutation
  deferredTurn?: { openingResolution, startedAt }   // carried from auto-start; consumed at combat end
}
```

### Flow
1. **Start** — unchanged triggers: resolver-AI `combat` payload auto-start (turnProcessor) or GM manual start. Enemies get server-rolled initiative (seeded d20 + bonus) immediately. Party units enter `pendingInitiative`; phase = `'initiative'`.
2. **Initiative** — each player rolls d20 in the existing dice UI, `POST /combat/initiative` `{roll}`; server adds DEX-based `initiativeBonus`. GM button "Roll remaining" auto-rolls stragglers. When `pendingInitiative` empties → sort `turnOrder` desc (server d20 tiebreak), phase `'active'`, round 1, first unit's turn begins (leading enemy turns auto-resolve).
3. **Player turn** — only the active player's action bar is enabled ("Your turn — Round N"). They type a freeform action (optional d20 roll appended exactly like story turns), `POST /combat/turn-action`. Server calls the **combat adjudicator** (agent AI role) with combat state + action text; it returns the Adjudication JSON below. Server validates/clamps and applies effects, deducts AP/BP, appends narration to combat log AND to `full_history` as a visible entry. If `ap<=0 && bp<=0` or `turnEnds` → advance to next unit (auto-resolving enemy turns). Multiple submissions per turn are allowed while points remain — "the AI decides what it takes."
4. **Enemy turn** — server pre-rolls attack d20s + damage from the seeded RNG, hands them to the enemy-turn prompt as authoritative dice; AI returns the same Adjudication JSON (narration + effects). Applied, appended, advance.
5. **Down/out** — a unit at 0 HP gains `unconscious`, its turns are skipped; adjudicator is told not to kill downed PCs outright.
6. **End** — engine outcome check after every applied adjudication (side wiped → victory/defeat), or adjudicator emits `endCombat` (e.g. flee/negotiate → `'resolved'`). Then the existing conclusion path runs: summary + `completeCombatTurn` narration (consuming `deferredTurn.openingResolution`). GM "End combat" now also produces a summary narration (fixes silent-end gap).

### Adjudication JSON contract (shared by C1 engine + C2 prompts)
```json
{
  "narration": "2-4 paragraph resolution text",
  "costs": { "ap": 1, "bp": 0 },
  "effects": [
    {"type":"damage","target":"<unit name or id>","amount":7},
    {"type":"heal","target":"...","amount":5},
    {"type":"condition","target":"...","add":"prone"},
    {"type":"condition","target":"...","remove":"prone"},
    {"type":"spendSlot","target":"...","level":2},
    {"type":"useAbility","target":"...","ability":"Second Wind"},
    {"type":"endCombat","outcome":"resolved","reason":"enemies routed"}
  ],
  "turnEnds": false
}
```
Engine API: `applyAdjudication(state, actingUnitId, adjudication)` — fuzzy target resolution (name → unit), amounts clamped (0..500), unknown effect types ignored with a log warning, costs clamped to available points. Malformed JSON → safe no-op error surfaced to the player ("the DM stumbled — try again"), state untouched.

### Character-sheet integration (spell slots, items, resources)
Combat units carry the FULL sheet, and the sheet stays live-synced:
- **Spell slots** — unit.spellSlots deep-copied from `characters.spell_slots` (`{level:{current,max}}`); `spendSlot` decrements with availability validation (no slot left → effect skipped + warning; adjudicator is told remaining slots and instructed casts fail/downgrade without slots). Persisted back to `characters.spell_slots` after EVERY combat turn, not just at combat end.
- **Inventory** — unit.inventory deep-copied from `characters.inventory` (`[{name,quantity}]`); new effect `{"type":"useItem","target":...,"item":"Potion of Healing"}` decrements quantity (remove at 0; missing item → warning). Persisted back per turn.
- **Class resources / features / spells** — `class_resources`, `class_features`, and the raw `spells` text ride on the unit as adjudicator context (so freeform casts of any known spell work); per-combat ability uses tracked via `powerUses` as before. New effect `spendResource` reserved but maps onto powerUses counters.
- **Conditions** — unit.conditions surfaced to the adjudicator every call.
- Engine exposes `collectCharacterWriteback(state)` → `[{characterId, hp, spellSlots, inventory}]`; C3 persists these + emits `character_updated` after every applied adjudication so open character sheets update in real time.
- Migration from schema-1 carries spellSlots/powerUses; inventory is re-read fresh from the DB at transcode time (grid combat never tracked it).

### Migration (schema 1 → 2)
`fromTacticalState(oldBlob)` in the engine: keep `units[].{name, sourceCharacterId, side, hp, maxHp, ac, attackBonus, damageBonus, damageDie, initiativeBonus, spellSlots, powers, powerUses, imageUrl}`, `turnOrder`, `turnIndex`, `round`, `log`, `name`, `environment`, `deferredTurn`, `seed/rngState`, `version`. Drop `grid`, `x/y`, `movement`, `range`, `hasMoved`, `defending`. Synthesize `initiative` descending from existing `turnOrder` position; phase `'active'`; fresh `ap/bp = 1/1` for the current unit. Applied lazily wherever an active combat is loaded (`getActiveCombat` wrapper); saved back on first mutation.

### Removal
Delete grid UI (`public/js/modules/tacticalCombat.js` board/power-menu/animations), combat setup grid modal, terrain CSS + `public/assets/tactical/*.webp`, and grid logic in the service. The four 409 guards on story endpoints during combat stay. `.combat-mode-active` full-screen takeover is REPLACED: story stream stays visible (combat is text), a compact initiative tracker panel shows order/round/HP/AP/BP.

## Level-up hardening design
- **Subclass data**: every 2014 PHB subclass (~48) with `{index, name, class_index, features_by_level}` in a new `server/data/srd/subclasses.json`; served via `GET /api/dnd/classes/:idx/subclasses`; `dndDataService` loads + validates.
- **Resolution ladder** in `getClassName`: exact name → exact index → token/suffix match ("wild magic sorcerer" ends with known class) → alias map; every non-exact hit logged WARN. New `resolveClassAndSubclass(raw)` → `{className, subclass|null}` splits strings like "Wild Magic Sorcerer".
- **Write boundaries**: `POST /characters`, `quick-update`, AI editor all normalize-and-split via `resolveClassAndSubclass`; truly unknown class → 400 with suggestions (AI editor: drop the field + warn). `classes` JSON keys normalized on write.
- **Repair migration**: startup scan of `characters` for `class`/`classes` keys failing resolution; repair via the ladder (split into class + `class_choices` subclass); log every repair.
- **`/levelinfo`**: unresolvable class → 409 `{error, unresolvedClass, suggestions}`; modal renders a repair widget instead of dead-ending.
- **Slot guard**: level-up may never reduce total slot capacity (`slotsToState` gains a floor against current state).
- **UI**: subclass `<select>` (from API, + "Homebrew…" free-text escape) in the level-up modal and a subclass step in the character builder at the class's `subclassLevels[0] === 1` classes.
- **Self-check**: startup assertion that `CLASS_RULES`, `FEATURES`, `classes.json`, and `subclasses.json` agree (same 12 classes; every subclass's parent exists; subclass levels match `subclassLevels`).
- **Client/server drift fix**: client `canLevelUp` gets the level-20 cap.

## Build units (Opus 5, sequential per track; two tracks parallel)
- **C1** engine: `server/services/combatService.js` (NTC state, initiative, AP/BP, applyAdjudication, enemy pre-rolls, outcome, summary, `fromTacticalState`) + tests. Pure, DB-free.
- **C2** AI: adjudicator + enemy-turn prompts/parsers in `aiService.js` + tests (mocked callAI).
- **C3** server integration: sessions routes (initiative, turn-action, GM controls), turnProcessor auto-start + conclusion rewiring, lazy migration, socket events, per-combatant history entries.
- **C4** frontend: remove grid UI, new initiative-tracker panel + turn-gated action bar, socket handlers, CSS.
- **C5** cleanup: dead assets, stale DOCUMENTATION.md/UPDATE.md combat sections.
- **L1** subclass data + service + routes + startup self-check + tests.
- **L2** resolution ladder + write-boundary validation + repair migration + `/levelinfo` 409 + slot guard + tests.
- **L3** frontend: level-up modal subclass select + repair widget, builder subclass step, `canLevelUp` cap.

## Constraints
- Local server CANNOT boot (better-sqlite3 native binding vs Node 24). Verification = `node --check` + `npm test` (node:test, DB-free pure modules). Route/DB code verified by review + tests around extracted pure helpers.
- Commit locally per unit after lead review; push when the campaign is coherent. User deploys `main` via EasyPanel and playtests.
