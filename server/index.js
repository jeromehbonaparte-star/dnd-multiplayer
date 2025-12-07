require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');

const app = express();
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
const defaultPassword = process.env.GAME_PASSWORD || 'changeme';
initSetting.run('game_password', bcrypt.hashSync(defaultPassword, 10));
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

Wait for all players to submit their actions before narrating the outcome.`;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Middleware to check password
const checkPassword = (req, res, next) => {
  const password = req.headers['x-game-password'];
  const storedHash = db.prepare('SELECT value FROM settings WHERE key = ?').get('game_password');

  if (!storedHash || !bcrypt.compareSync(password || '', storedHash.value)) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  next();
};

// API Routes
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  const storedHash = db.prepare('SELECT value FROM settings WHERE key = ?').get('game_password');

  if (bcrypt.compareSync(password, storedHash.value)) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

app.get('/api/settings', checkPassword, (req, res) => {
  const settings = {};
  const rows = db.prepare('SELECT key, value FROM settings').all();
  rows.forEach(row => {
    if (row.key !== 'game_password') {
      settings[row.key] = row.value;
    }
  });
  res.json(settings);
});

app.post('/api/settings', checkPassword, (req, res) => {
  const { api_endpoint, api_key, api_model, max_tokens_before_compact, system_prompt, new_password } = req.body;

  const updateSetting = db.prepare('UPDATE settings SET value = ? WHERE key = ?');

  if (api_endpoint) updateSetting.run(api_endpoint, 'api_endpoint');
  if (api_key) updateSetting.run(api_key, 'api_key');
  if (api_model) updateSetting.run(api_model, 'api_model');
  if (max_tokens_before_compact) updateSetting.run(max_tokens_before_compact, 'max_tokens_before_compact');
  if (system_prompt) updateSetting.run(system_prompt, 'system_prompt');
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

// Level up a character (AI-assisted)
app.post('/api/characters/:id/levelup', checkPassword, async (req, res) => {
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
  const levelUpPrompt = `You are a D&D 5e level up assistant. A character is leveling up from ${character.level} to ${newLevel}.

CHARACTER INFO:
- Name: ${character.character_name}
- Race: ${character.race}
- Class: ${character.class}
- Current Level: ${character.level}
- Stats: STR ${character.strength}, DEX ${character.dexterity}, CON ${character.constitution}, INT ${character.intelligence}, WIS ${character.wisdom}, CHA ${character.charisma}
- Current HP: ${character.max_hp}
- Current Spells: ${character.spells || 'None'}
- Current Skills: ${character.skills || 'None'}
- Current Passives: ${character.passives || 'None'}

Calculate the level up benefits and respond with ONLY this JSON format (no other text):
LEVELUP_COMPLETE:{"hp_increase":N,"new_spells":"any new spells or cantrips gained","new_skills":"any new skill proficiencies","new_passives":"any new class features or abilities","summary":"Brief description of what the character gained"}

Consider:
- HP increase: Roll class hit die + CON modifier (${Math.floor((character.constitution - 10) / 2)})
- New spells for spellcasters at this level
- New class features (Extra Attack at 5, etc.)
- Ability Score Improvement at levels 4, 8, 12, 16, 19`;

  try {
    const response = await fetch(settings.api_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.api_key}`
      },
      body: JSON.stringify({
        model: settings.api_model,
        messages: [{ role: 'user', content: levelUpPrompt }],
        max_tokens: 64000
      })
    });

    if (!response.ok) {
      throw new Error('AI API error');
    }

    const data = await response.json();
    const aiMessage = extractAIMessage(data);

    if (aiMessage && aiMessage.includes('LEVELUP_COMPLETE:')) {
      const jsonMatch = aiMessage.match(/LEVELUP_COMPLETE:(\{.*\})/);
      if (jsonMatch) {
        const levelData = JSON.parse(jsonMatch[1]);

        // Update character
        const newMaxHP = character.max_hp + (levelData.hp_increase || 0);
        const newSpells = character.spells ? `${character.spells}, ${levelData.new_spells}` : levelData.new_spells;
        const newSkills = character.skills ? `${character.skills}, ${levelData.new_skills}` : levelData.new_skills;
        const newPassives = character.passives ? `${character.passives}, ${levelData.new_passives}` : levelData.new_passives;

        db.prepare(`
          UPDATE characters SET level = ?, hp = ?, max_hp = ?, spells = ?, skills = ?, passives = ? WHERE id = ?
        `).run(newLevel, newMaxHP, newMaxHP, newSpells, newSkills, newPassives, req.params.id);

        const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
        io.emit('character_updated', updatedChar);
        io.emit('character_leveled_up', { character: updatedChar, summary: levelData.summary });

        return res.json({ character: updatedChar, levelUp: levelData });
      }
    }

    // Fallback manual level up
    const hpIncrease = Math.floor(Math.random() * 8) + 1 + Math.floor((character.constitution - 10) / 2);
    db.prepare('UPDATE characters SET level = ?, hp = hp + ?, max_hp = max_hp + ? WHERE id = ?')
      .run(newLevel, hpIncrease, hpIncrease, req.params.id);

    const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
    io.emit('character_updated', updatedChar);
    io.emit('character_leveled_up', { character: updatedChar, summary: `Leveled up to ${newLevel}! HP increased by ${hpIncrease}.` });

    res.json({ character: updatedChar, hpIncrease });
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
      const jsonMatch = aiMessage.match(/EDIT_COMPLETE:(\{.*\})/);
      if (jsonMatch) {
        const editData = JSON.parse(jsonMatch[1]);

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

        const cleanMessage = aiMessage.replace(/EDIT_COMPLETE:\{.*\}/, '').trim();
        return res.json({ message: cleanMessage || 'Character updated!', complete: true, character: updatedChar });
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
