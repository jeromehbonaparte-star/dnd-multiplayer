# D&D Multiplayer - Update Guide

This guide covers how to update and maintain the D&D Multiplayer project. Follow these steps to ensure changes are properly integrated across all systems.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Development Setup](#development-setup)
3. [Database Changes](#database-changes)
4. [Adding New Features](#adding-new-features)
5. [Updating AI Prompts](#updating-ai-prompts)
6. [Frontend Updates](#frontend-updates)
7. [Testing](#testing)
8. [Deployment](#deployment)
9. [Troubleshooting](#troubleshooting)

---

## Project Overview

### File Structure
```
dnd-multiplayer/
├── server/index.js      # Backend (API, database, AI logic)
├── public/
│   ├── index.html       # HTML structure and modals
│   ├── css/style.css    # All styling
│   └── js/app.js        # Frontend JavaScript
├── data/dnd.db          # SQLite database (runtime)
├── Dockerfile           # Docker deployment
└── DOCUMENTATION.md     # Full project documentation
```

### Key Systems
1. **Authentication** - Game password + Admin password
2. **Character System** - Creation, editing, level up, stats, feats, multiclass
3. **Session System** - Turn-based gameplay with AI DM
4. **Tracking Systems** - XP, gold, inventory, AC, spell slots
5. **API Configuration** - Multiple AI provider support

---

## Development Setup

### Prerequisites
- Node.js 18+
- npm

### Local Development
```bash
# Clone repository
git clone https://github.com/jeromehbonaparte-star/dnd-multiplayer.git
cd dnd-multiplayer

# Install dependencies
npm install

# Set environment variables (optional)
export GAME_PASSWORD=yourpassword
export ADMIN_PASSWORD=youradminpassword

# Start development server
npm start
```

Server runs at `http://localhost:3000`

---

## Database Changes

### Adding New Columns

When adding new data to existing tables, follow this pattern:

1. **Check if column exists** (for safe migrations):
```javascript
// In server/index.js after database initialization
const columns = db.prepare("PRAGMA table_info(characters)").all().map(c => c.name);

if (!columns.includes('new_column')) {
  db.exec("ALTER TABLE characters ADD COLUMN new_column TEXT DEFAULT ''");
  console.log('Added new_column to characters');
}
```

2. **Migrate existing data** (if needed):
```javascript
// Example: Migrating existing characters to new format
const charsToMigrate = db.prepare(
  "SELECT id, old_field FROM characters WHERE new_column = '' OR new_column IS NULL"
).all();

for (const char of charsToMigrate) {
  // Transform old_field to new_column format
  const newValue = transformData(char.old_field);
  db.prepare("UPDATE characters SET new_column = ? WHERE id = ?")
    .run(newValue, char.id);
}
```

### Adding New Tables

```javascript
// Create table if not exists
db.exec(`
  CREATE TABLE IF NOT EXISTS new_table (
    id TEXT PRIMARY KEY,
    field1 TEXT NOT NULL,
    field2 INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
```

### Database Location
- **Development:** `./data/dnd.db`
- **Production (Docker):** `/app/data/dnd.db` (must be mounted as volume)

---

## Adding New Features

### Checklist for New Features

1. [ ] **Database** - Add columns/tables with migrations
2. [ ] **API Endpoints** - Create CRUD operations
3. [ ] **AI Prompts** - Update system prompts if AI needs to handle it
4. [ ] **Frontend HTML** - Add UI elements and modals
5. [ ] **Frontend JS** - Add functions and event handlers
6. [ ] **CSS** - Style new components
7. [ ] **Socket Events** - Add real-time updates if needed
8. [ ] **Documentation** - Update DOCUMENTATION.md

### Example: Adding a New Tracking System

Let's say you want to add "Inspiration" tracking:

#### 1. Database (server/index.js)
```javascript
// Add column
const columns = db.prepare("PRAGMA table_info(characters)").all().map(c => c.name);
if (!columns.includes('inspiration')) {
  db.exec("ALTER TABLE characters ADD COLUMN inspiration INTEGER DEFAULT 0");
}
```

#### 2. API Endpoint (server/index.js)
```javascript
// Toggle inspiration
app.post('/api/characters/:id/inspiration', checkPassword, (req, res) => {
  const { id } = req.params;
  const char = db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
  if (!char) return res.status(404).json({ error: 'Character not found' });

  const newValue = char.inspiration ? 0 : 1;
  db.prepare('UPDATE characters SET inspiration = ? WHERE id = ?').run(newValue, id);

  const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
  io.emit('character_updated', updated);
  res.json(updated);
});
```

#### 3. AI Prompt (server/index.js)
```javascript
// Add to DEFAULT_SYSTEM_PROMPT
INSPIRATION:
- Award inspiration with [INSPIRATION: CharacterName +1] or [INSPIRATION: CharacterName -1]
- Inspiration is binary (have it or don't)
```

#### 4. Frontend HTML (public/index.html)
```html
<!-- Add button to character card -->
<button onclick="toggleInspiration('${c.id}')" class="btn-inspiration ${c.inspiration ? 'has-inspiration' : ''}">
  Inspiration: ${c.inspiration ? 'Yes' : 'No'}
</button>
```

#### 5. Frontend JS (public/js/app.js)
```javascript
async function toggleInspiration(charId) {
  await api(`/api/characters/${charId}/inspiration`, 'POST');
}
```

#### 6. CSS (public/css/style.css)
```css
.btn-inspiration { background: var(--bg-light); }
.btn-inspiration.has-inspiration { background: gold; color: #000; }
```

#### 7. Update renderCharactersList() and renderParty()
Add inspiration display to both functions.

---

## Updating AI Prompts

### Prompt Locations (server/index.js)

1. **DEFAULT_SYSTEM_PROMPT** - Main DM instructions for gameplay
2. **CHARACTER_CREATION_PROMPT** - Character creation AI
3. **Level up prompt** - Inside `/api/characters/:id/levelup` endpoint
4. **Edit prompt** - Inside `/api/characters/:id/edit` endpoint

### Format Tags
The AI uses specific tags that are parsed by the backend:

| Tag | Purpose | Example |
|-----|---------|---------|
| `[XP: Name +X]` | Award XP | `[XP: Gandalf +100]` |
| `[GOLD: Name +X]` | Award/deduct gold | `[GOLD: Frodo -50]` |
| `[ITEM: Name +X]` | Add item | `[ITEM: Aragorn +Sword of Fire]` |
| `[ITEM: Name -X]` | Remove item | `[ITEM: Sam -Rope]` |
| `[SPELL: Name -Xst]` | Use spell slot | `[SPELL: Gandalf -3rd]` |
| `[SPELL: Name +REST]` | Restore slots | `[SPELL: Gandalf +REST]` |

### Adding New Tags

1. **Add to system prompt:**
```javascript
// In DEFAULT_SYSTEM_PROMPT
NEW_TRACKING:
- Use format: [NEWTAG: CharacterName +value]
```

2. **Add parser function:**
```javascript
function parseNewTags(content, sessionId) {
  const regex = /\[NEWTAG:\s*([^\]]+)\]/gi;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const entries = match[1].split(',').map(e => e.trim());
    for (const entry of entries) {
      // Parse and update database
    }
  }
}
```

3. **Call parser in processAITurn:**
```javascript
// After AI response
parseNewTags(aiContent, session.id);
```

---

## Frontend Updates

### Adding New UI Elements

1. **HTML Structure** - Add to appropriate tab in `public/index.html`
2. **Styling** - Add CSS in `public/css/style.css`
3. **JavaScript** - Add functions in `public/js/app.js`

### Modal Pattern
```html
<!-- HTML -->
<div id="new-modal" class="modal">
  <div class="modal-content">
    <span class="modal-close" onclick="closeNewModal()">&times;</span>
    <h2>Modal Title</h2>
    <!-- Content -->
    <div class="modal-buttons">
      <button onclick="saveNewModal()" class="btn-primary">Save</button>
      <button onclick="closeNewModal()" class="btn-secondary">Cancel</button>
    </div>
  </div>
</div>
```

```javascript
// JavaScript
function openNewModal() {
  document.getElementById('new-modal').classList.add('active');
}

function closeNewModal() {
  document.getElementById('new-modal').classList.remove('active');
}

async function saveNewModal() {
  // API call
  closeNewModal();
}
```

### Theme Support
Always use CSS variables for colors:
```css
.new-element {
  background: var(--bg-medium);
  color: var(--text);
  border: 1px solid var(--bg-light);
}
```

---

## Testing

### Manual Testing Checklist

Before deploying, test these scenarios:

#### Authentication
- [ ] Game password login works
- [ ] Admin password for settings works
- [ ] Invalid passwords show error

#### Characters
- [ ] Create character (AI-guided)
- [ ] Edit character stats/skills/spells
- [ ] Level up (single class)
- [ ] Level up (multiclass)
- [ ] Add/remove feats
- [ ] Reset XP
- [ ] Delete character

#### Inventory System
- [ ] Add items manually
- [ ] Remove items
- [ ] Update gold
- [ ] AI awards gold (check parsing)
- [ ] AI awards items (check parsing)

#### Spell Slots
- [ ] Add spell slot levels
- [ ] Use spell slots (click pips)
- [ ] Long rest restores all
- [ ] AI tracks spell usage

#### Sessions
- [ ] Create session
- [ ] Submit actions
- [ ] AI processes turn
- [ ] Force process turn
- [ ] Recalculate buttons work
- [ ] Delete session

#### Combat Tracker
- [ ] Start new combat
- [ ] Roll party initiative
- [ ] Add enemies/NPCs
- [ ] Initiative order sorted correctly
- [ ] Next/Previous turn works
- [ ] Round counter increments
- [ ] Edit combatant HP, conditions
- [ ] Add combatant mid-combat
- [ ] Remove combatant
- [ ] End combat
- [ ] HP syncs with character sheets
- [ ] Real-time updates across clients

#### API Configurations
- [ ] Add new config
- [ ] Edit existing config
- [ ] Delete config (not last one)
- [ ] Activate different config
- [ ] Test connection

#### Responsiveness
- [ ] Desktop view
- [ ] Tablet view (768px)
- [ ] Mobile view (480px)
- [ ] Theme toggle (dark/light)

### API Testing
Test endpoints with curl or Postman:
```bash
# Test auth
curl -X POST http://localhost:3000/api/auth \
  -H "Content-Type: application/json" \
  -d '{"password": "yourpassword"}'

# Test AI connection
curl -X POST http://localhost:3000/api/test-connection \
  -H "Content-Type: application/json" \
  -d '{"password": "yourpassword"}'
```

---

## Deployment

### Easypanel (Current Setup)

1. **Push to GitHub:**
```bash
git add .
git commit -m "Your changes"
git push origin main
```

2. **Easypanel auto-deploys** from main branch

3. **Verify deployment:**
   - Check application logs in Easypanel
   - Test at `dnd.romyromulus.com`

### Environment Variables (Required)
```
PORT=3000
NODE_ENV=production
GAME_PASSWORD=your_game_password
ADMIN_PASSWORD=your_admin_password
```

### Volume Mount (Critical!)
Mount `/app/data` to persist the SQLite database between deployments.

### Docker Build
The Dockerfile handles:
1. Node 18 Alpine base
2. npm install
3. Data directory creation
4. Port 3000 exposure

---

## Troubleshooting

### Common Issues

#### "Cannot open database"
- Ensure volume is mounted at `/app/data`
- Check directory permissions
- Server auto-creates directory but needs write access

#### AI Not Responding
- Check API config is active
- Test connection in settings
- Verify API key is valid
- Check endpoint URL format

#### XP/Gold/Items Not Updating
- AI must use exact tag format
- Character name must match (case-insensitive)
- Use Recalculate buttons to scan history
- Check server logs for parsing errors

#### Mobile State Lost
- sessionStorage handles this
- Check `visibilitychange` event handler
- Verify state restoration in `window.onload`

#### Socket Disconnections
- Check network stability
- Socket.IO auto-reconnects
- Watch for "Connected to server" log

### Debugging

#### Server Logs
```javascript
// Add console.log for debugging
console.log('Processing:', data);
```

#### Frontend Debugging
```javascript
// Check state
console.log('Characters:', characters);
console.log('Sessions:', sessions);

// Check API responses
const response = await api('/api/characters');
console.log('API Response:', response);
```

#### Database Queries
```javascript
// Check database content
const all = db.prepare('SELECT * FROM characters').all();
console.log('All characters:', all);
```

---

## Version History

### Latest Features
- **Beautified Session UI** - Character sheets hidden from main chat, player actions shown as individual character bubbles with avatars and colors
- **Combat Tracker with Initiative** - Full turn-based combat management
- **Class Features tracking** - Fighter's Second Wind, Bard's Song of Rest, etc.
- **Appearance & Backstory** - Character descriptions and history
- **Quick Edit modal** - Direct editing of text fields without AI
- Multiple API configurations
- Feats and multiclassing support
- AC and spell slot tracking
- Gold and inventory system
- XP system with level up
- AI-guided character creation and editing

### Migration Notes
When updating from older versions:
1. Database migrations run automatically on startup
2. Old API settings are preserved but new `api_configs` table is used
3. Existing characters are migrated to new `classes` JSON format

---

## Contact

- **Repository:** https://github.com/jeromehbonaparte-star/dnd-multiplayer
- **Email:** jeromehbonaparte@gmail.com

For detailed feature documentation, see [DOCUMENTATION.md](DOCUMENTATION.md).
