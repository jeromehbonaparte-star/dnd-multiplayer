# D&D Multiplayer

A real-time multiplayer D&D (Dungeons & Dragons 5e) web application with an AI-powered Dungeon Master. Players can create characters, join sessions, and play together with an AI narrating the story.

## Features

- **AI Dungeon Master** - Uses OpenAI-compatible APIs (OpenAI, DeepSeek, OpenRouter, etc.)
- **Split AI Roles** - Independently assign models for narration, POV prose, and backend rules/bookkeeping work
- **Real-time Multiplayer** - Socket.IO powered live updates
- **AI-Guided Character Creation** - Chat-based Level 1 character creation
- **Turn-Based Gameplay** - All players submit actions, then AI narrates the outcome
- **Automatic Dice Rolling** - AI rolls dice and calculates results using character stats
- **Narrative Turn-Based Combat** - Text combat inside the story stream: players roll initiative, then describe what they do on their turn while the AI adjudicates costs, dice and effects against a server-authoritative state (AI-driven enemy turns, live spell slot and HP writeback); the narrator writes the aftermath once the fight resolves
- **YouTube DJ** - Optional shared, scene-matched music that changes with every narrated turn
- **Illustrated POV Stage** - Players can generate avatar-referenced scene art for their own POV, shared live across devices
- **XP Tracking** - Automatic XP parsing from AI responses with D&D 5e leveling
- **Gold & Inventory System** - Track gold and items automatically from gameplay
- **AI-Assisted Level Up** - Guided stat increases, new abilities, and spell selection
- **Auto-Compact History** - Summarizes old messages to save tokens while preserving full chat for players
- **Dark/Light Theme** - Toggle between themes
- **Mobile Responsive** - Works on desktop and mobile devices

## Tech Stack

- **Backend:** Node.js, Express.js, Socket.IO
- **Database:** SQLite (better-sqlite3)
- **Frontend:** Vanilla HTML/CSS/JavaScript
- **AI Integration:** OpenAI-compatible API
- **Auth:** bcrypt for password hashing
- **Deployment:** Docker

## Quick Start

### Prerequisites
- Node.js 18+
- npm

### Installation

```bash
git clone https://github.com/jeromehbonaparte-star/dnd-multiplayer.git
cd dnd-multiplayer
npm install
```

### Configuration

Set environment variables (required for predictable production auth):

```bash
export GAME_PASSWORD=yourpassword
export ADMIN_PASSWORD=youradminpassword
export PORT=3000
```

If `GAME_PASSWORD` or `ADMIN_PASSWORD` is missing, the server will generate a random password on first run and print it to logs.

### Running

```bash
npm start
```

Visit `http://localhost:3000` in your browser.

## Docker Deployment

```bash
docker build -t dnd-multiplayer .
docker run -p 3000:3000 -v ./data:/app/data -e GAME_PASSWORD=secret -e ADMIN_PASSWORD=admin dnd-multiplayer
```

## Usage

### First Time Setup
1. Login with the game password
2. Go to **Settings** (requires admin password)
3. Add and test the API configurations you want to use
4. Select a **Narrator Model**, **POV Model**, and **Agent Model** under Model Roles
5. Leaving any role on the active-configuration fallback preserves the previous single-model behavior
6. Optional: add a YouTube Data API v3 key in Settings and enable YouTube DJ
7. Optional: configure an OpenAI Images, NanoGPT, or compatible chat image API and enable POV Scene Images

Note: if EasyPanel/Traefik basic auth is enabled, users will authenticate twice (proxy layer + in-app game password).

### SSRF Protection

- API endpoint validation blocks localhost/private IP targets by default.
- `https://` endpoints are required by default.
- Override only when intentionally needed:

```bash
export ALLOW_PRIVATE_AI_ENDPOINTS=false
export ALLOW_INSECURE_AI_ENDPOINTS=false
```

### Creating Characters
1. Go to **Characters** tab
2. Click "Start Character Creation"
3. Chat with the AI to create your Level 1 character

### Playing a Session
1. Go to **Game** tab
2. Create a new session or select existing one
3. Select your character and describe your action
4. Wait for all players to submit, or use "Force Process Turn"
5. AI narrates the outcome!

## AI Tracking Formats

The AI DM automatically tracks the following when it uses these formats:

| Type | Format | Example |
|------|--------|---------|
| XP | `[XP: Name +amount]` | `[XP: Thorin +50, Elara +50]` |
| Gold | `[GOLD: Name +/-amount]` | `[GOLD: Thorin +100, Elara -25]` |
| Items | `[ITEM: Name +/-item]` | `[ITEM: Thorin +Sword of Fire]` |

Use "Recalculate XP" or "Recalculate Loot" buttons to scan existing chat history.

## API Endpoints

### Authentication
- `POST /api/auth` - Verify game password
- `POST /api/admin-auth` - Verify admin password

### Characters
- `GET /api/characters` - List all characters
- `POST /api/characters/ai-create` - AI-guided creation
- `POST /api/characters/:id/levelup` - Level up character
- `POST /api/characters/:id/edit` - AI-assisted editing
- `POST /api/characters/:id/gold` - Update gold
- `POST /api/characters/:id/inventory` - Manage inventory

### Sessions
- `GET /api/sessions` - List sessions
- `POST /api/sessions` - Create session
- `POST /api/sessions/:id/action` - Submit action
- `POST /api/sessions/:id/process` - Force process turn
- `POST /api/sessions/:id/recalculate-xp` - Scan for XP
- `POST /api/sessions/:id/recalculate-loot` - Scan for gold/items

## Project Structure

```
dnd-multiplayer/
├── server/
│   └── index.js          # Backend server
├── public/
│   ├── index.html        # Single-page app
│   ├── css/style.css     # Styling
│   └── js/app.js         # Frontend logic
├── data/
│   └── dnd.db            # SQLite database (created at runtime)
├── Dockerfile
├── package.json
├── DOCUMENTATION.md      # Detailed documentation
└── README.md
```

## Documentation

See [DOCUMENTATION.md](DOCUMENTATION.md) for detailed technical documentation including:
- Database schema
- Socket.IO events
- Frontend state management
- Security features
- Troubleshooting

## License

MIT

## Contact

Created by Jerome for playing D&D with friends remotely.

GitHub: [@jeromehbonaparte-star](https://github.com/jeromehbonaparte-star)
