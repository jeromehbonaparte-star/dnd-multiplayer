# D&D Multiplayer

A real-time multiplayer D&D (Dungeons & Dragons 5e) web application with an AI-powered Dungeon Master. Players can create characters, join sessions, and play together with an AI narrating the story.

## Features

- **AI Dungeon Master** - Uses OpenAI-compatible APIs (OpenAI, DeepSeek, OpenRouter, etc.)
- **Real-time Multiplayer** - Socket.IO powered live updates
- **AI-Guided Character Creation** - Chat-based Level 1 character creation
- **Turn-Based Gameplay** - All players submit actions, then AI narrates the outcome
- **Automatic Dice Rolling** - AI rolls dice and calculates results using character stats
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

Set environment variables (optional - defaults provided):

```bash
export GAME_PASSWORD=yourpassword      # Default: changeme
export ADMIN_PASSWORD=youradminpassword # Default: admin123
export PORT=3000                        # Default: 3000
```

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
3. Configure your AI API endpoint, key, and model
4. Test the connection

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
