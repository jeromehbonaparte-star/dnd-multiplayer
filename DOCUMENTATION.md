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
- D&D 5e XP table for leveling (Level 2 = 300 XP, Level 3 = 900 XP, etc.)

### 6. AI-Assisted Level Up & Editing
- Level up endpoint: `POST /api/characters/:id/levelup`
- Edit endpoint: `POST /api/characters/:id/edit`
- AI guides stat increases, new abilities, spell selection

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
- `POST /api/characters/:id/levelup` - Level up character
- `POST /api/characters/:id/edit` - AI-assisted editing

### Sessions
- `GET /api/sessions` - List all sessions
- `POST /api/sessions` - Create new session
- `GET /api/sessions/:id` - Get session details
- `DELETE /api/sessions/:id` - Delete session
- `POST /api/sessions/:id/action` - Submit player action
- `POST /api/sessions/:id/process` - Force process turn
- `POST /api/sessions/:id/recalculate-xp` - Scan history for XP

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

**Important:** This is NOT editable via settings to ensure XP tracking always works.

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

- [ ] Inventory system
- [ ] Combat tracker with initiative
- [ ] Map/image uploads
- [ ] Multiple campaigns per session
- [ ] Character import/export
- [ ] Dice roll history log
- [ ] NPC/Monster database
- [ ] Voice integration

---

## Contact

Created for Jerome and friends to play D&D together remotely.

Git email: `jeromehbonaparte@gmail.com`
