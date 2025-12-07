# D&D Multiplayer - Project Documentation

## Overview

A real-time multiplayer D&D (Dungeons & Dragons 5e) web application with an AI-powered Dungeon Master. Players can create characters, join sessions, and play together with an AI narrating the story.

**Live URL:** `dnd.romyromulus.com`
**Deployment:** Easypanel on Linode
**Repository:** `github.com/jeromehbonaparte-star/dnd-multiplayer`

---

## Tech Stack

- **Backend:** Node.js, Express.js, Socket.IO
- **Database:** SQLite (better-sqlite3)
- **Frontend:** Vanilla HTML/CSS/JavaScript
- **AI Integration:** OpenAI-compatible API (works with DeepSeek, OpenRouter, etc.)
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
Keys: `game_password`, `admin_password`, `api_endpoint`, `api_key`, `api_model`, `max_tokens_before_compact`

**characters**
```sql
id TEXT PRIMARY KEY
player_name TEXT
character_name TEXT
race TEXT
class TEXT
level INTEGER DEFAULT 1
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
inventory TEXT DEFAULT '[]'  -- JSON array of {name, quantity}
ac INTEGER DEFAULT 10        -- Armor Class with all bonuses
spell_slots TEXT DEFAULT '{}' -- JSON object {level: {current, max}}
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
full_history TEXT           # JSON array of all messages (always shown to players)
compacted_count INTEGER     # Number of messages summarized
current_turn INTEGER
total_tokens INTEGER
is_active INTEGER
created_at DATETIME
```

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
- Creates Level 1 D&D 5e characters
- Endpoint: `POST /api/characters/ai-create`

### 3. Turn-Based Gameplay
- All players submit actions before AI processes the turn
- AI receives party status + actions and narrates outcome
- "Force Process Turn" button for DM override
- Real-time updates via Socket.IO

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

### 5b. Gold & Inventory System
- AI awards gold using format: `[GOLD: CharacterName +50, OtherCharacter -25]`
- AI tracks items using format: `[ITEM: CharacterName +Sword of Fire, CharacterName +Health Potion x3]`
- Items can be removed: `[ITEM: CharacterName -Health Potion]`
- Gold and inventory automatically parsed and updated on character sheets
- "Recalculate Loot" button scans existing history for GOLD and ITEM tags
- Inventory displayed in character cards with collapsible view
- Inventory modal for manual management (add/remove items, update gold)

### 5c. AC & Spell Slots System
**Armor Class (AC):**
- AC is tracked with all bonuses applied
- Default AC is 10
- Can be manually updated via Spell Slots modal
- Displayed in character cards and party sidebar

**Spell Slots:**
- AI tracks spell slot usage using format: `[SPELL: CharacterName -1st]` (uses one 1st level slot)
- AI tracks spell slot restoration: `[SPELL: CharacterName +REST]` (restores all slots)
- Spell slots stored as JSON: `{level: {current: X, max: Y}}`
- Visual pip interface in Spell Slots modal (click to use/restore)
- Long Rest button restores all spell slots
- Add/remove spell slot levels for class flexibility
- Displayed in character cards and party sidebar
- "Recalculate AC/Spells" button scans existing history for:
  - [SPELL:] tags
  - Natural language spell casting (e.g., "Gandalf casts Fireball using a 3rd level slot")
  - AC mentions near character names (e.g., "Your AC is now 16")

### 6. AI-Assisted Level Up & Editing

**Level Up (Interactive Chat):**
- Opens a chat modal when clicking "Level Up" button
- AI guides player through the level up process conversationally
- Covers: HP increase (rolls hit die + CON mod), new class features, spell selection
- At levels 4, 8, 12, 16, 19: AI asks about Ability Score Improvements
- Player can discuss choices before finalizing
- Endpoint: `POST /api/characters/:id/levelup` (with `messages` array for conversation)

**Character Editing:**
- Opens chat modal for free-form editing
- Can update stats, equipment, spells, skills, backstory, etc.
- AI confirms changes before applying
- Endpoint: `POST /api/characters/:id/edit`

**Party Sidebar Quick Actions:**
- Inventory button: Opens inventory management modal
- Level Up button: Highlighted green when ready, disabled when not enough XP

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

### Settings (Admin only)
- `GET /api/settings` - Get all settings
- `POST /api/settings` - Update settings
- `POST /api/test-connection` - Test AI API connection

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
- `POST /api/characters/:id/ac` - Update character AC (`{ ac: number }`)
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
- `turn_processed` - AI response complete

---

## Default DM Instructions (System Prompt)

The system prompt is hardcoded in `server/index.js` as `DEFAULT_SYSTEM_PROMPT`. It includes:
- Role instructions for AI DM
- Dice rolling format and calculation rules
- Combat mechanics
- XP award format: `[XP: CharacterName +100]`
- Gold award format: `[GOLD: CharacterName +50]`
- Item tracking format: `[ITEM: CharacterName +Sword of Fire]`
- Spell slot tracking format: `[SPELL: CharacterName -1st]` or `[SPELL: CharacterName +REST]`

**Important:** This is NOT editable via settings to ensure XP/gold/inventory/spell tracking always works.

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
- 6 ability scores (STR, DEX, CON, INT, WIS, CHA)
- HP bar, AC, and gold amount
- Spell slots (if any) with available/used display
- XP progress bar with current/required XP
- Collapsible inventory section
- Skills, spells, and passives (if any)
- Action buttons: Edit, Inventory, Spells, Level Up, Reset XP

### Party Sidebar (Game Tab)
Shows all characters with:
- Name and level
- Race/class info
- HP, AC, gold, XP (with "Ready!" indicator)
- Spell slots (if any)
- All 6 stats in compact view
- Skills, spells, passives, items
- Quick action buttons: Inventory, Spells, Level Up

### Modals
- **Edit Modal:** Chat interface for AI-assisted character editing
- **Level Up Modal:** Chat interface for guided level up
- **Inventory Modal:** Direct management of gold and items
- **Spell Slots Modal:** AC editor and visual spell slot management with pip interface
- **Admin Login Modal:** Password entry for settings access

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
- `extractAIMessage()` helper handles different API response formats
- Checks `choices[0].message.content` and fallbacks

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

### Rate Limiting
- **Auth endpoints:** 10 attempts per 15 minutes (prevents brute force)
- **General API:** 100 requests per minute
- Uses `express-rate-limit` package

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
- [ ] Combat tracker with initiative
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
