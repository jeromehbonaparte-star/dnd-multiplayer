require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');
const rateLimit = require('express-rate-limit');

const app = express();

// Rate limiting for auth endpoints (prevent brute force)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per window
  message: { error: 'Too many login attempts, please try again after 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

// General API rate limiting
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: { error: 'Too many requests, please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});
const server = http.createServer(app);
const io = new Server(server);

// Ensure data directory exists
const dbPath = process.env.DB_PATH || './data/dnd.db';
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Database setup
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Initialize database tables
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS characters (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    player_name TEXT,
    character_name TEXT,
    race TEXT,
    class TEXT,
    level INTEGER DEFAULT 1,
    xp INTEGER DEFAULT 0,
    strength INTEGER,
    dexterity INTEGER,
    constitution INTEGER,
    intelligence INTEGER,
    wisdom INTEGER,
    charisma INTEGER,
    hp INTEGER,
    max_hp INTEGER,
    background TEXT,
    equipment TEXT,
    spells TEXT,
    skills TEXT,
    passives TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS game_sessions (
    id TEXT PRIMARY KEY,
    name TEXT,
    story_summary TEXT,
    full_history TEXT,
    current_turn INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pending_actions (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    character_id TEXT,
    action TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migrate existing databases - add new columns if they don't exist
const columns = db.prepare("PRAGMA table_info(characters)").all().map(c => c.name);
if (!columns.includes('xp')) {
  db.exec('ALTER TABLE characters ADD COLUMN xp INTEGER DEFAULT 0');
}
if (!columns.includes('spells')) {
  db.exec('ALTER TABLE characters ADD COLUMN spells TEXT');
}
if (!columns.includes('skills')) {
  db.exec('ALTER TABLE characters ADD COLUMN skills TEXT');
}
if (!columns.includes('passives')) {
  db.exec('ALTER TABLE characters ADD COLUMN passives TEXT');
}
if (!columns.includes('gold')) {
  db.exec('ALTER TABLE characters ADD COLUMN gold INTEGER DEFAULT 0');
}
if (!columns.includes('inventory')) {
  db.exec("ALTER TABLE characters ADD COLUMN inventory TEXT DEFAULT '[]'");
}
if (!columns.includes('ac')) {
  db.exec('ALTER TABLE characters ADD COLUMN ac INTEGER DEFAULT 10');
}
if (!columns.includes('spell_slots')) {
  db.exec("ALTER TABLE characters ADD COLUMN spell_slots TEXT DEFAULT '{}'");
}

// Migrate game_sessions table - add compacted_count column
const sessionColumns = db.prepare("PRAGMA table_info(game_sessions)").all().map(c => c.name);
if (!sessionColumns.includes('compacted_count')) {
  db.exec('ALTER TABLE game_sessions ADD COLUMN compacted_count INTEGER DEFAULT 0');
}

// XP requirements for each level
const XP_TABLE = [0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000];

function getRequiredXP(level) {
  return XP_TABLE[level] || 355000;
}

function canLevelUp(xp, level) {
  return xp >= getRequiredXP(level);
}

// Initialize default settings if not exist
const initSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
const upsertSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

// Passwords from environment variables - ALWAYS update if env var is set
const defaultPassword = process.env.GAME_PASSWORD;
const adminPassword = process.env.ADMIN_PASSWORD;

// Always update passwords if environment variables are provided
if (defaultPassword) {
  upsertSetting.run('game_password', bcrypt.hashSync(defaultPassword, 10));
} else {
  initSetting.run('game_password', bcrypt.hashSync('changeme', 10));
}

if (adminPassword) {
  upsertSetting.run('admin_password', bcrypt.hashSync(adminPassword, 10));
} else {
  initSetting.run('admin_password', bcrypt.hashSync('admin123', 10));
}

initSetting.run('api_endpoint', 'https://api.openai.com/v1/chat/completions');
initSetting.run('api_key', '');
initSetting.run('api_model', 'gpt-4');
initSetting.run('max_tokens_before_compact', '8000');

// Default DM Instructions - always used (not editable via settings)
const DEFAULT_SYSTEM_PROMPT = `You are a creative and engaging Dungeon Master for a D&D 5e game.

YOUR ROLE:
- Narrate the story vividly and immersively
- Control NPCs and monsters
- Describe environments, combat outcomes, and consequences of player actions
- Keep track of the game state and maintain consistency
- Be fair but challenging
- Award XP for combat victories, puzzle solving, and good roleplay

DICE ROLLING - YOU MUST ROLL DICE YOURSELF:
When a player attempts an action that requires a check, YOU roll the dice and calculate the result:

1. Roll the appropriate die (d20 for most checks, damage dice for attacks)
2. Add the relevant modifier from their stats:
   - STR modifier = (STR - 10) / 2 (rounded down)
   - DEX modifier = (DEX - 10) / 2 (rounded down)
   - etc.
3. Add proficiency bonus (+2 at levels 1-4, +3 at 5-8, etc.) if proficient
4. Compare to DC or AC and narrate the result

EXAMPLE FORMAT:
"Thorin swings his axe at the goblin. [Rolling d20 + 3 STR + 2 proficiency = d20+5... rolled 14+5 = 19 vs AC 12 - HIT!] The axe cleaves through the goblin's armor! [Damage: 1d8+3 = 7 damage]"

COMBAT:
- Track enemy HP mentally
- Describe hits, misses, and critical hits (nat 20) dramatically
- Critical hits deal double dice damage

XP AWARDS - ALWAYS USE THIS FORMAT:
- Easy encounter: 50 XP per character
- Medium encounter: 100 XP per character
- Hard encounter: 200 XP per character
- Boss/deadly: 300+ XP per character
- Good roleplay/clever solutions: 25-50 XP

**IMPORTANT: When awarding XP, you MUST use this exact format so the system can track it:**
[XP: CharacterName +100, OtherCharacter +100]

Example: "The party defeats the goblins! [XP: Thorin +50, Elara +50, Grimm +50]"

GOLD & LOOT TRACKING:
When the party finds gold or treasure, award it using this exact format:
[GOLD: CharacterName +50, OtherCharacter +25]

When the party finds or loses items, track them using this format:
[ITEM: CharacterName +Sword of Fire, CharacterName +Health Potion x3]
[ITEM: CharacterName -Health Potion] (for items used/lost)

Examples:
- "You find a chest containing 100 gold pieces! [GOLD: Thorin +50, Elara +50]"
- "The merchant sells you a healing potion. [GOLD: Grimm -25] [ITEM: Grimm +Healing Potion]"
- "Elara drinks her health potion. [ITEM: Elara -Health Potion]"

SPELL SLOT TRACKING:
When a spellcaster uses a spell slot, track it using this format:
[SPELL: CharacterName -1st] (uses one 1st level slot)
[SPELL: CharacterName -3rd] (uses one 3rd level slot)

When spell slots are restored (long rest), use:
[SPELL: CharacterName +REST] (restores all spell slots)

Examples:
- "Elara casts Magic Missile using a 1st level slot. [SPELL: Elara -1st]"
- "The party takes a long rest. [SPELL: Elara +REST] [SPELL: Grimm +REST]"

Wait for all players to submit their actions before narrating the outcome.`;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Middleware to check game password
const checkPassword = (req, res, next) => {
  const password = req.headers['x-game-password'];
  const storedHash = db.prepare('SELECT value FROM settings WHERE key = ?').get('game_password');

  if (!storedHash || !bcrypt.compareSync(password || '', storedHash.value)) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  next();
};

// Middleware to check admin password
const checkAdminPassword = (req, res, next) => {
  const adminPwd = req.headers['x-admin-password'];
  const storedHash = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password');

  if (!storedHash || !bcrypt.compareSync(adminPwd || '', storedHash.value)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// API Routes

// Apply general rate limiting to all API routes
app.use('/api/', apiLimiter);

// Game login - with stricter rate limiting
app.post('/api/auth', authLimiter, (req, res) => {
  const { password } = req.body;
  const storedHash = db.prepare('SELECT value FROM settings WHERE key = ?').get('game_password');

  if (bcrypt.compareSync(password, storedHash.value)) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// Admin auth endpoint - with stricter rate limiting
app.post('/api/admin-auth', authLimiter, checkPassword, (req, res) => {
  const { adminPassword } = req.body;
  const storedHash = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password');

  if (bcrypt.compareSync(adminPassword || '', storedHash.value)) {
    res.json({ success: true });
  } else {
    res.status(403).json({ error: 'Invalid admin password' });
  }
});

app.get('/api/settings', checkPassword, checkAdminPassword, (req, res) => {
  const settings = {};
  const rows = db.prepare('SELECT key, value FROM settings').all();
  rows.forEach(row => {
    if (row.key !== 'game_password' && row.key !== 'admin_password') {
      // Mask API key - only show last 4 characters
      if (row.key === 'api_key' && row.value && row.value.length > 4) {
        settings[row.key] = '****' + row.value.slice(-4);
        settings['api_key_set'] = true; // Flag to indicate key is set
      } else {
        settings[row.key] = row.value;
      }
    }
  });
  res.json(settings);
});

app.post('/api/settings', checkPassword, checkAdminPassword, (req, res) => {
  const { api_endpoint, api_key, api_model, max_tokens_before_compact, new_password } = req.body;

  const updateSetting = db.prepare('UPDATE settings SET value = ? WHERE key = ?');

  if (api_endpoint) updateSetting.run(api_endpoint, 'api_endpoint');
  if (api_key) updateSetting.run(api_key, 'api_key');
  if (api_model) updateSetting.run(api_model, 'api_model');
  if (max_tokens_before_compact) updateSetting.run(max_tokens_before_compact, 'max_tokens_before_compact');
  if (new_password) updateSetting.run(bcrypt.hashSync(new_password, 10), 'game_password');

  res.json({ success: true });
});

// Test API Connection
app.post('/api/test-connection', checkPassword, async (req, res) => {
  const { api_endpoint, api_key, api_model } = req.body;

  if (!api_endpoint || !api_key || !api_model) {
    return res.status(400).json({ error: 'Please fill in all API fields' });
  }

  try {
    const response = await fetch(api_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${api_key}`
      },
      body: JSON.stringify({
        model: api_model,
        messages: [{ role: 'user', content: 'Say "Connection successful!" in exactly those words.' }],
        max_tokens: 50
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: `API Error (${response.status}): ${errorText}` });
    }

    const data = await response.json();
    console.log('API Response:', JSON.stringify(data, null, 2));

    // Handle different response formats (OpenAI, DeepSeek, etc.)
    let message = 'Response received';
    if (data.choices && data.choices[0]) {
      const choice = data.choices[0];
      message = choice.message?.content || choice.text || choice.content || message;
    } else if (data.output) {
      message = data.output;
    } else if (data.response) {
      message = data.response;
    } else if (data.result) {
      message = data.result;
    }

    // Clean up message if it's still an object
    if (typeof message === 'object') {
      message = JSON.stringify(message);
    }

    res.json({
      success: true,
      message: message.substring(0, 200),
      model: data.model || data.model_name || api_model
    });
  } catch (error) {
    res.status(500).json({ error: `Connection failed: ${error.message}` });
  }
});

// Character routes
app.get('/api/characters', checkPassword, (req, res) => {
  const characters = db.prepare('SELECT * FROM characters ORDER BY created_at DESC').all();
  res.json(characters);
});

app.post('/api/characters', checkPassword, (req, res) => {
  const { player_name, character_name, race, class: charClass, strength, dexterity, constitution, intelligence, wisdom, charisma, background, equipment } = req.body;

  const id = uuidv4();
  const hp = 10 + Math.floor((constitution - 10) / 2); // Basic HP calculation

  db.prepare(`
    INSERT INTO characters (id, player_name, character_name, race, class, strength, dexterity, constitution, intelligence, wisdom, charisma, hp, max_hp, background, equipment)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, player_name, character_name, race, charClass, strength, dexterity, constitution, intelligence, wisdom, charisma, hp, hp, background, equipment);

  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
  io.emit('character_created', character);
  res.json(character);
});

app.delete('/api/characters/:id', checkPassword, (req, res) => {
  db.prepare('DELETE FROM characters WHERE id = ?').run(req.params.id);
  io.emit('character_deleted', req.params.id);
  res.json({ success: true });
});

// Award XP to a character
app.post('/api/characters/:id/xp', checkPassword, (req, res) => {
  const { amount } = req.body;
  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);

  if (!character) {
    return res.status(404).json({ error: 'Character not found' });
  }

  const newXP = (character.xp || 0) + amount;
  db.prepare('UPDATE characters SET xp = ? WHERE id = ?').run(newXP, req.params.id);

  const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
  const canLevel = canLevelUp(newXP, updatedChar.level);

  io.emit('character_updated', updatedChar);
  res.json({ character: updatedChar, canLevelUp: canLevel, requiredXP: getRequiredXP(updatedChar.level) });
});

// Reset XP to 0
app.post('/api/characters/:id/reset-xp', checkPassword, (req, res) => {
  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);

  if (!character) {
    return res.status(404).json({ error: 'Character not found' });
  }

  db.prepare('UPDATE characters SET xp = 0 WHERE id = ?').run(req.params.id);

  const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
  io.emit('character_updated', updatedChar);
  res.json({ character: updatedChar });
});

// Update AC
app.post('/api/characters/:id/ac', checkPassword, (req, res) => {
  const { ac } = req.body;
  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);

  if (!character) {
    return res.status(404).json({ error: 'Character not found' });
  }

  db.prepare('UPDATE characters SET ac = ? WHERE id = ?').run(ac, req.params.id);

  const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
  io.emit('character_updated', updatedChar);
  res.json({ character: updatedChar });
});

// Get/Update spell slots
app.post('/api/characters/:id/spell-slots', checkPassword, (req, res) => {
  const { action, level, slots } = req.body; // action: 'use', 'restore', 'rest', 'set'
  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);

  if (!character) {
    return res.status(404).json({ error: 'Character not found' });
  }

  let spellSlots = {};
  try {
    spellSlots = JSON.parse(character.spell_slots || '{}');
  } catch (e) {
    spellSlots = {};
  }

  if (action === 'use' && level) {
    // Use a spell slot
    if (spellSlots[level]) {
      spellSlots[level].used = Math.min((spellSlots[level].used || 0) + 1, spellSlots[level].max || 0);
    }
  } else if (action === 'restore' && level) {
    // Restore a spell slot
    if (spellSlots[level]) {
      spellSlots[level].used = Math.max((spellSlots[level].used || 0) - 1, 0);
    }
  } else if (action === 'rest') {
    // Long rest - restore all slots
    for (const lvl in spellSlots) {
      spellSlots[lvl].used = 0;
    }
  } else if (action === 'set' && slots) {
    // Set spell slots directly (for character setup)
    spellSlots = slots;
  }

  db.prepare('UPDATE characters SET spell_slots = ? WHERE id = ?').run(JSON.stringify(spellSlots), req.params.id);

  const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
  io.emit('character_updated', updatedChar);
  res.json({ character: updatedChar, spellSlots });
});

// Update gold for a character
app.post('/api/characters/:id/gold', checkPassword, (req, res) => {
  const { amount } = req.body;
  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);

  if (!character) {
    return res.status(404).json({ error: 'Character not found' });
  }

  const newGold = Math.max(0, (character.gold || 0) + amount);
  db.prepare('UPDATE characters SET gold = ? WHERE id = ?').run(newGold, req.params.id);

  const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
  io.emit('character_updated', updatedChar);
  res.json({ character: updatedChar });
});

// Get character inventory
app.get('/api/characters/:id/inventory', checkPassword, (req, res) => {
  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);

  if (!character) {
    return res.status(404).json({ error: 'Character not found' });
  }

  let inventory = [];
  try {
    inventory = JSON.parse(character.inventory || '[]');
  } catch (e) {
    inventory = [];
  }

  res.json({ inventory, gold: character.gold || 0 });
});

// Update character inventory (add/remove items)
app.post('/api/characters/:id/inventory', checkPassword, (req, res) => {
  const { action, item, quantity = 1 } = req.body; // action: 'add' or 'remove'
  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);

  if (!character) {
    return res.status(404).json({ error: 'Character not found' });
  }

  if (!item || !action) {
    return res.status(400).json({ error: 'Item name and action (add/remove) required' });
  }

  let inventory = [];
  try {
    inventory = JSON.parse(character.inventory || '[]');
  } catch (e) {
    inventory = [];
  }

  if (action === 'add') {
    const existingItem = inventory.find(i => i.name.toLowerCase() === item.toLowerCase());
    if (existingItem) {
      existingItem.quantity = (existingItem.quantity || 1) + quantity;
    } else {
      inventory.push({ name: item, quantity: quantity });
    }
  } else if (action === 'remove') {
    const existingIdx = inventory.findIndex(i => i.name.toLowerCase() === item.toLowerCase());
    if (existingIdx !== -1) {
      inventory[existingIdx].quantity = (inventory[existingIdx].quantity || 1) - quantity;
      if (inventory[existingIdx].quantity <= 0) {
        inventory.splice(existingIdx, 1);
      }
    }
  } else if (action === 'set') {
    // Replace entire inventory
    inventory = req.body.inventory || [];
  }

  db.prepare('UPDATE characters SET inventory = ? WHERE id = ?').run(JSON.stringify(inventory), req.params.id);

  const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
  io.emit('character_updated', updatedChar);
  res.json({ character: updatedChar, inventory });
});

// Level up a character (AI-assisted, conversational)
app.post('/api/characters/:id/levelup', checkPassword, async (req, res) => {
  const { messages } = req.body;
  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);

  if (!character) {
    return res.status(404).json({ error: 'Character not found' });
  }

  if (!canLevelUp(character.xp || 0, character.level)) {
    return res.status(400).json({
      error: 'Not enough XP to level up',
      currentXP: character.xp || 0,
      requiredXP: getRequiredXP(character.level)
    });
  }

  const settings = {};
  db.prepare('SELECT key, value FROM settings').all().forEach(row => settings[row.key] = row.value);

  if (!settings.api_key) {
    return res.status(400).json({ error: 'API key not configured' });
  }

  const newLevel = character.level + 1;
  const conMod = Math.floor((character.constitution - 10) / 2);

  const levelUpSystemPrompt = `You are a friendly D&D 5e level up assistant. Help ${character.character_name} level up from ${character.level} to ${newLevel}.

CURRENT CHARACTER:
- Name: ${character.character_name}
- Race: ${character.race}
- Class: ${character.class}
- Current Level: ${character.level}
- Stats: STR ${character.strength}, DEX ${character.dexterity}, CON ${character.constitution}, INT ${character.intelligence}, WIS ${character.wisdom}, CHA ${character.charisma}
- Current HP: ${character.max_hp}
- Current Spells: ${character.spells || 'None'}
- Current Skills: ${character.skills || 'None'}
- Current Passives/Features: ${character.passives || 'None'}

LEVEL UP RULES:
1. HP Increase: Roll class hit die + CON modifier (${conMod}). For a ${character.class}, that's typically 1d${character.class === 'Barbarian' ? '12' : character.class === 'Fighter' || character.class === 'Paladin' || character.class === 'Ranger' ? '10' : character.class === 'Wizard' || character.class === 'Sorcerer' ? '6' : '8'}+${conMod}.
2. Check if this level grants new class features (Extra Attack at 5, etc.)
3. Check if this is an Ability Score Improvement level (4, 8, 12, 16, 19) - ask player what stats to increase
4. For spellcasters, check for new spell slots and spells known/prepared

Guide the player through their choices conversationally. When ALL choices are finalized, output:
LEVELUP_COMPLETE:{"hp_increase":N,"new_spells":"spells gained or None","new_skills":"skills gained or None","new_passives":"features gained or None","stat_changes":"any stat increases or None","summary":"Brief exciting summary"}`;

  try {
    const allMessages = [
      { role: 'system', content: levelUpSystemPrompt },
      ...(messages || [])
    ];

    const response = await fetch(settings.api_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.api_key}`
      },
      body: JSON.stringify({
        model: settings.api_model,
        messages: allMessages,
        max_tokens: 64000
      })
    });

    if (!response.ok) {
      throw new Error('AI API error');
    }

    const data = await response.json();
    const aiMessage = extractAIMessage(data);

    if (!aiMessage) {
      throw new Error('Could not parse AI response');
    }

    // Check if level up is complete
    if (aiMessage.includes('LEVELUP_COMPLETE:')) {
      // Extract JSON - handle multiline and various formats
      let jsonStr = null;
      const startIdx = aiMessage.indexOf('LEVELUP_COMPLETE:') + 'LEVELUP_COMPLETE:'.length;
      const jsonStart = aiMessage.indexOf('{', startIdx);

      if (jsonStart !== -1) {
        // Find matching closing brace by counting braces
        let braceCount = 0;
        let jsonEnd = jsonStart;
        for (let i = jsonStart; i < aiMessage.length; i++) {
          if (aiMessage[i] === '{') braceCount++;
          if (aiMessage[i] === '}') braceCount--;
          if (braceCount === 0) {
            jsonEnd = i + 1;
            break;
          }
        }
        jsonStr = aiMessage.substring(jsonStart, jsonEnd);
      }

      if (jsonStr) {
        try {
          const levelData = JSON.parse(jsonStr);

          // Update character
          const newMaxHP = character.max_hp + (levelData.hp_increase || 0);
          const newSpells = levelData.new_spells && levelData.new_spells !== 'None'
            ? (character.spells ? `${character.spells}, ${levelData.new_spells}` : levelData.new_spells)
            : character.spells;
          const newSkills = levelData.new_skills && levelData.new_skills !== 'None'
            ? (character.skills ? `${character.skills}, ${levelData.new_skills}` : levelData.new_skills)
            : character.skills;
          const newPassives = levelData.new_passives && levelData.new_passives !== 'None'
            ? (character.passives ? `${character.passives}, ${levelData.new_passives}` : levelData.new_passives)
            : character.passives;

          db.prepare(`
            UPDATE characters SET level = ?, hp = ?, max_hp = ?, spells = ?, skills = ?, passives = ? WHERE id = ?
          `).run(newLevel, newMaxHP, newMaxHP, newSpells || '', newSkills || '', newPassives || '', req.params.id);

          const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
          io.emit('character_updated', updatedChar);
          io.emit('character_leveled_up', { character: updatedChar, summary: levelData.summary });

          const cleanMessage = aiMessage.substring(0, aiMessage.indexOf('LEVELUP_COMPLETE:')).trim();
          return res.json({ message: cleanMessage || 'Level up complete!', complete: true, character: updatedChar, levelUp: levelData });
        } catch (parseError) {
          console.error('Failed to parse level up JSON:', parseError.message, 'Raw JSON:', jsonStr);
        }
      }
    }

    res.json({ message: aiMessage, complete: false });
  } catch (error) {
    console.error('Level up error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get level up info for a character
app.get('/api/characters/:id/levelinfo', checkPassword, (req, res) => {
  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);

  if (!character) {
    return res.status(404).json({ error: 'Character not found' });
  }

  res.json({
    level: character.level,
    xp: character.xp || 0,
    requiredXP: getRequiredXP(character.level),
    canLevelUp: canLevelUp(character.xp || 0, character.level),
    nextLevelXP: getRequiredXP(character.level)
  });
});

// AI-assisted character editing
app.post('/api/characters/:id/edit', checkPassword, async (req, res) => {
  const { editRequest, messages } = req.body;
  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);

  if (!character) {
    return res.status(404).json({ error: 'Character not found' });
  }

  const settings = {};
  db.prepare('SELECT key, value FROM settings').all().forEach(row => settings[row.key] = row.value);

  if (!settings.api_key) {
    return res.status(400).json({ error: 'API key not configured' });
  }

  const editPrompt = `You are a D&D 5e character editor assistant. Help modify this character based on the user's request.

CURRENT CHARACTER:
- Player: ${character.player_name}
- Name: ${character.character_name}
- Race: ${character.race}
- Class: ${character.class}
- Level: ${character.level}
- XP: ${character.xp || 0}
- Stats: STR ${character.strength}, DEX ${character.dexterity}, CON ${character.constitution}, INT ${character.intelligence}, WIS ${character.wisdom}, CHA ${character.charisma}
- HP: ${character.hp}/${character.max_hp}
- Background: ${character.background}
- Equipment: ${character.equipment}
- Spells: ${character.spells || 'None'}
- Skills: ${character.skills || 'None'}
- Passives: ${character.passives || 'None'}

USER'S EDIT REQUEST: ${editRequest}

Discuss the changes with the user. When you have confirmed ALL changes, output the updated character in this EXACT JSON format:
EDIT_COMPLETE:{"character_name":"...","race":"...","class":"...","strength":N,"dexterity":N,"constitution":N,"intelligence":N,"wisdom":N,"charisma":N,"hp":N,"max_hp":N,"background":"...","equipment":"...","spells":"...","skills":"...","passives":"..."}

Only include fields that should be changed. Keep the conversation helpful and ensure changes are valid for D&D 5e.`;

  try {
    const allMessages = [
      { role: 'system', content: editPrompt },
      ...(messages || [])
    ];

    const response = await fetch(settings.api_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.api_key}`
      },
      body: JSON.stringify({
        model: settings.api_model,
        messages: allMessages,
        max_tokens: 64000
      })
    });

    if (!response.ok) {
      throw new Error('AI API error');
    }

    const data = await response.json();
    const aiMessage = extractAIMessage(data);

    if (!aiMessage) {
      throw new Error('Could not parse AI response');
    }

    // Check if edit is complete
    if (aiMessage.includes('EDIT_COMPLETE:')) {
      // Extract JSON - handle multiline and various formats
      let jsonStr = null;
      const startIdx = aiMessage.indexOf('EDIT_COMPLETE:') + 'EDIT_COMPLETE:'.length;
      const jsonStart = aiMessage.indexOf('{', startIdx);

      if (jsonStart !== -1) {
        // Find matching closing brace by counting braces
        let braceCount = 0;
        let jsonEnd = jsonStart;
        for (let i = jsonStart; i < aiMessage.length; i++) {
          if (aiMessage[i] === '{') braceCount++;
          if (aiMessage[i] === '}') braceCount--;
          if (braceCount === 0) {
            jsonEnd = i + 1;
            break;
          }
        }
        jsonStr = aiMessage.substring(jsonStart, jsonEnd);
      }

      if (jsonStr) {
        try {
          const editData = JSON.parse(jsonStr);

          // Build update query dynamically
          const updates = [];
          const values = [];

          const fields = ['character_name', 'race', 'class', 'strength', 'dexterity', 'constitution',
                         'intelligence', 'wisdom', 'charisma', 'hp', 'max_hp', 'background',
                         'equipment', 'spells', 'skills', 'passives'];

          fields.forEach(field => {
            if (editData[field] !== undefined) {
              updates.push(`${field} = ?`);
              values.push(editData[field]);
            }
          });

          if (updates.length > 0) {
            values.push(req.params.id);
            db.prepare(`UPDATE characters SET ${updates.join(', ')} WHERE id = ?`).run(...values);
          }

          const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
          io.emit('character_updated', updatedChar);

          const cleanMessage = aiMessage.substring(0, aiMessage.indexOf('EDIT_COMPLETE:')).trim();
          return res.json({ message: cleanMessage || 'Character updated!', complete: true, character: updatedChar });
        } catch (parseError) {
          console.error('Failed to parse edit JSON:', parseError.message, 'Raw JSON:', jsonStr);
        }
      }
    }

    res.json({ message: aiMessage, complete: false });
  } catch (error) {
    console.error('Character edit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper function to extract message from different API response formats
function extractAIMessage(data) {
  // OpenAI / DeepSeek standard format
  if (data.choices && data.choices[0]) {
    const choice = data.choices[0];
    if (choice.message && choice.message.content) {
      return choice.message.content;
    }
    if (choice.text) {
      return choice.text;
    }
    if (choice.content) {
      return choice.content;
    }
  }
  // Alternative formats
  if (data.output) return data.output;
  if (data.response) return data.response;
  if (data.result) return data.result;
  if (data.content) return data.content;
  if (data.text) return data.text;

  // Log for debugging
  console.log('Unknown API response format:', JSON.stringify(data, null, 2));
  return null;
}

// AI Character Creation
const CHARACTER_CREATION_PROMPT = `You are a friendly D&D 5e character creation assistant. Help the player create their Level 1 character through conversation.

You must guide them through these steps IN ORDER:
1. Ask for their PLAYER NAME (the real person's name)
2. Ask what RACE they want (Human, Elf, Dwarf, Halfling, Dragonborn, Gnome, Half-Elf, Half-Orc, Tiefling)
3. Ask what CLASS they want (Fighter, Wizard, Rogue, Cleric, Barbarian, Bard, Druid, Monk, Paladin, Ranger, Sorcerer, Warlock)
4. Ask for their CHARACTER NAME
5. Help them with a brief BACKSTORY (2-3 sentences)
6. Confirm their starting SPELLS (if spellcaster), SKILLS (based on class), and EQUIPMENT

For STATS, roll 4d6 drop lowest for each stat and assign them appropriately for their class.

SKILLS by class (choose proficiencies):
- Fighter: Acrobatics, Animal Handling, Athletics, History, Insight, Intimidation, Perception, Survival (pick 2)
- Wizard: Arcana, History, Insight, Investigation, Medicine, Religion (pick 2)
- Rogue: Acrobatics, Athletics, Deception, Insight, Intimidation, Investigation, Perception, Performance, Persuasion, Sleight of Hand, Stealth (pick 4)
- Cleric: History, Insight, Medicine, Persuasion, Religion (pick 2)
- Other classes: Choose 2-3 appropriate skills

PASSIVES to include:
- Passive Perception (10 + Wisdom modifier + proficiency if proficient)
- Racial abilities (Darkvision, etc.)
- Class features (Fighting Style, Spellcasting, Sneak Attack, etc.)

SPELLS for Level 1 spellcasters:
- Wizard: 3 cantrips, 6 spells in spellbook (prepare Int mod + 1)
- Cleric: 3 cantrips, prepare Wis mod + 1 spells
- Other casters: Appropriate cantrips and spells for level 1

When you have ALL information needed, output the final character in this EXACT JSON format on a single line:
CHARACTER_COMPLETE:{"player_name":"...","character_name":"...","race":"...","class":"...","strength":N,"dexterity":N,"constitution":N,"intelligence":N,"wisdom":N,"charisma":N,"background":"...","equipment":"...","spells":"Cantrips: X, Y. Spells: A, B, C","skills":"Skill1, Skill2 (proficient), Skill3","passives":"Passive Perception: N, Darkvision 60ft, Feature Name"}

Be encouraging, creative, and help new players understand their choices. Keep responses concise but helpful.`;

app.post('/api/characters/ai-create', checkPassword, async (req, res) => {
  const { messages } = req.body;

  const settings = {};
  db.prepare('SELECT key, value FROM settings').all().forEach(row => settings[row.key] = row.value);

  if (!settings.api_key) {
    return res.status(400).json({ error: 'API key not configured. Please set up your API in Settings.' });
  }

  try {
    const response = await fetch(settings.api_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.api_key}`
      },
      body: JSON.stringify({
        model: settings.api_model,
        messages: [
          { role: 'system', content: CHARACTER_CREATION_PROMPT },
          ...messages
        ],
        max_tokens: 64000
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.log('API Error Response:', response.status, errorText);
      throw new Error(`API Error (${response.status}): ${errorText || 'No error details'}`);
    }

    const data = await response.json();
    console.log('AI Response received:', JSON.stringify(data).substring(0, 500));

    const aiMessage = extractAIMessage(data);

    if (!aiMessage) {
      console.log('Failed to extract AI message from response:', JSON.stringify(data, null, 2));
      throw new Error('Could not parse AI response. Check server logs for details.');
    }

    // Check if character is complete
    if (aiMessage.includes('CHARACTER_COMPLETE:')) {
      const jsonMatch = aiMessage.match(/CHARACTER_COMPLETE:(\{.*\})/);
      if (jsonMatch) {
        try {
          const charData = JSON.parse(jsonMatch[1]);

          // Create the character
          const id = uuidv4();
          const hp = 10 + Math.floor((charData.constitution - 10) / 2);

          db.prepare(`
            INSERT INTO characters (id, player_name, character_name, race, class, level, xp, strength, dexterity, constitution, intelligence, wisdom, charisma, hp, max_hp, background, equipment, spells, skills, passives)
            VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(id, charData.player_name, charData.character_name, charData.race, charData.class,
                 charData.strength, charData.dexterity, charData.constitution, charData.intelligence,
                 charData.wisdom, charData.charisma, hp, hp, charData.background, charData.equipment,
                 charData.spells || '', charData.skills || '', charData.passives || '');

          const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
          io.emit('character_created', character);

          // Clean up the message for display
          const cleanMessage = aiMessage.replace(/CHARACTER_COMPLETE:\{.*\}/, '').trim();

          return res.json({
            message: cleanMessage || 'Your character has been created!',
            complete: true,
            character
          });
        } catch (parseError) {
          console.error('Failed to parse character JSON:', parseError);
        }
      }
    }

    res.json({ message: aiMessage, complete: false });
  } catch (error) {
    console.error('AI character creation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Game session routes
app.get('/api/sessions', checkPassword, (req, res) => {
  const sessions = db.prepare('SELECT * FROM game_sessions ORDER BY created_at DESC').all();
  res.json(sessions);
});

app.post('/api/sessions', checkPassword, (req, res) => {
  const { name } = req.body;
  const id = uuidv4();

  db.prepare('INSERT INTO game_sessions (id, name, full_history, story_summary) VALUES (?, ?, ?, ?)').run(id, name, '[]', '');

  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(id);
  io.emit('session_created', session);
  res.json(session);
});

app.get('/api/sessions/:id', checkPassword, (req, res) => {
  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const pendingActions = db.prepare('SELECT * FROM pending_actions WHERE session_id = ?').all(req.params.id);
  const characters = db.prepare('SELECT * FROM characters').all();

  res.json({ session, pendingActions, characters });
});

// Delete session
app.delete('/api/sessions/:id', checkPassword, (req, res) => {
  const sessionId = req.params.id;

  // Delete associated pending actions first
  db.prepare('DELETE FROM pending_actions WHERE session_id = ?').run(sessionId);

  // Delete the session
  const result = db.prepare('DELETE FROM game_sessions WHERE id = ?').run(sessionId);

  if (result.changes > 0) {
    io.emit('session_deleted', sessionId);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// Submit action
app.post('/api/sessions/:id/action', checkPassword, async (req, res) => {
  const { character_id, action } = req.body;
  const sessionId = req.params.id;

  // Check if character already has pending action
  const existing = db.prepare('SELECT * FROM pending_actions WHERE session_id = ? AND character_id = ?').get(sessionId, character_id);
  if (existing) {
    db.prepare('UPDATE pending_actions SET action = ? WHERE id = ?').run(action, existing.id);
  } else {
    db.prepare('INSERT INTO pending_actions (id, session_id, character_id, action) VALUES (?, ?, ?, ?)').run(uuidv4(), sessionId, character_id, action);
  }

  const pendingActions = db.prepare('SELECT * FROM pending_actions WHERE session_id = ?').all(sessionId);
  const characters = db.prepare('SELECT * FROM characters').all();

  io.emit('action_submitted', { sessionId, pendingActions, character_id });

  // Check if all characters have submitted actions
  if (pendingActions.length >= characters.length && characters.length > 0) {
    // Process turn with AI
    try {
      const result = await processAITurn(sessionId, pendingActions, characters);
      res.json({ processed: true, result });
    } catch (error) {
      console.error('AI processing error:', error);
      res.json({ processed: false, error: error.message });
    }
  } else {
    res.json({ processed: false, waiting: characters.length - pendingActions.length });
  }
});

// Force process turn (DM override)
app.post('/api/sessions/:id/process', checkPassword, async (req, res) => {
  const sessionId = req.params.id;
  const pendingActions = db.prepare('SELECT * FROM pending_actions WHERE session_id = ?').all(sessionId);
  const characters = db.prepare('SELECT * FROM characters').all();

  try {
    const result = await processAITurn(sessionId, pendingActions, characters);
    res.json({ success: true, result });
  } catch (error) {
    console.error('AI processing error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Recalculate XP from session history (for existing sessions)
app.post('/api/sessions/:id/recalculate-xp', checkPassword, (req, res) => {
  const sessionId = req.params.id;
  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const characters = db.prepare('SELECT * FROM characters').all();
  const history = JSON.parse(session.full_history || '[]');
  const xpAwarded = {};

  // Scan all assistant messages for XP awards
  for (const entry of history) {
    if (entry.role === 'assistant') {
      const xpMatches = entry.content.match(/\[XP:([^\]]+)\]/gi);
      if (xpMatches) {
        for (const match of xpMatches) {
          const xpAwards = match.replace(/\[XP:/i, '').replace(']', '').split(',');
          for (const award of xpAwards) {
            const xpMatch = award.trim().match(/(.+?)\s*\+(\d+)/);
            if (xpMatch) {
              const charName = xpMatch[1].trim();
              const xpAmount = parseInt(xpMatch[2]);
              const char = characters.find(c => c.character_name.toLowerCase() === charName.toLowerCase());
              if (char) {
                xpAwarded[char.id] = (xpAwarded[char.id] || 0) + xpAmount;
              }
            }
          }
        }
      }
    }
  }

  // Update character XP
  for (const [charId, xp] of Object.entries(xpAwarded)) {
    db.prepare('UPDATE characters SET xp = ? WHERE id = ?').run(xp, charId);
  }

  // Notify clients
  const updatedCharacters = db.prepare('SELECT * FROM characters').all();
  for (const char of updatedCharacters) {
    io.emit('character_updated', char);
  }

  res.json({ success: true, xpAwarded });
});

// Recalculate gold and inventory from session history
app.post('/api/sessions/:id/recalculate-loot', checkPassword, (req, res) => {
  const sessionId = req.params.id;
  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const characters = db.prepare('SELECT * FROM characters').all();
  const history = JSON.parse(session.full_history || '[]');
  const goldAwarded = {};
  const inventoryChanges = {};

  // Initialize tracking objects for each character
  for (const char of characters) {
    goldAwarded[char.id] = 0;
    inventoryChanges[char.id] = [];
  }

  // Scan all assistant messages for gold and item awards
  for (const entry of history) {
    if (entry.role === 'assistant') {
      // Parse GOLD awards
      const goldMatches = entry.content.match(/\[GOLD:([^\]]+)\]/gi);
      if (goldMatches) {
        for (const match of goldMatches) {
          const goldAwards = match.replace(/\[GOLD:/i, '').replace(']', '').split(',');
          for (const award of goldAwards) {
            const goldMatch = award.trim().match(/(.+?)\s*([+-])(\d+)/);
            if (goldMatch) {
              const charName = goldMatch[1].trim();
              const sign = goldMatch[2] === '+' ? 1 : -1;
              const goldAmount = parseInt(goldMatch[3]) * sign;
              const char = characters.find(c => c.character_name.toLowerCase() === charName.toLowerCase());
              if (char) {
                goldAwarded[char.id] = (goldAwarded[char.id] || 0) + goldAmount;
              }
            }
          }
        }
      }

      // Parse ITEM awards
      const itemMatches = entry.content.match(/\[ITEM:([^\]]+)\]/gi);
      if (itemMatches) {
        for (const match of itemMatches) {
          const itemAwards = match.replace(/\[ITEM:/i, '').replace(']', '').split(',');
          for (const award of itemAwards) {
            const itemMatch = award.trim().match(/(.+?)\s*([+-])(.+)/);
            if (itemMatch) {
              const charName = itemMatch[1].trim();
              const isAdding = itemMatch[2] === '+';
              let itemName = itemMatch[3].trim();

              let quantity = 1;
              const qtyMatch = itemName.match(/(.+?)\s*x(\d+)$/i);
              if (qtyMatch) {
                itemName = qtyMatch[1].trim();
                quantity = parseInt(qtyMatch[2]);
              }

              const char = characters.find(c => c.character_name.toLowerCase() === charName.toLowerCase());
              if (char) {
                inventoryChanges[char.id].push({
                  item: itemName,
                  quantity: isAdding ? quantity : -quantity
                });
              }
            }
          }
        }
      }
    }
  }

  // Update character gold and inventory
  for (const char of characters) {
    // Update gold
    const newGold = Math.max(0, goldAwarded[char.id] || 0);

    // Build inventory from changes
    const inventory = [];
    for (const change of inventoryChanges[char.id]) {
      const existingItem = inventory.find(i => i.name.toLowerCase() === change.item.toLowerCase());
      if (existingItem) {
        existingItem.quantity += change.quantity;
        if (existingItem.quantity <= 0) {
          inventory.splice(inventory.indexOf(existingItem), 1);
        }
      } else if (change.quantity > 0) {
        inventory.push({ name: change.item, quantity: change.quantity });
      }
    }

    db.prepare('UPDATE characters SET gold = ?, inventory = ? WHERE id = ?')
      .run(newGold, JSON.stringify(inventory), char.id);
  }

  // Notify clients
  const updatedCharacters = db.prepare('SELECT * FROM characters').all();
  for (const char of updatedCharacters) {
    io.emit('character_updated', char);
  }

  res.json({ success: true, goldAwarded, inventoryChanges });
});

// AI Processing function
async function processAITurn(sessionId, pendingActions, characters) {
  // Notify all clients that processing has started
  io.emit('turn_processing', { sessionId });

  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);
  const settings = {};
  db.prepare('SELECT key, value FROM settings').all().forEach(row => settings[row.key] = row.value);

  if (!settings.api_key) {
    throw new Error('API key not configured');
  }

  let fullHistory = JSON.parse(session.full_history || '[]');
  const compactedCount = session.compacted_count || 0;

  // Build character info
  const characterInfo = characters.map(c => {
    let info = `${c.character_name} (Level ${c.level} ${c.race} ${c.class}, played by ${c.player_name}):\n`;
    info += `  Stats: STR:${c.strength} DEX:${c.dexterity} CON:${c.constitution} INT:${c.intelligence} WIS:${c.wisdom} CHA:${c.charisma}\n`;
    info += `  HP: ${c.hp}/${c.max_hp}`;
    if (c.skills) info += `\n  Skills: ${c.skills}`;
    if (c.spells) info += `\n  Spells: ${c.spells}`;
    if (c.passives) info += `\n  Passives: ${c.passives}`;
    return info;
  }).join('\n\n');

  // Build action summary
  const actionSummary = pendingActions.map(pa => {
    const char = characters.find(c => c.id === pa.character_id);
    return `${char ? char.character_name : 'Unknown'}: ${pa.action}`;
  }).join('\n');

  // Add user message for this turn
  const userMessage = `
PARTY STATUS:
${characterInfo}

PLAYER ACTIONS THIS TURN:
${actionSummary}

Please narrate the outcome of these actions and describe what happens next.`;

  fullHistory.push({ role: 'user', content: userMessage });

  // Build messages array for AI - only send messages after compacted_count
  // The summary covers messages 0 to compactedCount-1
  const recentHistory = fullHistory.slice(compactedCount);
  const messages = [
    { role: 'system', content: DEFAULT_SYSTEM_PROMPT + (session.story_summary ? `\n\nSTORY SO FAR:\n${session.story_summary}` : '') },
    ...recentHistory
  ];

  // Call AI API
  const response = await fetch(settings.api_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.api_key}`
    },
    body: JSON.stringify({
      model: settings.api_model,
      messages: messages,
      max_tokens: 64000
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API Error: ${error}`);
  }

  const data = await response.json();
  const aiResponse = extractAIMessage(data);

  if (!aiResponse) {
    console.log('Failed to extract AI response:', JSON.stringify(data, null, 2));
    throw new Error('Could not parse AI response. Check server logs.');
  }

  const tokensUsed = data.usage?.total_tokens || estimateTokens(JSON.stringify(messages) + aiResponse);

  fullHistory.push({ role: 'assistant', content: aiResponse });

  // Parse and award XP from AI response
  // Format: [XP: CharacterName +100, OtherCharacter +50]
  const xpMatches = aiResponse.match(/\[XP:([^\]]+)\]/gi);
  if (xpMatches) {
    for (const match of xpMatches) {
      const xpAwards = match.replace(/\[XP:/i, '').replace(']', '').split(',');
      for (const award of xpAwards) {
        const xpMatch = award.trim().match(/(.+?)\s*\+(\d+)/);
        if (xpMatch) {
          const charName = xpMatch[1].trim();
          const xpAmount = parseInt(xpMatch[2]);
          // Find character by name and update XP
          const char = characters.find(c => c.character_name.toLowerCase() === charName.toLowerCase());
          if (char) {
            db.prepare('UPDATE characters SET xp = xp + ? WHERE id = ?').run(xpAmount, char.id);
            io.emit('character_updated', { ...char, xp: (char.xp || 0) + xpAmount });
          }
        }
      }
    }
  }

  // Parse and award GOLD from AI response
  // Format: [GOLD: CharacterName +50, OtherCharacter -25]
  const goldMatches = aiResponse.match(/\[GOLD:([^\]]+)\]/gi);
  if (goldMatches) {
    for (const match of goldMatches) {
      const goldAwards = match.replace(/\[GOLD:/i, '').replace(']', '').split(',');
      for (const award of goldAwards) {
        const goldMatch = award.trim().match(/(.+?)\s*([+-])(\d+)/);
        if (goldMatch) {
          const charName = goldMatch[1].trim();
          const sign = goldMatch[2] === '+' ? 1 : -1;
          const goldAmount = parseInt(goldMatch[3]) * sign;
          const char = characters.find(c => c.character_name.toLowerCase() === charName.toLowerCase());
          if (char) {
            const newGold = Math.max(0, (char.gold || 0) + goldAmount);
            db.prepare('UPDATE characters SET gold = ? WHERE id = ?').run(newGold, char.id);
            io.emit('character_updated', { ...char, gold: newGold });
          }
        }
      }
    }
  }

  // Parse and update INVENTORY from AI response
  // Format: [ITEM: CharacterName +Sword of Fire, CharacterName -Health Potion]
  const itemMatches = aiResponse.match(/\[ITEM:([^\]]+)\]/gi);
  if (itemMatches) {
    for (const match of itemMatches) {
      const itemAwards = match.replace(/\[ITEM:/i, '').replace(']', '').split(',');
      for (const award of itemAwards) {
        const itemMatch = award.trim().match(/(.+?)\s*([+-])(.+)/);
        if (itemMatch) {
          const charName = itemMatch[1].trim();
          const isAdding = itemMatch[2] === '+';
          let itemName = itemMatch[3].trim();

          // Parse quantity (e.g., "Health Potion x3")
          let quantity = 1;
          const qtyMatch = itemName.match(/(.+?)\s*x(\d+)$/i);
          if (qtyMatch) {
            itemName = qtyMatch[1].trim();
            quantity = parseInt(qtyMatch[2]);
          }

          const char = characters.find(c => c.character_name.toLowerCase() === charName.toLowerCase());
          if (char) {
            let inventory = [];
            try {
              inventory = JSON.parse(char.inventory || '[]');
            } catch (e) {
              inventory = [];
            }

            if (isAdding) {
              // Check if item already exists
              const existingItem = inventory.find(i => i.name.toLowerCase() === itemName.toLowerCase());
              if (existingItem) {
                existingItem.quantity = (existingItem.quantity || 1) + quantity;
              } else {
                inventory.push({ name: itemName, quantity: quantity });
              }
            } else {
              // Remove item
              const existingIdx = inventory.findIndex(i => i.name.toLowerCase() === itemName.toLowerCase());
              if (existingIdx !== -1) {
                inventory[existingIdx].quantity = (inventory[existingIdx].quantity || 1) - quantity;
                if (inventory[existingIdx].quantity <= 0) {
                  inventory.splice(existingIdx, 1);
                }
              }
            }

            db.prepare('UPDATE characters SET inventory = ? WHERE id = ?').run(JSON.stringify(inventory), char.id);
            io.emit('character_updated', { ...char, inventory: JSON.stringify(inventory) });
          }
        }
      }
    }
  }

  // Parse and update SPELL SLOTS from AI response
  // Format: [SPELL: CharacterName -1st] or [SPELL: CharacterName +REST]
  const spellMatches = aiResponse.match(/\[SPELL:([^\]]+)\]/gi);
  if (spellMatches) {
    for (const match of spellMatches) {
      const spellAwards = match.replace(/\[SPELL:/i, '').replace(']', '').split(',');
      for (const award of spellAwards) {
        const spellMatch = award.trim().match(/(.+?)\s*([+-])(.+)/);
        if (spellMatch) {
          const charName = spellMatch[1].trim();
          const isAdding = spellMatch[2] === '+';
          const slotLevel = spellMatch[3].trim().toLowerCase();

          const char = characters.find(c => c.character_name.toLowerCase() === charName.toLowerCase());
          if (char) {
            let spellSlots = {};
            try {
              spellSlots = JSON.parse(char.spell_slots || '{}');
            } catch (e) {
              spellSlots = {};
            }

            if (slotLevel === 'rest') {
              // Restore all spell slots to max
              for (const level in spellSlots) {
                if (spellSlots[level].max) {
                  spellSlots[level].used = 0;
                }
              }
            } else {
              // Parse slot level (1st, 2nd, 3rd, etc.)
              const levelNum = slotLevel.replace(/[^0-9]/g, '');
              if (levelNum && spellSlots[levelNum]) {
                if (!isAdding) {
                  // Using a spell slot
                  spellSlots[levelNum].used = Math.min(
                    (spellSlots[levelNum].used || 0) + 1,
                    spellSlots[levelNum].max || 0
                  );
                } else {
                  // Restoring a spell slot
                  spellSlots[levelNum].used = Math.max((spellSlots[levelNum].used || 0) - 1, 0);
                }
              }
            }

            db.prepare('UPDATE characters SET spell_slots = ? WHERE id = ?').run(JSON.stringify(spellSlots), char.id);
            io.emit('character_updated', { ...char, spell_slots: JSON.stringify(spellSlots) });
          }
        }
      }
    }
  }

  // Update session
  const newTotalTokens = (session.total_tokens || 0) + tokensUsed;

  // Check if we need to compact
  const maxTokens = parseInt(settings.max_tokens_before_compact);
  let newSummary = session.story_summary;
  let newCompactedCount = compactedCount;

  if (newTotalTokens > maxTokens) {
    // Compact the recent history (messages since last compaction)
    const recentHistoryToCompact = fullHistory.slice(compactedCount);
    newSummary = await compactHistory(settings, session.story_summary, recentHistoryToCompact);
    // Mark all current messages as compacted
    newCompactedCount = fullHistory.length;
    // Keep full history for display, but reset token count since we'll use summary for AI context
    db.prepare('UPDATE game_sessions SET story_summary = ?, full_history = ?, compacted_count = ?, total_tokens = 0, current_turn = current_turn + 1 WHERE id = ?')
      .run(newSummary, JSON.stringify(fullHistory), newCompactedCount, sessionId);
  } else {
    db.prepare('UPDATE game_sessions SET full_history = ?, total_tokens = ?, current_turn = current_turn + 1 WHERE id = ?')
      .run(JSON.stringify(fullHistory), newTotalTokens, sessionId);
  }

  // Clear pending actions
  db.prepare('DELETE FROM pending_actions WHERE session_id = ?').run(sessionId);

  // Emit update to all clients
  io.emit('turn_processed', {
    sessionId,
    response: aiResponse,
    turn: session.current_turn + 1,
    tokensUsed: newTotalTokens,
    compacted: newTotalTokens > maxTokens
  });

  return { response: aiResponse, tokensUsed: newTotalTokens };
}

// Compact history function
async function compactHistory(settings, existingSummary, history) {
  const historyText = history.map(h => `${h.role}: ${h.content}`).join('\n\n');

  const compactPrompt = `You are summarizing a D&D adventure for continuity purposes.
Create a concise but comprehensive summary that captures:
- Key plot points and story progression
- Important NPCs encountered
- Major decisions made by the party
- Current location and situation
- Any ongoing quests or objectives

${existingSummary ? `PREVIOUS SUMMARY:\n${existingSummary}\n\n` : ''}
RECENT EVENTS TO ADD TO SUMMARY:
${historyText}

Provide an updated comprehensive summary:`;

  const response = await fetch(settings.api_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.api_key}`
    },
    body: JSON.stringify({
      model: settings.api_model,
      messages: [{ role: 'user', content: compactPrompt }],
      max_tokens: 64000
    })
  });

  if (!response.ok) {
    return existingSummary + '\n\n[Compaction failed - continuing with truncated history]';
  }

  const data = await response.json();
  const summary = extractAIMessage(data);
  return summary || existingSummary + '\n\n[Compaction failed - could not parse response]';
}

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// Socket.IO connection
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`D&D Multiplayer server running on port ${PORT}`);
});
