# D&D Multiplayer - Project Documentation

## Overview

A real-time multiplayer D&D (Dungeons & Dragons 5e) web application with an AI-powered Dungeon Master. Players can create characters, join sessions, and play together with an AI narrating the story.

**Live URL:** `dnd.romyromulus.com`
**Deployment:** Easypanel on Linode
**Repository:** `github.com/jeromehbonaparte-star/dnd-multiplayer`

> **Note:** See [UPDATE.md](UPDATE.md) for a guide on updating and maintaining this project.

---

## Tech Stack

- **Backend:** Node.js, Express.js, Socket.IO
- **Database:** SQLite (better-sqlite3)
- **Frontend:** Vanilla HTML/CSS/JavaScript
- **AI Integration:** OpenAI-compatible & Anthropic API (works with DeepSeek, OpenRouter, Claude, etc.)
- **Auth:** bcrypt for password hashing
- **Security:** express-rate-limit for brute force protection
- **Deployment:** Docker

---

## Project Structure

```
dnd-multiplayer/
├── server/
│   └── index.js          # Main backend server (all API routes, Socket.IO, AI processing)
├── public/
│   ├── index.html        # Single-page app HTML
│   ├── css/
│   │   └── style.css     # All styling (dark/light themes, responsive)
│   └── js/
│       └── app.js        # Frontend JavaScript (state, API calls, UI updates)
├── data/
│   └── dnd.db            # SQLite database (created at runtime)
├── Dockerfile            # Docker config for Easypanel
├── package.json          # Dependencies
├── .env.example          # Environment variable template
└── DOCUMENTATION.md      # This file
```

---

## Database Schema

### Tables

**settings**
```sql
key TEXT PRIMARY KEY
value TEXT
```
Keys: `game_password`, `admin_password`, `max_tokens_before_compact`
(Note: API settings have been moved to `api_configs` table)

**api_configs** (Multiple API Configuration Support)
```sql
id TEXT PRIMARY KEY
name TEXT NOT NULL              -- Display name (e.g., "OpenAI GPT-4", "DeepSeek")
endpoint TEXT NOT NULL          -- API endpoint URL
api_key TEXT NOT NULL           -- API key (masked in UI)
model TEXT NOT NULL             -- Model name
is_active INTEGER DEFAULT 0     -- Only one can be active at a time
created_at DATETIME
```

**characters**
```sql
id TEXT PRIMARY KEY
player_name TEXT
character_name TEXT
race TEXT
class TEXT                      -- Primary class (highest level)
classes TEXT DEFAULT '{}'       -- JSON: {"Fighter": 5, "Wizard": 2} for multiclass
level INTEGER DEFAULT 1         -- Total character level
strength INTEGER
dexterity INTEGER
constitution INTEGER
intelligence INTEGER
wisdom INTEGER
charisma INTEGER
hp INTEGER
max_hp INTEGER
xp INTEGER DEFAULT 0
gold INTEGER DEFAULT 0
inventory TEXT DEFAULT '[]'     -- JSON array of {name, quantity}
ac INTEGER DEFAULT 10           -- Total Armor Class (calculated from ac_effects)
ac_effects TEXT DEFAULT '{...}' -- JSON: {base_source, base_value, effects: [{id, name, value, type, temporary, notes}]}
spell_slots TEXT DEFAULT '{}'   -- JSON object {level: {current, max}}
feats TEXT DEFAULT ''           -- Comma-separated feats
class_features TEXT DEFAULT ''  -- Comma-separated class features (Second Wind, Action Surge, etc.)
appearance TEXT DEFAULT ''      -- Physical description (hair, eyes, height, build, etc.)
backstory TEXT DEFAULT ''       -- Character's personal history and motivations
skills TEXT
spells TEXT
passives TEXT
created_at DATETIME
```

**game_sessions**
```sql
id TEXT PRIMARY KEY
name TEXT
story_summary TEXT          # AI-generated summary for context (backend only)
full_history TEXT           # JSON array of messages with metadata (see format below)
compacted_count INTEGER     # Number of messages summarized
current_turn INTEGER
total_tokens INTEGER
is_active INTEGER
created_at DATETIME
```

**full_history Message Format:**
The `full_history` field stores a JSON array of message objects with the following types:

```json
[
  // Character context (hidden from UI, sent to AI)
  {
    "role": "user",
    "content": "Character stats...",
    "type": "context",
    "hidden": true
  },
  // Individual player action (displayed as character bubble)
  {
    "role": "user",
    "content": "I attack the goblin with my sword",
    "type": "action",
    "character_id": "uuid",
    "character_name": "Thorin",
    "player_name": "John"
  },
  // DM narration response (with per-character POV narrations)
  {
    "role": "assistant",
    "content": "Cleaned narration text (POV tags stripped)",
    "type": "narration",
    "povs": {
      "Thorin": "Your sword connects with the goblin's shield...",
      "Elara": "You watch Thorin charge forward as you nock an arrow..."
    }
  }
]
```

This format enables:
- Character sheets to be sent to AI without cluttering player UI
- Player actions displayed as individual styled chat bubbles per character
- **Per-character POV narrations** — each player sees only their character's story
- Backward compatibility with legacy messages (no `type` or `povs` field — renders as standard narration)

**pending_actions**
```sql
id TEXT PRIMARY KEY
session_id TEXT
character_id TEXT
action TEXT
created_at DATETIME
```

---

## Key Features

### 1. Authentication System
- **Game Password:** All players need this to access the game
- **Admin Password:** Only admin can access Settings tab
- Environment variables: `GAME_PASSWORD`, `ADMIN_PASSWORD`

### 2. AI-Guided Character Creation
- Chat-based character creation flow
- AI guides player through race, class, stats, skills, spells selection
- **Variant Human** support with starting feat selection
- Creates Level 1 D&D 5e characters with proper `classes` JSON
- Endpoint: `POST /api/characters/ai-create`

### 3. Turn-Based Gameplay
- All players submit actions before AI processes the turn
- AI receives party status + actions and narrates outcome as **per-character POV narrations**
- Each player sees only their own character's 2nd-person POV story
- Eye icon button toggles between "Your POV" and "All POVs" view
- Switching character in the dropdown instantly re-renders the story to show that character's POV
- "Force Process Turn" button for DM override
- Real-time updates via Socket.IO

### 3b. Scenario Selection (New Session)
When creating a new session, players can choose from predefined scenarios:

| Scenario | Description |
|----------|-------------|
| Classic Fantasy | Traditional D&D with dungeons and dragons |
| Tavern Meeting | Classic "you all meet in a tavern" opening |
| Modern Urban Fantasy | Magic hidden in the modern world |
| Zombie Apocalypse | Survival horror with the undead |
| Space Opera | Sci-fi adventure among the stars |
| Noir Detective | 1940s gritty detective story |
| Pirate Adventure | High seas treasure hunting |
| Post-Apocalyptic | Wasteland survival |
| Horror Mystery | Lovecraftian cosmic horror |
| Custom Setting | User-defined world and scenario |

- AI generates an atmospheric opening scene as **per-character POV narrations**
- Each character's intro is personalized using their appearance, backstory, race, and class
- Custom setting allows free-form world description
- Opening scene introduces existing party characters if any

### 3c. Beautified Session UI
- Character sheets sent as hidden context (AI sees them, players don't clutter)
- Player actions displayed as individual styled bubbles per character
- Each character has unique color for visual distinction
- **POV narrations:** Each narration entry shows the selected character's personal 2nd-person story, styled with accent border and POV badge
- Toggle button to view all characters' POVs side-by-side
- Legacy narrations (pre-POV) render as standard "Dungeon Master" narration
- Legacy message format supported for backward compatibility

### 4. Auto-Compact System
- When tokens exceed `max_tokens_before_compact`, history is summarized
- **Backend only:** Players always see full chat history
- AI receives: `System Prompt + Summary + Recent Messages`
- `compacted_count` tracks how many messages are in the summary

### 5. XP System
- AI awards XP using format: `[XP: CharacterName +100, OtherCharacter +50]`
- XP is automatically parsed and added to character sheets
- "Recalculate XP" button scans existing history for XP awards
- "Reset XP" button on character cards to reset XP to 0
- Party sidebar shows "(Ready!)" when character has enough XP to level up

**D&D 5e XP Thresholds:**
| Level | XP Required |
|-------|-------------|
| 2 | 300 |
| 3 | 900 |
| 4 | 2,700 |
| 5 | 6,500 |
| 6 | 14,000 |
| 7 | 23,000 |
| 8 | 34,000 |
| 9 | 48,000 |
| 10 | 64,000 |
| 11 | 85,000 |
| 12 | 100,000 |
| 13 | 120,000 |
| 14 | 140,000 |
| 15 | 165,000 |
| 16 | 195,000 |
| 17 | 225,000 |
| 18 | 265,000 |
| 19 | 305,000 |
| 20 | 355,000 |

### 5b. Money & Inventory System
- AI awards money using format: `[MONEY: CharacterName +50, OtherCharacter -25]`
- `[GOLD:]` tag also works for backward compatibility
- Currency is setting-agnostic (gp for fantasy, USD for modern, credits for sci-fi)
- AI tracks items using format: `[ITEM: CharacterName +Sword of Fire, CharacterName +Health Potion x3]`
- Items can be removed: `[ITEM: CharacterName -Health Potion]`
- Item matching uses fuzzy search (partial name matches work)
- Money and inventory automatically parsed and updated on character sheets
- "Recalculate Loot" button scans existing history for MONEY/GOLD and ITEM tags
- Inventory displayed in character cards with collapsible view
- Inventory modal for manual management (add/remove items, update money)

### 5b2. HP Tracking System
- AI can modify character HP using format:
  - `[HP: CharacterName -10]` - Deal damage
  - `[HP: CharacterName +5]` - Heal (capped at max HP)
  - `[HP: CharacterName =20]` - Set HP to specific value
- HP changes are automatically applied and broadcast to all clients

### 5b3. Combat Triggering
- There is no `[COMBAT:]` narrative tag. An encounter starts one of two ways:
  - **Automatically** - the resolver AI returns a `combat` payload while processing a turn; `turnProcessor` builds the encounter and defers the narration until the fight ends
  - **Manually** - the GM posts `POST /api/sessions/:id/combat` with an enemy list
- See [6f. Narrative Turn-Based Combat](#6f-narrative-turn-based-combat-ntc) for the full system

### 5c. AC Effects & Spell Slots System
**Armor Class (AC) with Effects Tracking:**
- AC is now tracked as **base value + effects** for full visibility
- Base AC: The armor/unarmored value (e.g., "Plate Armor: 18", "Unarmored: 10")
- Effects: Additional bonuses from shields, spells, magic items, class features
- Each effect has: name, value, type (equipment/spell/item/class_feature/other), temporary flag
- Total AC = base_value + sum of all effect values
- UI shows AC breakdown on character cards and party sidebar
- Spell/Shield effects can be marked as temporary for easy clearing

**AC Data Structure:**
```json
{
  "base_source": "Plate Armor",
  "base_value": 18,
  "effects": [
    { "id": "uuid", "name": "Shield", "value": 2, "type": "equipment", "temporary": false },
    { "id": "uuid", "name": "Shield of Faith", "value": 2, "type": "spell", "temporary": true }
  ]
}
```

**AI AC Tracking Tags:**
- Add effect: `[AC: CharacterName +EffectName +Value Type]`
  - Example: `[AC: Elara +Shield of Faith +2 spell]`
- Remove effect: `[AC: CharacterName -EffectName]`
  - Example: `[AC: Elara -Shield of Faith]`
- Set base: `[AC: CharacterName base ArmorName Value]`
  - Example: `[AC: Thorin base Plate Armor 18]`

**Spell Slots:**
- AI tracks spell slot usage using format: `[SPELL: CharacterName -1st]` (uses one 1st level slot)
- AI tracks individual slot restoration: `[SPELL: CharacterName +1st]` (restores one slot, e.g., Arcane Recovery)
- Spell slots stored as JSON: `{level: {current: X, max: Y}}`
- Visual pip interface in Spell Slots modal (click to use/restore)
- Long Rest button restores all spell slots
- Add/remove spell slot levels for class flexibility
- Displayed in character cards and party sidebar

**Long Rest:**
- Dedicated tag: `[REST: Party]` (all characters) or `[REST: CharacterName]` (one character)
- Restores: HP to max, all spell slots, inspiration points to 4
- AI is instructed to always use `[REST:]` when narrating a long rest
- Old `[SPELL: CharacterName +REST]` format still works for backward compatibility
- `/rest` slash command in action textarea triggers long rest for selected character
- "Recalculate AC/Spells" button scans existing history for:
  - [AC:] tags for base AC and effects
  - [SPELL:] tags
  - Natural language spell casting (e.g., "Gandalf casts Fireball using a 3rd level slot")
  - AC mentions near character names (legacy support)

### 6. AI-Assisted Level Up & Editing

**Level Up (Interactive Chat):**
- Opens a chat modal when clicking "Level Up" button
- AI guides player through the level up process conversationally
- **Multiclass support:** AI asks if player wants to continue in current class or multiclass
- Shows multiclass requirements (13+ in key ability for each class)
- Covers: HP increase (rolls hit die + CON mod), new class features, spell selection
- At class levels 4, 8, 12, 16, 19: AI offers **ASI or Feat** choice
- Properly updates `classes` JSON for multiclass tracking
- Player can discuss choices before finalizing
- Endpoint: `POST /api/characters/:id/levelup` (with `messages` array for conversation)

**Character Editing:**
- Opens chat modal for free-form editing
- Can update stats, equipment, spells, skills, backstory, **feats, multiclass info**
- Supports editing `classes` JSON directly
- AI confirms changes before applying
- **Optimized:** AI only outputs changed fields (not full character JSON), making saves more reliable
- Fallback JSON parser catches saves even if AI omits the `EDIT_COMPLETE:` marker (requires confirmation language)
- Endpoint: `POST /api/characters/:id/edit`

**Party Sidebar Quick Actions:**
- Inventory button: Opens inventory management modal
- Level Up button: Highlighted green when ready, disabled when not enough XP

### 6a. Level-Up Data & Class Resolution

**Subclass data:**
- `server/data/srd/subclasses.json` - 40 PHB subclasses as `{ index, name, class_index, flavor_name, features_by_level }`, loaded and validated by `dndDataService`
- `GET /api/dnd/classes/:classIndex/subclasses` - subclasses for one class (unknown class -> `[]`)
- `GET /api/dnd/subclasses` - the whole catalogue
- The level-up modal and the character builder render a subclass `<select>` from these, with a "Homebrew..." free-text escape
- A startup self-check asserts `CLASS_RULES`, `FEATURES`, `classes.json` and `subclasses.json` agree (same classes, every subclass has a real parent)

**Class resolution ladder** (`classProgressionService.resolveClassAndSubclass`) -
free-text like "Wild Magic Sorcerer" used to resolve to `null`, which dead-ended
`/levelinfo` and made level-up treat the character as a fresh multiclass. The
ladder tries, in order:
1. `exact` - case-insensitive class name
2. `index` - class index (`"fighter"`)
3. `subclass-split` - class token plus subclass tokens, or a bare subclass name
4. `suffix` - the string starts/ends with a class token; the leftover becomes a (possibly homebrew) subclass
5. `alias` - small typo/shorthand map (`sorceror`, `rouge`, `pally`...), re-run through the ladder

Every non-exact hit is logged. A miss returns `{ className: null }`. All write
boundaries (`POST /characters`, quick-update, the AI editor) normalize through
the ladder, and `/levelinfo` answers `409 { unresolvedClass, suggestions }` so
the modal can show a **repair widget** instead of dead-ending.

**Repair migration:** on startup, `database.js` scans `characters` for
`class`/`classes` values that fail resolution and rewrites them through the same
ladder (class + subclass into `class_choices`), logging each repair and each
still-unresolvable row. It is idempotent - a repaired row is a no-op next boot.

**Spell-slot floor guard:** `computeSlotState` takes the stored slot state as a
floor. A recomputed max lower than the stored max (a misresolved class, a
non-caster mistake) can never shrink a character's slots; the stored max wins,
`current` is clamped to it, and the floored levels are reported to the caller
for logging.

### 6b. Appearance & Backstory System

**Appearance:**
- Physical description of the character (hair, eyes, height, build, distinguishing features)
- Set during character creation via AI conversation
- Can be edited using the Edit modal
- Displayed on character cards and party sidebar
- AI DM is aware of appearance for roleplay descriptions

**Backstory:**
- Character's personal history, motivations, and what drives them
- Typically 2-4 sentences capturing the character's story
- Set during character creation via AI conversation
- Can be edited using the Edit modal
- Displayed on character cards and party sidebar
- AI DM uses backstory to personalize narrative and roleplay moments

### 6d. Class Features System

**Class Features:**
- Class-specific abilities gained as characters level up
- Stored as comma-separated text (e.g., "Second Wind, Action Surge, Extra Attack")
- Displayed on character cards and party sidebar
- AI is aware of class features during character creation and level up
- Features are automatically added when leveling up

**Example Class Features by Class:**
| Class | Level 1 Features | Higher Level Features |
|-------|-----------------|----------------------|
| Fighter | Second Wind, Fighting Style | Action Surge (2), Extra Attack (5) |
| Barbarian | Rage, Unarmored Defense | Reckless Attack (2), Extra Attack (5) |
| Rogue | Sneak Attack, Expertise, Thieves' Cant | Cunning Action (2), Uncanny Dodge (5) |
| Bard | Bardic Inspiration, Spellcasting | Jack of All Trades (2), Song of Rest (2) |
| Cleric | Spellcasting, Divine Domain | Channel Divinity (2), Destroy Undead (5) |
| Wizard | Spellcasting, Arcane Recovery | Arcane Tradition (2) |
| Paladin | Divine Sense, Lay on Hands | Fighting Style (2), Divine Smite (2) |
| Monk | Unarmored Defense, Martial Arts | Ki (2), Deflect Missiles (3) |

### 6e. Feats & Multiclassing System

**Feats:**
- Characters can have feats (special abilities)
- Variant Humans get one feat at level 1
- Other characters can take a feat instead of ASI at levels 4, 8, 12, 16, 19
- Feats are comma-separated in the database
- Common feats: Great Weapon Master, Sharpshooter, Sentinel, Lucky, War Caster, Alert, Mobile, Tough, Polearm Master, Crossbow Expert
- DM AI is aware of feat mechanics and uses them in combat narration

**Multiclassing:**
- Characters can have levels in multiple classes
- Stored as JSON: `{"Fighter": 5, "Wizard": 2}`
- `class` field holds the primary class (highest level)
- `level` is total character level (sum of all classes)
- Display format: "Fighter 5 / Wizard 2"
- Level up asks which class to level
- Multiclass requirements enforced (13+ in key ability)

**Multiclass Requirements:**
| Class | Required Ability Score |
|-------|----------------------|
| Barbarian | STR 13 |
| Bard | CHA 13 |
| Cleric | WIS 13 |
| Druid | WIS 13 |
| Fighter | STR 13 or DEX 13 |
| Monk | DEX 13 and WIS 13 |
| Paladin | STR 13 and CHA 13 |
| Ranger | DEX 13 and WIS 13 |
| Rogue | DEX 13 |
| Sorcerer | CHA 13 |
| Warlock | CHA 13 |
| Wizard | INT 13 |

### 6f. Narrative Turn-Based Combat (NTC)

Combat is **text**, not a board. It plays out inside the normal story stream:
every resolution is written by the AI and appended to `full_history` as a
visible entry, so the fight reads as part of the narrative. A compact
initiative tracker panel shows order, round, HP and remaining points.

**Flow:**
1. **Start** - resolver-AI `combat` payload (auto) or `POST /:id/combat` (GM). Party units are built from the live session characters; enemies come from the payload/body. Enemy initiative is server-rolled immediately; phase is `initiative`
2. **Initiative** - each player rolls a d20 in the dice UI and posts it; the server adds the DEX-based bonus. The GM can auto-roll stragglers. When the last party unit rolls, the order sorts descending and phase becomes `active`
3. **Player turn** - only the active player's action bar is enabled. They type a freeform action (optionally with a dice roll); the **combat adjudicator** AI returns Adjudication JSON, the engine validates/clamps and applies it, deducts points, and narrates
4. **Enemy turn** - the server pre-rolls attack and damage dice from the seeded PRNG and hands them to the enemy-turn AI as authoritative results, so enemies can never roll in their own favour
5. **End** - a wiped side (victory/defeat) or an adjudicator `endCombat` effect (fled/negotiated -> `resolved`) closes the fight. A summary narration is written, and the deferred pre-combat narration is finally resolved

**AP/BP economy:**
- Each unit gets 1 Action Point and 1 Bonus Point at the start of its turn
- The adjudicator decides what an action costs; the engine clamps costs to what the unit actually has
- A player may submit multiple times per turn while points remain; the turn advances when points run out or the adjudicator sets `turnEnds`
- A stall cap force-ends a turn after too many submissions

**AI adjudication:**
- Adjudication JSON: `{ narration, costs: {ap, bp}, effects: [...], turnEnds }`
- Effect types: `damage`, `heal`, `condition` (add/remove), `spendSlot`, `useItem`, `useAbility`, `endCombat`
- Targets resolve fuzzily by unit name or id; amounts are clamped; unknown effect types are logged and ignored
- Malformed AI output is a safe no-op - the state is untouched and the player is told to try again
- If an **enemy-turn** AI call fails or returns junk, a deterministic fallback resolves that turn straight from the pre-rolled dice (hit if the attack roll meets AC), so a dead adjudicator can never stall a fight

**Character-sheet writeback:**
- Units carry the full sheet: HP, spell slots, inventory, class resources/features and known spells
- After *every* applied adjudication the engine returns a writeback list and the server persists HP / spell slots / inventory to `characters`, then emits `character_updated` - open character sheets update mid-fight

**Database (combats table):** unchanged DDL, new role. There is **one active row
per session** and `combatants` holds the entire serialized combat state blob
(not an array of combatants):
```sql
id TEXT PRIMARY KEY
session_id TEXT NOT NULL
name TEXT DEFAULT 'Combat'
is_active INTEGER DEFAULT 1
current_turn INTEGER DEFAULT 0   -- mirrors state.turnIndex for convenience
round INTEGER DEFAULT 1          -- mirrors state.round
combatants TEXT DEFAULT '[]'     -- JSON: the whole NTC state object (schema 2)
created_at DATETIME
```
The state object carries `schema`, `phase`, `round`, `turnOrder`, `turnIndex`,
`pendingInitiative`, `units[]` (hp/ac/attackBonus/ap/bp/conditions/spellSlots/
inventory...), `log[]`, `seed`/`rngState`, a `version` counter used for
optimistic concurrency, and an optional `deferredTurn`.

**Migration:** older sessions stored a schema-1 tactical grid blob. Any active
combat is transcoded to schema 2 lazily on load - stats, HP, spell slots,
powers, turn order, round and `deferredTurn` survive; grid fields (`grid`,
`x`/`y`, `movement`, `range`, `hasMoved`, `defending`) are dropped and
initiative is synthesized from the existing turn order. A mid-fight party
continues where it left off. The transcode is idempotent and is written back on
the first mutation.

**API Endpoints:**
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/sessions/:id/combat` | POST | GM starts an encounter (`{ enemies: [...] }`) |
| `/api/sessions/:id/combat/initiative` | POST | Player reports their d20 (`{ roll, characterId? }`) |
| `/api/sessions/:id/combat/roll-remaining` | POST | GM auto-rolls initiative for stragglers |
| `/api/sessions/:id/combat/turn-action` | POST | Active player's freeform action (`{ action, version? }`) |
| `/api/sessions/:id/combat/end` | POST | GM ends the encounter (writes a summary narration) |

The active combat is delivered with the session payload (`GET /api/sessions/:id`)
and pushed to every client over Socket.IO; there is no separate GET.

### 6g. Multiple API Configurations

**Features:**
- Store multiple API providers (OpenAI, DeepSeek, local LLMs, etc.)
- Each config has: name, endpoint, API key, model
- Only one config can be active at a time
- Switch between providers by activating different configs
- Test connections before adding or after configuring
- Cannot delete the last remaining config

**API Config Management:**
- View all configs as cards in Settings tab
- Active config highlighted with gold border
- Add new configurations with optional "set as active" checkbox
- Edit existing configurations (API key optional - leave blank to keep current)
- Delete inactive configurations
- Test any configuration

### 7. Built-in Dice Rolling
- AI DM rolls dice and calculates results
- Format: `[Rolling d20 + modifier... result vs DC/AC]`
- Uses character stats for modifiers

### 8. Theme Toggle
- Dark mode (default) and Light mode
- Saved in localStorage
- CSS custom properties for theming

---

## API Endpoints

### Authentication
- `POST /api/auth` - Verify game password
- `POST /api/admin-auth` - Verify admin password

### Settings
- `GET /api/settings` - Get general settings (admin only)
- `POST /api/settings` - Update general settings (admin only)
- `POST /api/test-connection` - Test AI API connection with provided credentials

### API Configurations
- `GET /api/api-configs` - List all API configurations (keys masked)
- `POST /api/api-configs` - Create new API configuration
- `PUT /api/api-configs/:id` - Update API configuration
- `DELETE /api/api-configs/:id` - Delete API configuration
- `POST /api/api-configs/:id/activate` - Set configuration as active
- `POST /api/test-connection/:id` - Test specific API configuration

### Characters
- `GET /api/characters` - List all characters
- `POST /api/characters` - Create character (manual)
- `POST /api/characters/ai-create` - AI-guided creation
- `DELETE /api/characters/:id` - Delete character
- `POST /api/characters/:id/levelup` - Level up character (interactive chat)
- `POST /api/characters/:id/edit` - AI-assisted editing
- `POST /api/characters/:id/xp` - Award/adjust XP (`{ amount: number }`)
- `POST /api/characters/:id/reset-xp` - Reset XP to 0
- `POST /api/characters/:id/gold` - Update character gold (`{ amount: number }`)
- `GET /api/characters/:id/inventory` - Get character inventory and gold
- `POST /api/characters/:id/inventory` - Manage inventory (`{ action: 'add'|'remove'|'set', item: string, quantity: number }`)
- `POST /api/characters/:id/ac` - Manage AC and effects
  - Legacy: `{ ac: number }` - Sets base AC value
  - Set base: `{ action: 'set_base', base_source: string, base_value: number }`
  - Add effect: `{ action: 'add_effect', effect: { name, value, type, temporary, notes } }`
  - Remove effect: `{ action: 'remove_effect', effect: { id } }` or `{ action: 'remove_effect', effect: { name } }`
  - Clear temporary: `{ action: 'clear_temporary' }`
  - Set all: `{ action: 'set_all', base_source, base_value, effects: [...] }`
- `POST /api/characters/:id/spell-slots` - Manage spell slots (`{ action: 'use'|'restore'|'set'|'rest'|'add'|'remove', level: number, current?: number, max?: number }`)

### Sessions
- `GET /api/sessions` - List all sessions
- `POST /api/sessions` - Create new session
- `GET /api/sessions/:id` - Get session details
- `DELETE /api/sessions/:id` - Delete session
- `POST /api/sessions/:id/action` - Submit player action
- `POST /api/sessions/:id/process` - Force process turn
- `POST /api/sessions/:id/recalculate-xp` - Scan history for XP
- `POST /api/sessions/:id/recalculate-loot` - Scan history for gold and items
- `POST /api/sessions/:id/recalculate-ac-spells` - Scan history for AC and spell slot usage
- `POST /api/sessions/:id/combat*` - Narrative combat (see [6f](#6f-narrative-turn-based-combat-ntc))

---

## Socket.IO Events

### Server -> Client
- `character_created` - New character added
- `character_deleted` - Character removed
- `character_updated` - Character modified (XP, stats, etc.)
- `character_leveled_up` - Character leveled up
- `session_created` - New session added
- `session_deleted` - Session removed
- `action_submitted` - Player submitted action
- `turn_processing` - AI is generating response (shows typing indicator)
- `turn_processed` - AI response complete (includes `povs` object with per-character narrations)
- `turn_chunk` - Streaming text chunk from AI (real-time display)
- `choices_generated` - On-demand choice generation result
- `reroll_started` - Reroll initiated (shows typing indicator)
- `session_compacted` - History auto-compacted
- `session_updated` - Session data changed (character added/removed)

---

## Default DM Instructions (System Prompt)

The system prompt is hardcoded in `server/services/aiService.js` as `DEFAULT_SYSTEM_PROMPT` (~1600 tokens). It covers:

**Sections (8 total):**
1. **Immersion & Narrative** — Webnovel-inspired prose, show-don't-tell, five senses, NPC autonomy
2. **HTML Rendering** — Diegetic objects (signs, documents, menus) rendered as inline HTML
3. **Dice Rolling** — d20 roll interpretation, outcome scaling (Nat 1 through 23+), proficiency rules
4. **Combat** — Narrative combat, DM rolls damage/enemy attacks, bloodied/near-death announcements
5. **Multiclass & Feats** — Key feat mechanics (GWM, Sentinel, Lucky, etc.)
6. **Tracking Tags** — All 7 mandatory tag formats (HP, XP, MONEY, ITEM, SPELL, REST, AC)
7. **Output Format — POV Narrations** — Entire response must be `[POV: Name]...[/POV]` blocks per character, followed by `[CHOICE:]` tags
8. **Multiplayer Rules** — Never control player characters, narrate only stated actions

**Tracking Tags (parsed automatically by the system):**
- `[HP: Name -10]` / `[HP: Name +5]` / `[HP: Name =30]`
- `[XP: Name +100]` / `[XP: Thorin +50, Elara +50]`
- `[MONEY: Name +50]` / `[MONEY: Name -25]`
- `[ITEM: Name +Sword of Fire]` / `[ITEM: Name -Health Potion]`
- `[SPELL: Name -1st]` / `[SPELL: Name +1st]`
- `[REST: Party]` / `[REST: Name]` — long rest (restores HP, spell slots, inspiration)
- `[AC: Name +Shield of Faith +2 spell]` / `[AC: Name -Shield of Faith]` / `[AC: Name base Plate Armor 18]`
- `[CHOICE: Name | STAT | DIFFICULTY | description]` — suggested next actions
- `[POV: Name]...[/POV]` — per-character 2nd-person narration blocks

**Important:** This is NOT editable via settings to ensure tracking always works.

---

## Frontend State Management

### Session Storage (Mobile Tab Switch Fix)
State is saved to `sessionStorage` to survive mobile browser tab switches:
- `password` - Game password
- `currentSessionId` - Active session
- `currentTab` - Active tab (game/characters/settings)
- `charCreationInProgress` - Character creation state
- `charCreationMessages` - Chat history during creation

### Local Storage
- `dnd-theme` - Dark/Light theme preference

---

## Styling Notes

### CSS Variables (Themes)
```css
/* Dark Theme */
--bg-dark: #1a1a2e
--bg-medium: #16213e
--bg-light: #0f3460
--accent: #e94560
--text: #eee

/* Light Theme */
--bg-dark: #f5f5f5
--bg-medium: #ffffff
--bg-light: #e8e8e8
--accent: #d63384
--text: #333333
```

### Responsive Breakpoints
- `768px` - Tablet (sidebar stacks below main content)
- `480px` - Mobile (simplified layouts)

### Sticky Navigation
Nav bar uses `position: sticky; top: 0; z-index: 100;` to stay visible on scroll.

---

## UI Components

### Character Cards (Characters Tab)
Each character card displays:
- Character name, player name, race/class/level
- **Appearance:** Physical description (hair, eyes, build, etc.)
- **Backstory:** Character's personal history and motivations
- **Multiclass display:** Shows "Fighter 5 / Wizard 2" format if multiclassed
- **Feats:** Shows list of character feats (if any)
- **Class Features:** Shows class abilities (Second Wind, Sneak Attack, etc.)
- 6 ability scores (STR, DEX, CON, INT, WIS, CHA)
- HP bar, AC, and gold amount
- Spell slots (if any) with available/used display
- XP progress bar with current/required XP
- Collapsible inventory section
- Skills, spells, passives, class features, appearance, backstory (if any)
- Action buttons: Edit, Inventory, Spells, Level Up, Reset XP

### Party Sidebar (Game Tab)
Shows all characters with:
- Name and level
- Race/class info (multiclass format if applicable)
- Appearance and backstory (if any)
- HP, AC, gold, XP (with "Ready!" indicator)
- Spell slots (if any)
- Feats (if any)
- Class features (if any)
- All 6 stats in compact view
- Skills, spells, passives, class features, items
- Quick action buttons: Inventory, Spells, Level Up

### Initiative Tracker (Game Tab)
The story stream stays visible during combat - there is no full-screen takeover.
- **No Combat:** Hidden; the GM has a Start Encounter control
- **Initiative phase:** Prompts each player to roll their d20; GM gets "Roll remaining"
- **Active phase:** Compact list in initiative order with round counter, active-turn marker, HP bars and AP/BP pips
- **Action bar:** Enabled only on your own turn ("Your turn - Round N"); freeform text plus the usual dice roll
- **Controls:** GM-only End Encounter (writes a summary narration)

### Modals
- **Edit Modal:** Chat interface for AI-assisted character editing (supports appearance, backstory, feats, class features, and multiclass)
- **Quick Edit Modal:** Direct text field editing for appearance, backstory, class features, passives, feats (no AI needed)
- **Level Up Modal:** Chat interface for guided level up (multiclass, ASI/Feat choices, and new class features)
- **Inventory Modal:** Direct management of gold and items
- **Spell Slots Modal:** AC editor and visual spell slot management with pip interface
- **Admin Login Modal:** Password entry for settings access
- **API Edit Modal:** Edit existing API configurations (name, endpoint, model, key)
- **Start Encounter Modal (GM):** Name the encounter and list enemies (HP, AC, attack/damage); the party is taken from the session

### Helper Functions (Frontend)
- `escapeHtml(str)` - Prevents XSS in user-generated content
- `formatChatMessage(msg)` - Converts markdown-like formatting to HTML
- `getRequiredXP(level)` - Returns XP needed for next level
- `canLevelUp(xp, level)` - Checks if character can level up
- `formatSpellSlots(spellSlots)` - Formats spell slots for character cards
- `formatSpellSlotsShort(spellSlots)` - Compact format for party sidebar

---

## Deployment (Easypanel)

### Environment Variables
```
PORT=3000
NODE_ENV=production
GAME_PASSWORD=your_game_password
ADMIN_PASSWORD=your_admin_password
```

### Volume Mount
Mount `/app/data` to persist the SQLite database.

### Docker
The Dockerfile:
1. Uses Node 18 Alpine
2. Installs dependencies
3. Creates data directory
4. Exposes port 3000
5. Runs `node server/index.js`

---

## Common Issues & Solutions

### 1. "Cannot open database" error
- Ensure `/app/data` volume is mounted in Easypanel
- Server auto-creates directory if missing

### 2. DeepSeek API 404
- Correct endpoint: `https://api.deepseek.com/v1/chat/completions`
- Use `deepseek-chat` model (not `deepseek-reasoner` for regular chat)

### 3. AI response format issues
- `extractAIMessage()` helper handles both OpenAI and Anthropic response formats
- OpenAI: `choices[0].message.content`
- Anthropic: `content[0].text`
- All AI calls (narration, compaction, auto-reply, test connection) route through `aiService.callAI()` which auto-detects the provider from the endpoint URL

### 4. XP not updating
- AI must use exact format: `[XP: CharacterName +100]`
- Use "Recalculate XP" button to scan existing history
- Check character name matches exactly (case-insensitive)

### 5. Mobile refresh losing state
- Fixed with sessionStorage persistence
- State saved on `visibilitychange` and `beforeunload` events

### 6. Gold/Items not updating
- AI must use exact format: `[GOLD: CharacterName +50]` or `[ITEM: CharacterName +ItemName]`
- Use "Recalculate Loot" button to scan existing history
- Check character name matches exactly (case-insensitive)
- Items with quantity: `[ITEM: CharacterName +Health Potion x3]`

### 7. Level up not working
- Character must have enough XP (check XP thresholds table above)
- Button is disabled if not enough XP
- Level up is now interactive - chat with the AI to complete

---

## Security Features

### Authentication
- **Game Password:** bcrypt hashed, required for all API endpoints
- **Admin Password:** Separate password for settings access
- Both passwords configurable via environment variables

### Access Control Layers
- In-app auth is enforced with `X-Game-Password` for API and socket handshake
- Admin-only endpoints additionally require `X-Admin-Password`
- Optional EasyPanel/Traefik basic auth can be used as an outer layer

### SSRF Protection for AI Endpoints
- API config/test endpoints validate target URLs before outbound requests.
- By default, blocked targets include localhost, private ranges, link-local, loopback, and hosts resolving to private IPs.
- HTTPS is required by default.
- Escape hatches (use with caution):
  - `ALLOW_PRIVATE_AI_ENDPOINTS=true`
  - `ALLOW_INSECURE_AI_ENDPOINTS=true`

### Rate Limiting
- Not currently enabled in server code
- If needed, add reverse-proxy limits (EasyPanel/Traefik) or reintroduce app-level middleware

### HTML Sanitization
- AI narration may contain HTML (for diegetic objects like signs, documents)
- `sanitizeHtml()` strips all `on*` event handler attributes (not just a fixed list)
- Removes `script`, `iframe`, `object`, `embed`, `form`, `link`, `meta`, `base` elements
- Blocks `javascript:` and `data:` protocol URIs on `href`/`src` attributes
- Error messages are escaped with `escapeHtml()` before any innerHTML injection

### API Key Protection
- API key is masked in settings response (shows only `****xxxx`)
- Full key never sent to frontend after initial setup
- Key only updated if new value provided (not masked value)

### Admin Access
- Settings tab requires admin password
- Proper modal dialog (not browser prompt)
- Admin auth state stored in memory (not persisted)

---

## Future Improvements (Ideas)

- [x] Inventory system (implemented!)
- [x] Gold tracking (implemented!)
- [x] Interactive level up with AI chat (implemented!)
- [x] Reset XP feature (implemented!)
- [x] Party sidebar quick actions (implemented!)
- [x] AC (Armor Class) tracking (implemented!)
- [x] Spell Slots tracking with visual UI (implemented!)
- [x] Feats system with Variant Human support (implemented!)
- [x] Multiclassing with JSON class tracking (implemented!)
- [x] Multiple API configurations (implemented!)
- [x] Class Features tracking (implemented!)
- [x] Appearance & Backstory tracking (implemented!)
- [x] Narrative turn-based combat with initiative, AP/BP and AI adjudication (implemented!)
- [x] Per-character POV narrations (implemented!)
- [x] Long Rest tag with full resource restoration (implemented!)
- [x] Anthropic API provider support (implemented!)
- [x] Optimized DM system prompt — 56% token reduction (implemented!)
- [ ] Map/image uploads
- [ ] Multiple campaigns per session
- [ ] Character import/export
- [ ] Dice roll history log
- [ ] NPC/Monster database
- [ ] Voice integration
- [ ] Session-specific party loot pool
- [ ] Equipment vs consumable item distinction

---

## Git Repository

**Repository:** https://github.com/jeromehbonaparte-star/dnd-multiplayer

### Cloning
```bash
git clone https://github.com/jeromehbonaparte-star/dnd-multiplayer.git
cd dnd-multiplayer
npm install
```

### Running Locally
```bash
# Set environment variables (optional)
export GAME_PASSWORD=yourpassword
export ADMIN_PASSWORD=youradminpassword

# Start the server
npm start
```

### Deployment
The project is deployed on Easypanel (Linode). Any push to `main` branch will trigger a rebuild.

---

## Contact

Created for Jerome and friends to play D&D together remotely.

Git email: `jeromehbonaparte@gmail.com`
