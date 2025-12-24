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

  CREATE TABLE IF NOT EXISTS api_configs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    api_key TEXT NOT NULL,
    model TEXT NOT NULL,
    is_active INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS session_characters (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    character_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(session_id, character_id)
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
if (!columns.includes('feats')) {
  db.exec("ALTER TABLE characters ADD COLUMN feats TEXT DEFAULT ''");
}
if (!columns.includes('classes')) {
  // Multiclass support: JSON object like {"Fighter": 5, "Wizard": 3}
  // Will be initialized from existing class column on first load
  db.exec("ALTER TABLE characters ADD COLUMN classes TEXT DEFAULT '{}'");
}
if (!columns.includes('ac_effects')) {
  // AC effects tracking: JSON object with base_source, base_value, and effects array
  // Structure: { base_source: "Studded Leather", base_value: 14, effects: [{id, name, value, type, temporary, notes}] }
  db.exec(`ALTER TABLE characters ADD COLUMN ac_effects TEXT DEFAULT '{"base_source":"Unarmored","base_value":10,"effects":[]}'`);
}
if (!columns.includes('class_features')) {
  // Class features tracking: class abilities like Second Wind, Action Surge, Song of Rest, etc.
  db.exec("ALTER TABLE characters ADD COLUMN class_features TEXT DEFAULT ''");
}
if (!columns.includes('appearance')) {
  // Physical appearance description: hair, eyes, height, distinguishing features, etc.
  db.exec("ALTER TABLE characters ADD COLUMN appearance TEXT DEFAULT ''");
}
if (!columns.includes('backstory')) {
  // Character's personal history and background story
  db.exec("ALTER TABLE characters ADD COLUMN backstory TEXT DEFAULT ''");
}

// Combat tracker table
db.exec(`
  CREATE TABLE IF NOT EXISTS combats (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    name TEXT DEFAULT 'Combat',
    is_active INTEGER DEFAULT 1,
    current_turn INTEGER DEFAULT 0,
    round INTEGER DEFAULT 1,
    combatants TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES game_sessions(id)
  )
`);

// Add initiative column to characters if not exists
if (!columns.includes('initiative_bonus')) {
  db.exec("ALTER TABLE characters ADD COLUMN initiative_bonus INTEGER DEFAULT 0");
}

// Migrate existing characters to use multiclass format
const charsToMigrate = db.prepare("SELECT id, class, level, classes FROM characters WHERE classes = '{}' OR classes IS NULL").all();
for (const char of charsToMigrate) {
  if (char.class && char.level) {
    const classesObj = {};
    classesObj[char.class] = char.level;
    db.prepare("UPDATE characters SET classes = ? WHERE id = ?").run(JSON.stringify(classesObj), char.id);
  }
}

// Migrate existing characters to use ac_effects format
const charsToMigrateAc = db.prepare("SELECT id, ac, ac_effects FROM characters WHERE ac_effects IS NULL OR ac_effects = '{\"base_source\":\"Unarmored\",\"base_value\":10,\"effects\":[]}'").all();
for (const char of charsToMigrateAc) {
  const currentAc = char.ac || 10;
  // If AC is different from default 10, preserve it as base value
  if (currentAc !== 10 || !char.ac_effects) {
    const acEffects = {
      base_source: currentAc > 10 ? "Equipment" : "Unarmored",
      base_value: currentAc,
      effects: []
    };
    db.prepare("UPDATE characters SET ac_effects = ? WHERE id = ?").run(JSON.stringify(acEffects), char.id);
  }
}

// Migrate game_sessions table - add compacted_count column
const sessionColumns = db.prepare("PRAGMA table_info(game_sessions)").all().map(c => c.name);
if (!sessionColumns.includes('compacted_count')) {
  db.exec('ALTER TABLE game_sessions ADD COLUMN compacted_count INTEGER DEFAULT 0');
}

// Migrate game_sessions table - add scenario column
if (!sessionColumns.includes('scenario')) {
  db.exec("ALTER TABLE game_sessions ADD COLUMN scenario TEXT DEFAULT 'classic_fantasy'");
}

// Migrate existing API settings to api_configs table if needed
const existingConfigs = db.prepare('SELECT COUNT(*) as count FROM api_configs').get();
if (existingConfigs.count === 0) {
  // Check if there are old-style settings to migrate
  const oldEndpoint = db.prepare("SELECT value FROM settings WHERE key = 'api_endpoint'").get();
  const oldKey = db.prepare("SELECT value FROM settings WHERE key = 'api_key'").get();
  const oldModel = db.prepare("SELECT value FROM settings WHERE key = 'api_model'").get();

  if (oldKey && oldKey.value) {
    // Migrate old settings to new api_configs table
    db.prepare('INSERT INTO api_configs (id, name, endpoint, api_key, model, is_active) VALUES (?, ?, ?, ?, ?, 1)')
      .run(uuidv4(), 'Default', oldEndpoint?.value || 'https://api.openai.com/v1/chat/completions', oldKey.value, oldModel?.value || 'gpt-4');
  }
}

// Helper function to get active API config
function getActiveApiConfig() {
  const config = db.prepare('SELECT * FROM api_configs WHERE is_active = 1').get();
  if (config) {
    return {
      api_endpoint: config.endpoint,
      api_key: config.api_key,
      api_model: config.model
    };
  }
  return null;
}

// XP requirements for each level
const XP_TABLE = [0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000];

function getRequiredXP(level) {
  return XP_TABLE[level] || 355000;
}

function canLevelUp(xp, level) {
  return xp >= getRequiredXP(level);
}

// AC Effects helper functions
function parseAcEffects(acEffectsJson) {
  try {
    const parsed = JSON.parse(acEffectsJson || '{}');
    return {
      base_source: parsed.base_source || 'Unarmored',
      base_value: parsed.base_value || 10,
      effects: parsed.effects || []
    };
  } catch (e) {
    return { base_source: 'Unarmored', base_value: 10, effects: [] };
  }
}

function calculateTotalAC(acEffects) {
  const data = typeof acEffects === 'string' ? parseAcEffects(acEffects) : acEffects;
  const effectsBonus = data.effects.reduce((sum, e) => sum + (e.value || 0), 0);
  return data.base_value + effectsBonus;
}

function updateCharacterAC(charId, acEffects) {
  const totalAC = calculateTotalAC(acEffects);
  const acEffectsJson = JSON.stringify(acEffects);
  db.prepare('UPDATE characters SET ac = ?, ac_effects = ? WHERE id = ?').run(totalAC, acEffectsJson, charId);
  return { ac: totalAC, ac_effects: acEffects };
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
const DEFAULT_SYSTEM_PROMPT = `You are a masterful Dungeon Master for a D&D 5e game, weaving tales with the skill of legendary storytellers.

═══════════════════════════════════════════════════════════════
NARRATIVE MASTERY - YOUR WRITING STYLE
═══════════════════════════════════════════════════════════════

Channel the essence of fantasy's greatest authors:

**TOLKIEN'S GRANDEUR**: Paint the world with epic, sweeping language. Let ancient forests whisper secrets and mountains stand as silent sentinels. Use occasional poetic phrases that make moments feel legendary.
"The dawn crept over the Mistpeak Mountains, painting the snow in hues of rose and gold—a beauty that seemed almost a mockery of the darkness that awaited below."

**SALVATORE'S COMBAT POETRY**: Make every sword swing sing. Combat should be visceral, dynamic, and cinematic. Describe the dance of blades, the desperate parries, the triumphant strikes.
"Steel met steel in a shower of sparks. The orc's crude blade swept low, but Kira was already airborne, spinning over the attack and bringing her rapier down in a silver arc that painted crimson across her enemy's shoulder."

**ROTHFUSS'S LYRICAL BEAUTY**: Find the poetry in small moments. Use metaphor and simile to make descriptions memorable. Let silence speak and let words carry weight.
"The tavern fell quiet—not the comfortable silence of old friends, but the brittle silence of a held breath, of a story waiting to be told."

**SANDERSON'S CLARITY**: In action scenes, be precise and visual. The reader should always know where everyone is, what's at stake, and feel the tension ratchet higher with each exchange.

**PRATCHETT'S WIT**: Sprinkle in clever observations and moments of levity. Even in dark times, a well-placed bit of humor makes the serious moments hit harder.
"The dragon regarded them with the patient expression of someone who had all the time in the world—mainly because it intended to eat everyone who might disagree."

**MARTIN'S CONSEQUENCES**: Actions have weight. Choices matter. NPCs remember. The world reacts realistically to what the players do, for good or ill.

YOUR STORYTELLING PRINCIPLES:
• Show, don't tell—let players discover through vivid description
• Give NPCs distinct voices, mannerisms, and motivations
• Build tension through pacing—quiet moments make loud ones thunder
• Use all five senses: the smell of rain on stone, the taste of copper fear
• End scenes with hooks that make players eager for what comes next
• Remember: the players are the heroes of this story—make them feel heroic

═══════════════════════════════════════════════════════════════
YOUR ROLE AS DUNGEON MASTER
═══════════════════════════════════════════════════════════════

- Narrate with vivid, immersive prose that brings the world to life
- Control NPCs and monsters with distinct personalities
- Describe environments that feel real and lived-in
- Present meaningful choices with real consequences
- Be fair but challenging—triumph should be earned
- Award XP for combat victories, puzzle solving, and memorable roleplay
- Maintain consistency in the world and its inhabitants

═══════════════════════════════════════════════════════════════
DICE ROLLING - YOU MUST ROLL DICE YOURSELF
═══════════════════════════════════════════════════════════════

When a player attempts an action requiring a check:

1. Roll the appropriate die (d20 for most checks, damage dice for attacks)
2. Add the relevant modifier from their stats:
   - STR modifier = (STR - 10) / 2 (rounded down)
   - DEX modifier = (DEX - 10) / 2 (rounded down)
   - etc.
3. Add proficiency bonus (+2 at levels 1-4, +3 at 5-8, etc.) if proficient
4. Compare to DC or AC and narrate the result with dramatic flair

EXAMPLE:
"Thorin raises his axe, muscles coiling like springs wound too tight. [Rolling d20 + 3 STR + 2 proficiency = d20+5... rolled 18+5 = 23 vs AC 12 - DEVASTATING HIT!] The blade descends in a silver arc, catching the firelight—and the goblin—simultaneously. [Damage: 1d8+3 = 8 damage] The creature crumples without a sound, its last expression one of profound surprise."

═══════════════════════════════════════════════════════════════
COMBAT - MAKE IT MEMORABLE
═══════════════════════════════════════════════════════════════

INITIATIVE & TURN ORDER:
- Players manage their own Combat Tracker with initiative order
- Focus on narrating the ACTION, not managing initiative
- When combat starts, describe the chaos and tension
- Reference whose turn it is based on the action they describe
- Ask for initiative rolls when combat begins: "Roll initiative!"

COMBAT NARRATION:
- Track enemy HP mentally
- Describe hits as wounds that matter—cuts that bleed, bruises that ache
- Misses should be near-things: "The blade whistles past close enough to trim hair"
- Critical hits (nat 20) are LEGENDARY moments—double dice, double drama
- Critical fails (nat 1) are comedic or dangerous, never boring
- Announce when enemies are bloodied (half HP) or near death
- Describe death blows dramatically

═══════════════════════════════════════════════════════════════
MULTICLASS & FEATS - CHARACTER COMPLEXITY
═══════════════════════════════════════════════════════════════

MULTICLASS CHARACTERS:
- Characters may have levels in multiple classes (e.g., "Fighter 3 / Wizard 2")
- Use the abilities and features from ALL their classes appropriately
- Spellcasting for multiclass: combine spell slots using the multiclass table
- A Fighter 3/Wizard 2 fights with martial prowess AND casts spells

FEATS - SPECIAL ABILITIES:
Characters may have feats that grant special abilities. When relevant, remember:
- Great Weapon Master: Can take -5 to hit for +10 damage with heavy weapons
- Sharpshooter: -5 to hit for +10 damage with ranged, ignore cover
- Sentinel: Opportunity attacks reduce speed to 0, can attack when allies hit
- Polearm Master: Bonus action attack, opportunity attacks at reach
- War Caster: Advantage on concentration, can cast spells as opportunity attacks
- Lucky: Can reroll dice (limited uses per long rest)
- Alert: +5 initiative, can't be surprised
- Tough: Extra HP equal to 2x level
- Mobile: Extra speed, no opportunity attacks from creatures you attack

Always consider a character's feats when describing their combat actions!

═══════════════════════════════════════════════════════════════
TRACKING SYSTEMS - CRITICAL: USE THESE EXACT TAG FORMATS
═══════════════════════════════════════════════════════════════

⚠️ CRITICAL RULES FOR UPDATING CHARACTER DATA:
1. You MUST use the bracketed tags below to update character stats
2. The tags are PARSED BY THE SYSTEM to update the database
3. NEVER output modified character sheets, stat blocks, or JSON
4. NEVER say "I've updated X's stats to..." - just use the tags
5. Tags should be embedded naturally in your narrative prose

❌ WRONG: "Thorin's updated stats: HP: 35/45, XP: 150..."
❌ WRONG: Outputting a character sheet or stat block
✓ CORRECT: "The blade bites deep! [HP: Thorin -10]" (naturally in narrative)

**XP AWARDS:**
- Easy encounter: 50 XP per character
- Medium encounter: 100 XP per character
- Hard encounter: 200 XP per character
- Boss/deadly: 300+ XP per character
- Brilliant roleplay/clever solutions: 25-50 XP

Format: [XP: CharacterName +100, OtherCharacter +100]
Example: "Victory! The goblins fall, and with them, fear itself. [XP: Thorin +50, Elara +50, Grimm +50]"

**MONEY & LOOT:**
[MONEY: CharacterName +50, OtherCharacter +25]
[ITEM: CharacterName +Sword of Fire, CharacterName +Health Potion x3]
[ITEM: CharacterName -Health Potion] (for items used/lost)

Use setting-appropriate currency (gp for fantasy, USD/credits for modern/sci-fi, coins for medieval, etc.)

Examples:
- Fantasy: "The chest reveals glittering coins! [MONEY: Thorin +50, Elara +50]" (50 gp each)
- Modern: "The client transfers the payment. [MONEY: Jake +500]" ($500)
- Sci-fi: "Credits deposited to your account. [MONEY: Zara +1000]" (1000 credits)
- "The merchant's eyes gleam. [MONEY: Grimm -25] [ITEM: Grimm +Healing Potion]"

**SPELL SLOT TRACKING:**
[SPELL: CharacterName -1st] (uses one 1st level slot)
[SPELL: CharacterName +REST] (restores all spell slots on long rest)

Examples:
- "Arcane words spill from Elara's lips, and three darts of force streak toward their target. [SPELL: Elara -1st]"
- "Eight hours of rest, and magic stirs anew. [SPELL: Elara +REST] [SPELL: Grimm +REST]"

**HP (HIT POINTS) TRACKING:**
[HP: CharacterName -10] (take 10 damage)
[HP: CharacterName +5] (heal 5 HP, won't exceed max)
[HP: CharacterName =20] (set HP to exactly 20)

Examples:
- "The goblin's blade finds its mark! [HP: Thorin -8]"
- "The healing light washes over the party. [HP: Elara +10] [HP: Grimm +10]"
- "After a long rest, the party wakes refreshed. [HP: Thorin =45] [HP: Elara =32]"

**COMBAT CONTROL:**
[COMBAT: START Combat Name] (start combat, auto-rolls initiative for party)
[COMBAT: END] (end the current combat)
[COMBAT: NEXT] (advance to next turn)
[COMBAT: PREV] (go back one turn)

Examples:
- "The goblins leap from the shadows, weapons drawn! Roll for initiative! [COMBAT: START Goblin Ambush]"
- "The last enemy falls. Victory! [COMBAT: END]"
- "Thorin's turn ends as he takes a defensive stance. [COMBAT: NEXT]"

**AC (ARMOR CLASS) TRACKING:**
Track AC changes from spells, items, and effects so players can see what's affecting their defense.

Add AC effect: [AC: CharacterName +EffectName +Value Type]
- Type can be: spell, equipment, item, class_feature, other
- Example: [AC: Elara +Shield of Faith +2 spell]
- Example: [AC: Thorin +Shield +2 equipment]
- Example: [AC: Grimm +Ring of Protection +1 item]

Remove AC effect: [AC: CharacterName -EffectName]
- Use when a spell ends, item is removed, or effect expires
- Example: [AC: Elara -Shield of Faith]
- Example: [AC: Thorin -Shield]

Set base AC: [AC: CharacterName base ArmorName Value]
- Use when armor changes (equipping new armor, etc.)
- Example: [AC: Thorin base Plate Armor 18]
- Example: [AC: Elara base Mage Armor 13]

IMPORTANT: Always use these tags when:
- A spell affecting AC is cast (Shield of Faith, Mage Armor, Haste, Shield spell, etc.)
- A spell affecting AC ends or concentration is broken
- Armor or shields are equipped/unequipped
- Magic items affecting AC are gained/lost

⚠️ REMINDER: The ONLY way to update character data is through the bracketed tags above.
Do NOT output character sheets, stat blocks, JSON, or "updated stats" summaries.
The system automatically parses your narrative for these tags and updates the database.
Simply weave the tags naturally into your storytelling prose.

═══════════════════════════════════════════════════════════════
PLAYER AGENCY - LET THEM DISCOVER, DON'T HAND THEM MENUS
═══════════════════════════════════════════════════════════════

NEVER give players numbered lists of "actionable paths" or choices like:
❌ "You now have clear options:
   1. Investigate the warehouse
   2. Talk to the merchant
   3. Follow the trail"

This breaks immersion and turns D&D into a video game menu. Instead:

✓ Describe the world and let players decide what interests them
✓ Drop hints and clues organically within your narrative
✓ Let NPCs mention things in conversation naturally
✓ Trust players to pick up on leads without being spoon-fed
✓ End scenes with atmosphere and intrigue, not a list of choices

GOOD ENDING:
"The tavern keeper wipes down the counter, his eyes darting briefly toward the cellar door before looking away too quickly. Outside, the rain continues to fall, and somewhere in the distance, a dog howls at something unseen. The night is young, and this city clearly has secrets it's reluctant to share."

BAD ENDING:
"You have several options:
1. Ask the tavern keeper about the cellar
2. Investigate outside
3. Go to sleep"

Let the players drive the story. They will ask questions, investigate, and choose their own path. Your job is to make the world feel alive and full of possibility—not to present a multiple choice test.

═══════════════════════════════════════════════════════════════

Wait for all players to submit their actions before narrating the outcome.
Remember: You are not just running a game—you are crafting a legend.`;

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

// ==================== API Configuration Management ====================

// Get all API configurations
app.get('/api/api-configs', checkPassword, (req, res) => {
  const configs = db.prepare('SELECT * FROM api_configs ORDER BY created_at DESC').all();
  // Mask API keys for security
  const maskedConfigs = configs.map(config => ({
    ...config,
    api_key: config.api_key.length > 4 ? '****' + config.api_key.slice(-4) : '****',
    api_key_set: !!config.api_key
  }));
  res.json(maskedConfigs);
});

// Create new API configuration
app.post('/api/api-configs', checkPassword, (req, res) => {
  const { name, endpoint, api_key, model, is_active } = req.body;

  if (!name || !endpoint || !api_key || !model) {
    return res.status(400).json({ error: 'All fields are required: name, endpoint, api_key, model' });
  }

  const id = uuidv4();

  // If this is set to active, deactivate all others first
  if (is_active) {
    db.prepare('UPDATE api_configs SET is_active = 0').run();
  }

  db.prepare('INSERT INTO api_configs (id, name, endpoint, api_key, model, is_active) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name, endpoint, api_key, model, is_active ? 1 : 0);

  res.json({ success: true, id });
});

// Update API configuration
app.put('/api/api-configs/:id', checkPassword, (req, res) => {
  const { id } = req.params;
  const { name, endpoint, api_key, model } = req.body;

  const existing = db.prepare('SELECT * FROM api_configs WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: 'API configuration not found' });
  }

  // Only update fields that were provided
  const updates = [];
  const values = [];

  if (name) { updates.push('name = ?'); values.push(name); }
  if (endpoint) { updates.push('endpoint = ?'); values.push(endpoint); }
  if (api_key) { updates.push('api_key = ?'); values.push(api_key); }
  if (model) { updates.push('model = ?'); values.push(model); }

  if (updates.length > 0) {
    values.push(id);
    db.prepare(`UPDATE api_configs SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  res.json({ success: true });
});

// Delete API configuration
app.delete('/api/api-configs/:id', checkPassword, (req, res) => {
  const { id } = req.params;

  const existing = db.prepare('SELECT * FROM api_configs WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: 'API configuration not found' });
  }

  // Don't allow deleting the last config
  const configCount = db.prepare('SELECT COUNT(*) as count FROM api_configs').get();
  if (configCount.count <= 1) {
    return res.status(400).json({ error: 'Cannot delete the last API configuration' });
  }

  // If deleting the active config, activate the first remaining one
  if (existing.is_active) {
    db.prepare('DELETE FROM api_configs WHERE id = ?').run(id);
    const firstConfig = db.prepare('SELECT id FROM api_configs ORDER BY created_at ASC LIMIT 1').get();
    if (firstConfig) {
      db.prepare('UPDATE api_configs SET is_active = 1 WHERE id = ?').run(firstConfig.id);
    }
  } else {
    db.prepare('DELETE FROM api_configs WHERE id = ?').run(id);
  }

  res.json({ success: true });
});

// Activate specific API configuration
app.post('/api/api-configs/:id/activate', checkPassword, (req, res) => {
  const { id } = req.params;

  const existing = db.prepare('SELECT * FROM api_configs WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: 'API configuration not found' });
  }

  // Deactivate all, then activate the selected one
  db.prepare('UPDATE api_configs SET is_active = 0').run();
  db.prepare('UPDATE api_configs SET is_active = 1 WHERE id = ?').run(id);

  res.json({ success: true, activated: existing.name });
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

// Test API Connection by config ID
app.post('/api/test-connection/:id', checkPassword, async (req, res) => {
  const { id } = req.params;

  const config = db.prepare('SELECT * FROM api_configs WHERE id = ?').get(id);
  if (!config) {
    return res.status(404).json({ error: 'API configuration not found' });
  }

  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.api_key}`
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: 'Say "Connection successful!" in exactly those words.' }],
        max_tokens: 50
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: `API Error (${response.status}): ${errorText}` });
    }

    const data = await response.json();

    // Handle different response formats
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

    if (typeof message === 'object') {
      message = JSON.stringify(message);
    }

    res.json({
      success: true,
      message: message.substring(0, 200),
      model: data.model || data.model_name || config.model
    });
  } catch (error) {
    res.status(500).json({ error: `Connection failed: ${error.message}` });
  }
});

// Helper function to find character by name with fuzzy matching
// Matches: exact name, first name only, or partial match
function findCharacterByName(characters, searchName) {
  if (!searchName || !characters || characters.length === 0) return null;

  const search = searchName.toLowerCase().trim();

  // 1. Exact match (case-insensitive)
  let char = characters.find(c => c.character_name.toLowerCase() === search);
  if (char) return char;

  // 2. First name match (e.g., "Reinhard" matches "Reinhard Lockeheart")
  char = characters.find(c => c.character_name.toLowerCase().startsWith(search + ' ') ||
                              c.character_name.toLowerCase().split(' ')[0] === search);
  if (char) return char;

  // 3. Partial match (name contains search term)
  char = characters.find(c => c.character_name.toLowerCase().includes(search));
  if (char) return char;

  // 4. Search term contains character's first name
  char = characters.find(c => {
    const firstName = c.character_name.toLowerCase().split(' ')[0];
    return search.includes(firstName) && firstName.length > 2;
  });
  if (char) return char;

  return null;
}

// Helper function to get characters for a specific session
function getSessionCharacters(sessionId) {
  return db.prepare(`
    SELECT c.* FROM characters c
    INNER JOIN session_characters sc ON c.id = sc.character_id
    WHERE sc.session_id = ?
    ORDER BY c.created_at DESC
  `).all(sessionId);
}

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

// Update AC and AC effects
// Actions: 'set_base', 'add_effect', 'remove_effect', 'update_effect', 'set' (legacy - just set total AC)
app.post('/api/characters/:id/ac', checkPassword, (req, res) => {
  const { action, ac, base_source, base_value, effect } = req.body;
  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);

  if (!character) {
    return res.status(404).json({ error: 'Character not found' });
  }

  let acEffects = parseAcEffects(character.ac_effects);

  // Legacy support: if just 'ac' is provided without action, set base value
  if (ac !== undefined && !action) {
    acEffects.base_value = ac;
    acEffects.base_source = acEffects.base_source || 'Equipment';
  } else if (action === 'set_base') {
    // Set base AC (armor/unarmored)
    acEffects.base_source = base_source || acEffects.base_source;
    acEffects.base_value = base_value !== undefined ? base_value : acEffects.base_value;
  } else if (action === 'add_effect' && effect) {
    // Add a new effect
    const newEffect = {
      id: uuidv4(),
      name: effect.name || 'Unknown',
      value: effect.value || 0,
      type: effect.type || 'other', // equipment, spell, class_feature, item, other
      temporary: effect.temporary || false,
      notes: effect.notes || ''
    };
    acEffects.effects.push(newEffect);
  } else if (action === 'remove_effect' && effect) {
    // Remove an effect by id or name
    if (effect.id) {
      acEffects.effects = acEffects.effects.filter(e => e.id !== effect.id);
    } else if (effect.name) {
      // Remove first matching by name (case-insensitive)
      const idx = acEffects.effects.findIndex(e => e.name.toLowerCase() === effect.name.toLowerCase());
      if (idx !== -1) {
        acEffects.effects.splice(idx, 1);
      }
    }
  } else if (action === 'update_effect' && effect && effect.id) {
    // Update an existing effect
    const idx = acEffects.effects.findIndex(e => e.id === effect.id);
    if (idx !== -1) {
      acEffects.effects[idx] = { ...acEffects.effects[idx], ...effect };
    }
  } else if (action === 'clear_temporary') {
    // Remove all temporary effects
    acEffects.effects = acEffects.effects.filter(e => !e.temporary);
  } else if (action === 'set_all') {
    // Set the entire ac_effects structure
    acEffects = {
      base_source: base_source || acEffects.base_source,
      base_value: base_value !== undefined ? base_value : acEffects.base_value,
      effects: req.body.effects || acEffects.effects
    };
  }

  // Update character with new AC data
  updateCharacterAC(req.params.id, acEffects);

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

// Quick update character fields (direct, no AI)
app.post('/api/characters/:id/quick-update', checkPassword, (req, res) => {
  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
  if (!character) {
    return res.status(404).json({ error: 'Character not found' });
  }

  const allowedFields = ['appearance', 'backstory', 'class_features', 'passives', 'skills', 'spells', 'feats', 'background'];
  const updates = [];
  const values = [];

  allowedFields.forEach(field => {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = ?`);
      values.push(req.body[field]);
    }
  });

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  values.push(req.params.id);
  db.prepare(`UPDATE characters SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
  io.emit('character_updated', updatedChar);
  res.json(updatedChar);
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

  const apiConfig = getActiveApiConfig();
  if (!apiConfig || !apiConfig.api_key) {
    return res.status(400).json({ error: 'No active API configuration. Please add and activate one in Settings.' });
  }

  const newLevel = character.level + 1;
  const conMod = Math.floor((character.constitution - 10) / 2);

  // Parse current classes
  let currentClasses = {};
  try {
    currentClasses = JSON.parse(character.classes || '{}');
  } catch (e) {
    currentClasses = {};
    if (character.class) {
      currentClasses[character.class] = character.level;
    }
  }
  const classesDisplay = Object.entries(currentClasses).map(([cls, lvl]) => `${cls} ${lvl}`).join(' / ') || character.class;

  const levelUpSystemPrompt = `You are a friendly D&D 5e level up assistant. Help ${character.character_name} level up from ${character.level} to ${newLevel}.

CURRENT CHARACTER:
- Name: ${character.character_name}
- Race: ${character.race}
- Classes: ${classesDisplay}
- Total Level: ${character.level}
- Stats: STR ${character.strength}, DEX ${character.dexterity}, CON ${character.constitution}, INT ${character.intelligence}, WIS ${character.wisdom}, CHA ${character.charisma}
- Current HP: ${character.max_hp}
- Current Spells: ${character.spells || 'None'}
- Current Skills: ${character.skills || 'None'}
- Current Passives: ${character.passives || 'None'}
- Current Class Features: ${character.class_features || 'None'}
- Current Feats: ${character.feats || 'None'}

LEVEL UP RULES:
1. FIRST, ask if they want to:
   a) Continue in their current class (${character.class})
   b) MULTICLASS into a new class (must meet multiclass requirements - usually 13+ in key ability)

2. HP Increase: Roll the hit die of the class they're taking a level in + CON modifier (${conMod}).
   - Barbarian: d12, Fighter/Paladin/Ranger: d10, Wizard/Sorcerer: d6, Others: d8

3. Check if this class level grants new features (check the specific class level, not total level!)

4. ASI/FEAT LEVELS: At class levels 4, 8, 12, 16, 19 in ANY class, offer the choice:
   - Ability Score Improvement: +2 to one stat OR +1 to two stats
   - OR take a FEAT instead (Great Weapon Master, Sharpshooter, Lucky, Sentinel, War Caster, etc.)

5. For spellcasters, check for new spell slots and spells (based on class level, not total level)

MULTICLASS REQUIREMENTS (need 13+ in the key ability to multiclass INTO a class):
- Barbarian: STR 13, Bard: CHA 13, Cleric: WIS 13, Druid: WIS 13
- Fighter: STR or DEX 13, Monk: DEX and WIS 13, Paladin: STR and CHA 13
- Ranger: DEX and WIS 13, Rogue: DEX 13, Sorcerer: CHA 13
- Warlock: CHA 13, Wizard: INT 13

CLASS FEATURES - These are class-specific abilities gained at each level:
- Fighter: Second Wind (1), Action Surge (2), Martial Archetype (3), Extra Attack (5), Indomitable (9)
- Barbarian: Rage (1), Reckless Attack (2), Primal Path (3), Extra Attack (5), Brutal Critical (9)
- Rogue: Sneak Attack (1), Cunning Action (2), Roguish Archetype (3), Uncanny Dodge (5), Evasion (7)
- Bard: Bardic Inspiration (1), Jack of All Trades (2), Song of Rest (2), Bard College (3), Font of Inspiration (5)
- Cleric: Spellcasting (1), Channel Divinity (2), Divine Domain features, Destroy Undead (5)
- Wizard: Spellcasting (1), Arcane Recovery (1), Arcane Tradition (2)
- Paladin: Divine Sense (1), Lay on Hands (1), Fighting Style (2), Divine Smite (2), Sacred Oath (3), Extra Attack (5), Aura of Protection (6)
- Ranger: Favored Enemy (1), Natural Explorer (1), Fighting Style (2), Spellcasting (2), Ranger Archetype (3), Extra Attack (5)
- Monk: Unarmored Defense (1), Martial Arts (1), Ki (2), Unarmored Movement (2), Monastic Tradition (3), Deflect Missiles (3), Slow Fall (4), Extra Attack (5), Stunning Strike (5)
- Sorcerer: Spellcasting (1), Sorcerous Origin (1), Font of Magic (2), Metamagic (3)
- Warlock: Otherworldly Patron (1), Pact Magic (1), Eldritch Invocations (2), Pact Boon (3)
- Druid: Druidic (1), Spellcasting (1), Wild Shape (2), Druid Circle (2)

Guide the player through their choices conversationally. When ALL choices are finalized, output:
LEVELUP_COMPLETE:{"hp_increase":N,"class_leveled":"ClassName","new_class_level":N,"new_spells":"spells gained or None","new_skills":"skills gained or None","new_passives":"passives gained or None","new_class_features":"class features gained or None","stat_changes":"any stat increases or None","new_feat":"feat taken or None","summary":"Brief exciting summary"}`;

  try {
    const allMessages = [
      { role: 'system', content: levelUpSystemPrompt },
      ...(messages || [])
    ];

    const response = await fetch(apiConfig.api_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiConfig.api_key}`
      },
      body: JSON.stringify({
        model: apiConfig.api_model,
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

          // Handle class features
          const newClassFeatures = levelData.new_class_features && levelData.new_class_features !== 'None'
            ? (character.class_features ? `${character.class_features}, ${levelData.new_class_features}` : levelData.new_class_features)
            : character.class_features;

          // Handle feats
          const newFeats = levelData.new_feat && levelData.new_feat !== 'None'
            ? (character.feats ? `${character.feats}, ${levelData.new_feat}` : levelData.new_feat)
            : character.feats;

          // Handle multiclass - update classes JSON
          let updatedClasses = {};
          try {
            updatedClasses = JSON.parse(character.classes || '{}');
          } catch (e) {
            updatedClasses = {};
            if (character.class) {
              updatedClasses[character.class] = character.level;
            }
          }

          // Update the class that was leveled
          const classLeveled = levelData.class_leveled || character.class;
          updatedClasses[classLeveled] = (updatedClasses[classLeveled] || 0) + 1;

          // Determine primary class (highest level class)
          const primaryClass = Object.entries(updatedClasses)
            .sort((a, b) => b[1] - a[1])[0][0];

          db.prepare(`
            UPDATE characters SET level = ?, hp = ?, max_hp = ?, spells = ?, skills = ?, passives = ?, class_features = ?, feats = ?, classes = ?, class = ? WHERE id = ?
          `).run(newLevel, newMaxHP, newMaxHP, newSpells || '', newSkills || '', newPassives || '', newClassFeatures || '', newFeats || '', JSON.stringify(updatedClasses), primaryClass, req.params.id);

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

  const apiConfig = getActiveApiConfig();
  if (!apiConfig || !apiConfig.api_key) {
    return res.status(400).json({ error: 'No active API configuration. Please add and activate one in Settings.' });
  }

  // Parse spell slots for display
  let spellSlotsDisplay = 'None';
  try {
    const slots = JSON.parse(character.spell_slots || '{}');
    if (Object.keys(slots).length > 0) {
      spellSlotsDisplay = Object.entries(slots)
        .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
        .map(([lvl, data]) => `Level ${lvl}: ${data.current}/${data.max}`)
        .join(', ');
    }
  } catch (e) { }

  // Parse classes for multiclass display
  let classesDisplay = character.class;
  let classesJson = '{}';
  try {
    const classes = JSON.parse(character.classes || '{}');
    if (Object.keys(classes).length > 0) {
      classesDisplay = Object.entries(classes).map(([cls, lvl]) => `${cls} ${lvl}`).join(' / ');
      classesJson = JSON.stringify(classes);
    }
  } catch (e) { }

  const editPrompt = `You are a D&D 5e character editor assistant. Help modify this character based on the user's request.

CURRENT CHARACTER:
- Player: ${character.player_name}
- Name: ${character.character_name}
- Race: ${character.race}
- Classes: ${classesDisplay} (Total Level: ${character.level})
- Classes JSON: ${classesJson}
- XP: ${character.xp || 0}
- Stats: STR ${character.strength}, DEX ${character.dexterity}, CON ${character.constitution}, INT ${character.intelligence}, WIS ${character.wisdom}, CHA ${character.charisma}
- HP: ${character.hp}/${character.max_hp}
- AC (Armor Class): ${character.ac || 10}
- Spell Slots: ${spellSlotsDisplay}
- Background: ${character.background}
- Appearance: ${character.appearance || 'Not set'}
- Backstory: ${character.backstory || 'Not set'}
- Equipment: ${character.equipment}
- Spells: ${character.spells || 'None'}
- Skills: ${character.skills || 'None'}
- Passives: ${character.passives || 'None'}
- Class Features: ${character.class_features || 'None'}
- Feats: ${character.feats || 'None'}

USER'S EDIT REQUEST: ${editRequest}

Discuss the changes with the user. When you have confirmed ALL changes, output the COMPLETE updated character in this EXACT JSON format.
IMPORTANT: Include ALL fields with their current or updated values - do not omit any fields!

EDIT_COMPLETE:{"character_name":"...","race":"...","class":"PrimaryClass","classes":{"Fighter":5,"Wizard":2},"level":N,"strength":N,"dexterity":N,"constitution":N,"intelligence":N,"wisdom":N,"charisma":N,"hp":N,"max_hp":N,"ac":N,"spell_slots":{"1":{"current":N,"max":N}},"background":"...","appearance":"Physical description","backstory":"Character history","equipment":"...","spells":"...","skills":"...","passives":"...","class_features":"Class abilities like Second Wind, Sneak Attack","feats":"..."}

MULTICLASS FORMAT:
- "class" is the primary class (highest level)
- "classes" is a JSON object with each class and its level, e.g., {"Fighter":5,"Wizard":2} for a Fighter 5/Wizard 2
- "level" is the total character level (sum of all class levels)

FEATS:
- Common feats: Alert, Lucky, Sentinel, Great Weapon Master, Sharpshooter, War Caster, Resilient, Mobile, Tough, Polearm Master, Crossbow Expert
- Separate multiple feats with commas

SPELL SLOTS FORMAT:
- spell_slots is a JSON object where keys are spell levels (1-9)
- Each level has "current" (available) and "max" (total) slots
- Example for a 5th level Wizard: {"1":{"current":4,"max":4},"2":{"current":3,"max":3},"3":{"current":2,"max":2}}
- For multiclass spellcasters, calculate slots based on combined spellcaster levels
- Omit spell_slots entirely for non-casters

AC CALCULATION:
- Base AC is 10 + DEX modifier
- Light armor: Leather (11), Studded Leather (12) + DEX
- Medium armor: Chain Shirt (13), Breastplate (14), Half Plate (15) + DEX (max 2)
- Heavy armor: Ring Mail (14), Chain Mail (16), Splint (17), Plate (18) - no DEX
- Shield adds +2
- Include all bonuses (magic items, class features like Unarmored Defense)

Only include fields that should be changed. Keep the conversation helpful and ensure changes are valid for D&D 5e.`;

  try {
    const allMessages = [
      { role: 'system', content: editPrompt },
      ...(messages || [])
    ];

    const response = await fetch(apiConfig.api_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiConfig.api_key}`
      },
      body: JSON.stringify({
        model: apiConfig.api_model,
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

          const fields = ['character_name', 'race', 'class', 'level', 'strength', 'dexterity', 'constitution',
                         'intelligence', 'wisdom', 'charisma', 'hp', 'max_hp', 'ac', 'background',
                         'appearance', 'backstory', 'equipment', 'spells', 'skills', 'passives', 'class_features', 'feats'];

          fields.forEach(field => {
            if (editData[field] !== undefined && editData[field] !== null) {
              // Only update if a value is provided (even empty string counts as intentional)
              updates.push(`${field} = ?`);
              values.push(editData[field]);
            }
          });

          // Log what fields were updated for debugging
          console.log('Edit update - fields being updated:', updates.map((u, i) => `${u.replace(' = ?', '')}=${values[i]?.substring?.(0, 30) || values[i]}`));

          // Handle spell_slots separately (needs JSON stringify)
          if (editData.spell_slots !== undefined) {
            updates.push('spell_slots = ?');
            values.push(typeof editData.spell_slots === 'string' ? editData.spell_slots : JSON.stringify(editData.spell_slots));
          }

          // Handle classes separately (needs JSON stringify for multiclass)
          if (editData.classes !== undefined) {
            updates.push('classes = ?');
            values.push(typeof editData.classes === 'string' ? editData.classes : JSON.stringify(editData.classes));
          }

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
2. Ask what RACE they want (Human, Variant Human, Elf, Dwarf, Halfling, Dragonborn, Gnome, Half-Elf, Half-Orc, Tiefling)
   - If VARIANT HUMAN: They get +1 to two different stats, one skill proficiency, and ONE FEAT at level 1!
3. Ask what CLASS they want (Fighter, Wizard, Rogue, Cleric, Barbarian, Bard, Druid, Monk, Paladin, Ranger, Sorcerer, Warlock)
4. Ask for their CHARACTER NAME
5. Ask them to describe their character's APPEARANCE (physical features: hair color, eye color, height, build, distinguishing features, clothing style)
6. Help them with a brief BACKSTORY (2-4 sentences about their history, motivations, and what drives them)
7. If Variant Human, help them choose their STARTING FEAT (e.g., Alert, Lucky, Sentinel, Great Weapon Master, Sharpshooter, War Caster, etc.)
8. Confirm their starting SPELLS (if spellcaster), SKILLS (based on class), and EQUIPMENT

For STATS, roll 4d6 drop lowest for each stat and assign them appropriately for their class.

SKILLS by class (choose proficiencies):
- Fighter: Acrobatics, Animal Handling, Athletics, History, Insight, Intimidation, Perception, Survival (pick 2)
- Wizard: Arcana, History, Insight, Investigation, Medicine, Religion (pick 2)
- Rogue: Acrobatics, Athletics, Deception, Insight, Intimidation, Investigation, Perception, Performance, Persuasion, Sleight of Hand, Stealth (pick 4)
- Cleric: History, Insight, Medicine, Persuasion, Religion (pick 2)
- Other classes: Choose 2-3 appropriate skills

FEATS (for Variant Human at level 1, or acquired at ASI levels 4, 8, 12, 16, 19):
Popular choices: Alert, Lucky, Sentinel, Great Weapon Master, Sharpshooter, War Caster, Resilient, Mobile, Tough, Observant, Polearm Master, Crossbow Expert, Shield Master, Mage Slayer

PASSIVES to include:
- Passive Perception (10 + Wisdom modifier + proficiency if proficient)
- Racial abilities (Darkvision, Fey Ancestry, etc.)

CLASS FEATURES - Class-specific abilities gained at level 1 and above:
- Fighter: Second Wind, Fighting Style
- Barbarian: Rage, Unarmored Defense
- Rogue: Sneak Attack (1d6), Expertise, Thieves' Cant
- Bard: Bardic Inspiration (d6), Spellcasting
- Cleric: Spellcasting, Divine Domain feature
- Wizard: Spellcasting, Arcane Recovery
- Paladin: Divine Sense, Lay on Hands
- Ranger: Favored Enemy, Natural Explorer
- Monk: Unarmored Defense, Martial Arts
- Sorcerer: Spellcasting, Sorcerous Origin feature
- Warlock: Otherworldly Patron feature, Pact Magic
- Druid: Druidic, Spellcasting

SPELLS for Level 1 spellcasters:
- Wizard: 3 cantrips, 6 spells in spellbook (prepare Int mod + 1)
- Cleric: 3 cantrips, prepare Wis mod + 1 spells
- Other casters: Appropriate cantrips and spells for level 1

When you have ALL information needed, output the final character in this EXACT JSON format on a single line:
CHARACTER_COMPLETE:{"player_name":"...","character_name":"...","race":"...","class":"...","classes":{"ClassName":1},"strength":N,"dexterity":N,"constitution":N,"intelligence":N,"wisdom":N,"charisma":N,"background":"D&D Background like Soldier or Noble","appearance":"Physical description: hair, eyes, height, build, distinguishing features","backstory":"2-4 sentences about history and motivations","equipment":"...","spells":"Cantrips: X, Y. Spells: A, B, C","skills":"Skill1, Skill2 (proficient), Skill3","passives":"Passive Perception: N, Darkvision 60ft","class_features":"Second Wind, Fighting Style: Defense","feats":"Feat Name (if any, otherwise empty string)"}

Note: The "classes" field is a JSON object tracking levels in each class. For a level 1 Fighter it would be {"Fighter":1}. This supports multiclassing at higher levels.

Be encouraging, creative, and help new players understand their choices. Keep responses concise but helpful.`;

app.post('/api/characters/ai-create', checkPassword, async (req, res) => {
  const { messages } = req.body;

  const apiConfig = getActiveApiConfig();
  if (!apiConfig || !apiConfig.api_key) {
    return res.status(400).json({ error: 'No active API configuration. Please add and activate one in Settings.' });
  }

  try {
    const response = await fetch(apiConfig.api_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiConfig.api_key}`
      },
      body: JSON.stringify({
        model: apiConfig.api_model,
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

          // Handle classes - if not provided, create from class field
          let classesJson = '{}';
          if (charData.classes && typeof charData.classes === 'object') {
            classesJson = JSON.stringify(charData.classes);
          } else if (charData.class) {
            const classObj = {};
            classObj[charData.class] = 1;
            classesJson = JSON.stringify(classObj);
          }

          db.prepare(`
            INSERT INTO characters (id, player_name, character_name, race, class, level, xp, strength, dexterity, constitution, intelligence, wisdom, charisma, hp, max_hp, background, appearance, backstory, equipment, spells, skills, passives, class_features, feats, classes)
            VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(id, charData.player_name, charData.character_name, charData.race, charData.class,
                 charData.strength, charData.dexterity, charData.constitution, charData.intelligence,
                 charData.wisdom, charData.charisma, hp, hp, charData.background, charData.appearance || '',
                 charData.backstory || '', charData.equipment,
                 charData.spells || '', charData.skills || '', charData.passives || '',
                 charData.class_features || '', charData.feats || '', classesJson);

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

app.post('/api/sessions', checkPassword, async (req, res) => {
  const { name, scenario, scenarioPrompt, characterIds } = req.body;
  const id = uuidv4();

  db.prepare('INSERT INTO game_sessions (id, name, full_history, story_summary, scenario) VALUES (?, ?, ?, ?, ?)').run(id, name, '[]', '', scenario || 'classic_fantasy');

  // Link selected characters to this session
  if (characterIds && characterIds.length > 0) {
    const insertCharacter = db.prepare('INSERT OR IGNORE INTO session_characters (id, session_id, character_id) VALUES (?, ?, ?)');
    for (const charId of characterIds) {
      insertCharacter.run(uuidv4(), id, charId);
    }
  }

  // Generate opening scene with AI if scenario provided
  if (scenarioPrompt) {
    try {
      const apiConfig = getActiveApiConfig();
      if (apiConfig && apiConfig.api_key) {
        // Get only the selected characters for this session
        const characters = characterIds && characterIds.length > 0
          ? db.prepare(`SELECT * FROM characters WHERE id IN (${characterIds.map(() => '?').join(',')})`).all(...characterIds)
          : [];

        // Build character intro
        let characterIntro = '';
        if (characters.length > 0) {
          characterIntro = '\n\nThe party consists of:\n' + characters.map(c => {
            let classDisplay = `${c.class} ${c.level}`;
            try {
              const classes = JSON.parse(c.classes || '{}');
              if (Object.keys(classes).length > 0) {
                classDisplay = Object.entries(classes).map(([cls, lvl]) => `${cls} ${lvl}`).join('/');
              }
            } catch (e) {}
            return `- ${c.character_name}, ${c.race} ${classDisplay} (played by ${c.player_name})`;
          }).join('\n');
        }

        const openingPrompt = `You are starting a new adventure with this setting: ${scenarioPrompt}${characterIntro}

Write an atmospheric opening scene that sets the mood and introduces the world. Describe where the party finds themselves and what they see, hear, and sense around them. Make it vivid and immersive, drawing the players into the story.

DO NOT give the players a list of choices or options. End with an evocative description that invites them to act on their own initiative.`;

        const response = await fetch(apiConfig.api_endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiConfig.api_key}`
          },
          body: JSON.stringify({
            model: apiConfig.api_model,
            messages: [
              { role: 'system', content: DEFAULT_SYSTEM_PROMPT },
              { role: 'user', content: openingPrompt }
            ],
            max_tokens: 2000
          })
        });

        if (response.ok) {
          const data = await response.json();
          const openingScene = extractAIMessage(data);

          if (openingScene) {
            // Save opening scene to history
            const history = [
              { role: 'assistant', content: openingScene, type: 'narration' }
            ];
            db.prepare('UPDATE game_sessions SET full_history = ? WHERE id = ?').run(JSON.stringify(history), id);
          }
        }
      }
    } catch (error) {
      console.error('Failed to generate opening scene:', error);
      // Continue without opening scene
    }
  }

  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(id);
  io.emit('session_created', session);
  res.json(session);
});

app.get('/api/sessions/:id', checkPassword, (req, res) => {
  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const pendingActions = db.prepare('SELECT * FROM pending_actions WHERE session_id = ?').all(req.params.id);
  const sessionCharacters = getSessionCharacters(req.params.id);

  res.json({ session, pendingActions, sessionCharacters });
});

// Delete session
app.delete('/api/sessions/:id', checkPassword, (req, res) => {
  const sessionId = req.params.id;

  // Delete associated pending actions first
  db.prepare('DELETE FROM pending_actions WHERE session_id = ?').run(sessionId);

  // Delete session character links
  db.prepare('DELETE FROM session_characters WHERE session_id = ?').run(sessionId);

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
  const characters = getSessionCharacters(sessionId);

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
  const characters = getSessionCharacters(sessionId);

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

  const characters = getSessionCharacters(sessionId);
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
              const char = findCharacterByName(characters, charName);
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
  const updatedCharacters = getSessionCharacters(sessionId);
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

  const characters = getSessionCharacters(sessionId);
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
              const char = findCharacterByName(characters, charName);
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

              const char = findCharacterByName(characters, charName);
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
  const updatedCharacters = getSessionCharacters(sessionId);
  for (const char of updatedCharacters) {
    io.emit('character_updated', char);
  }

  res.json({ success: true, goldAwarded, inventoryChanges });
});

// Recalculate AC and spell slots from session history
app.post('/api/sessions/:id/recalculate-ac-spells', checkPassword, (req, res) => {
  const sessionId = req.params.id;
  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const characters = getSessionCharacters(sessionId);
  const history = JSON.parse(session.full_history || '[]');
  const acValues = {};
  const acEffectsTracking = {};  // Track AC effects per character
  const spellSlotUsage = {};

  // Initialize tracking for each character
  for (const char of characters) {
    acValues[char.id] = null; // null means not found
    acEffectsTracking[char.id] = parseAcEffects(char.ac_effects); // Start with current effects
    spellSlotUsage[char.id] = {};
  }

  // Scan all messages for AC and spell slot information
  for (const entry of history) {
    const content = entry.content || '';

    // Parse [AC:] tags for AC effects
    const acMatches = content.match(/\[AC:([^\]]+)\]/gi);
    if (acMatches) {
      for (const match of acMatches) {
        const acContent = match.replace(/\[AC:/i, '').replace(']', '').trim();

        // Try to match "base" command: CharacterName base ArmorName Value
        const baseMatch = acContent.match(/(.+?)\s+base\s+(.+?)\s+(\d+)$/i);
        if (baseMatch) {
          const charName = baseMatch[1].trim();
          const armorName = baseMatch[2].trim();
          const baseValue = parseInt(baseMatch[3]);

          const char = findCharacterByName(characters, charName);
          if (char) {
            acEffectsTracking[char.id].base_source = armorName;
            acEffectsTracking[char.id].base_value = baseValue;
          }
          continue;
        }

        // Try to match add effect: CharacterName +EffectName +Value Type
        const addMatch = acContent.match(/(.+?)\s+\+(.+?)\s+\+(\d+)\s+(\w+)$/i);
        if (addMatch) {
          const charName = addMatch[1].trim();
          const effectName = addMatch[2].trim();
          const effectValue = parseInt(addMatch[3]);
          const effectType = addMatch[4].trim().toLowerCase();

          const char = findCharacterByName(characters, charName);
          if (char) {
            // Check if effect already exists
            const existingIdx = acEffectsTracking[char.id].effects.findIndex(e => e.name.toLowerCase() === effectName.toLowerCase());
            if (existingIdx !== -1) {
              acEffectsTracking[char.id].effects[existingIdx].value = effectValue;
              acEffectsTracking[char.id].effects[existingIdx].type = effectType;
            } else {
              acEffectsTracking[char.id].effects.push({
                id: uuidv4(),
                name: effectName,
                value: effectValue,
                type: effectType,
                temporary: effectType === 'spell',
                notes: ''
              });
            }
          }
          continue;
        }

        // Try to match remove effect: CharacterName -EffectName
        const removeMatch = acContent.match(/(.+?)\s+-(.+)$/i);
        if (removeMatch) {
          const charName = removeMatch[1].trim();
          const effectName = removeMatch[2].trim();

          const char = findCharacterByName(characters, charName);
          if (char) {
            acEffectsTracking[char.id].effects = acEffectsTracking[char.id].effects.filter(
              e => e.name.toLowerCase() !== effectName.toLowerCase()
            );
          }
          continue;
        }
      }
    }

    // Parse [SPELL:] tags (our format)
    const spellMatches = content.match(/\[SPELL:([^\]]+)\]/gi);
    if (spellMatches) {
      for (const match of spellMatches) {
        const spellContent = match.replace(/\[SPELL:/i, '').replace(']', '');
        const parts = spellContent.split(',');

        for (const part of parts) {
          const trimmed = part.trim();

          // Check for REST command
          const restMatch = trimmed.match(/(.+?)\s*\+REST/i);
          if (restMatch) {
            const charName = restMatch[1].trim();
            const char = findCharacterByName(characters, charName);
            if (char) {
              // Reset all spell slots to max
              for (const level in spellSlotUsage[char.id]) {
                spellSlotUsage[char.id][level].used = 0;
              }
            }
            continue;
          }

          // Check for slot usage: CharacterName -1st, +2nd, etc.
          const slotMatch = trimmed.match(/(.+?)\s*([+-])(\d+)(?:st|nd|rd|th)/i);
          if (slotMatch) {
            const charName = slotMatch[1].trim();
            const isUsing = slotMatch[2] === '-';
            const level = slotMatch[3];
            const char = findCharacterByName(characters, charName);
            if (char) {
              if (!spellSlotUsage[char.id][level]) {
                spellSlotUsage[char.id][level] = { used: 0, detected: true };
              }
              if (isUsing) {
                spellSlotUsage[char.id][level].used++;
              } else {
                spellSlotUsage[char.id][level].used = Math.max(0, spellSlotUsage[char.id][level].used - 1);
              }
            }
          }
        }
      }
    }

    // Parse natural language spell casting (for older chats without [SPELL:] tags)
    // Patterns like "Gandalf casts Fireball using a 3rd level spell slot"
    const naturalSpellPattern = /(\w+(?:\s+\w+)?)\s+(?:casts?|uses?|expends?)\s+.+?(?:using\s+)?(?:a\s+)?(\d+)(?:st|nd|rd|th)[\s-]*level\s+(?:spell\s+)?slot/gi;
    let naturalMatch;
    while ((naturalMatch = naturalSpellPattern.exec(content)) !== null) {
      const charName = naturalMatch[1].trim();
      const level = naturalMatch[2];
      const char = findCharacterByName(characters, charName);
      if (char) {
        if (!spellSlotUsage[char.id][level]) {
          spellSlotUsage[char.id][level] = { used: 0, detected: true };
        }
        spellSlotUsage[char.id][level].used++;
      }
    }

    // Parse AC mentions from AI responses
    // Patterns: "AC is now 16", "AC: 18", "Armor Class of 15", "AC 14"
    if (entry.role === 'assistant') {
      for (const char of characters) {
        const charNamePattern = char.character_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Look for AC mentions near character name
        const acPatterns = [
          new RegExp(`${charNamePattern}[^.]*?(?:AC|Armor\\s*Class)\\s*(?:is\\s*(?:now\\s*)?|:\\s*|of\\s*|=\\s*)(\\d+)`, 'i'),
          new RegExp(`(?:AC|Armor\\s*Class)\\s*(?:is\\s*(?:now\\s*)?|:\\s*|of\\s*|=\\s*)(\\d+)[^.]*?${charNamePattern}`, 'i'),
          new RegExp(`${charNamePattern}'s\\s*(?:AC|Armor\\s*Class)\\s*(?:is\\s*)?(?:now\\s*)?(\\d+)`, 'i')
        ];

        for (const pattern of acPatterns) {
          const acMatch = content.match(pattern);
          if (acMatch) {
            const acValue = parseInt(acMatch[1]);
            if (acValue >= 5 && acValue <= 30) { // Sanity check for AC values
              acValues[char.id] = acValue;
            }
          }
        }
      }
    }
  }

  // Update characters with found values
  const results = { acUpdated: {}, acEffectsUpdated: {}, spellSlotsUpdated: {} };

  for (const char of characters) {
    let updated = false;

    // Update AC effects from [AC:] tags
    const trackedEffects = acEffectsTracking[char.id];
    const totalAc = calculateTotalAC(trackedEffects);
    updateCharacterAC(char.id, trackedEffects);
    results.acEffectsUpdated[char.character_name] = {
      total: totalAc,
      base: `${trackedEffects.base_source}: ${trackedEffects.base_value}`,
      effects: trackedEffects.effects.map(e => `${e.name}: +${e.value}`)
    };
    updated = true;

    // Also check for simple AC mentions (legacy support)
    if (acValues[char.id] !== null && trackedEffects.effects.length === 0) {
      // Only use simple AC if no effects were detected
      trackedEffects.base_value = acValues[char.id];
      updateCharacterAC(char.id, trackedEffects);
      results.acUpdated[char.character_name] = acValues[char.id];
    }

    // Update spell slots if any were detected
    const detectedSlots = spellSlotUsage[char.id];
    if (Object.keys(detectedSlots).length > 0) {
      // Get current spell slots or initialize
      let currentSlots = {};
      try {
        currentSlots = JSON.parse(char.spell_slots || '{}');
      } catch (e) {
        currentSlots = {};
      }

      // Update with detected usage
      for (const level in detectedSlots) {
        if (!currentSlots[level]) {
          // If we detected usage but no slot config exists, estimate max based on typical caster
          const estimatedMax = Math.max(2, detectedSlots[level].used + 1);
          currentSlots[level] = { current: estimatedMax - detectedSlots[level].used, max: estimatedMax };
        } else {
          // Update current based on usage (max - used)
          currentSlots[level].current = Math.max(0, currentSlots[level].max - detectedSlots[level].used);
        }
      }

      db.prepare('UPDATE characters SET spell_slots = ? WHERE id = ?').run(JSON.stringify(currentSlots), char.id);
      results.spellSlotsUpdated[char.character_name] = currentSlots;
      updated = true;
    }
  }

  // Notify clients
  const updatedCharacters = getSessionCharacters(sessionId);
  for (const char of updatedCharacters) {
    io.emit('character_updated', char);
  }

  res.json({ success: true, ...results });
});

// ============================================
// COMBAT TRACKER API ENDPOINTS
// ============================================

// Get active combat for a session
app.get('/api/sessions/:sessionId/combat', checkPassword, (req, res) => {
  const combat = db.prepare('SELECT * FROM combats WHERE session_id = ? AND is_active = 1').get(req.params.sessionId);
  if (combat) {
    combat.combatants = JSON.parse(combat.combatants || '[]');
  }
  res.json({ combat });
});

// Start new combat
app.post('/api/sessions/:sessionId/combat/start', checkPassword, (req, res) => {
  const { name, combatants } = req.body;
  const sessionId = req.params.sessionId;

  // End any existing active combat
  db.prepare('UPDATE combats SET is_active = 0 WHERE session_id = ? AND is_active = 1').run(sessionId);

  // Get characters for the session
  const characters = getSessionCharacters(sessionId);

  // Build combatants list with initiative rolls
  const combatantsList = (combatants || []).map(c => {
    const char = characters.find(ch => ch.id === c.character_id);
    const dexMod = char ? Math.floor((char.dexterity - 10) / 2) : 0;
    const initBonus = char ? (char.initiative_bonus || 0) : 0;
    const initiativeRoll = c.initiative !== undefined ? c.initiative : Math.floor(Math.random() * 20) + 1 + dexMod + initBonus;

    return {
      id: c.id || crypto.randomUUID(),
      character_id: c.character_id || null,
      name: c.name || (char ? char.character_name : 'Unknown'),
      initiative: initiativeRoll,
      hp: c.hp !== undefined ? c.hp : (char ? char.hp : 10),
      max_hp: c.max_hp !== undefined ? c.max_hp : (char ? char.max_hp : 10),
      ac: c.ac !== undefined ? c.ac : (char ? char.ac : 10),
      is_player: c.is_player !== undefined ? c.is_player : !!char,
      is_active: true,
      conditions: c.conditions || [],
      notes: c.notes || ''
    };
  });

  // Sort by initiative (descending)
  combatantsList.sort((a, b) => b.initiative - a.initiative);

  const combatId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO combats (id, session_id, name, combatants, is_active, current_turn, round)
    VALUES (?, ?, ?, ?, 1, 0, 1)
  `).run(combatId, sessionId, name || 'Combat', JSON.stringify(combatantsList));

  const combat = db.prepare('SELECT * FROM combats WHERE id = ?').get(combatId);
  combat.combatants = JSON.parse(combat.combatants);

  io.emit('combat_started', { sessionId, combat });
  res.json({ combat });
});

// Add combatant to existing combat
app.post('/api/sessions/:sessionId/combat/add-combatant', checkPassword, (req, res) => {
  const { name, initiative, hp, max_hp, ac, is_player, character_id } = req.body;
  const combat = db.prepare('SELECT * FROM combats WHERE session_id = ? AND is_active = 1').get(req.params.sessionId);

  if (!combat) {
    return res.status(404).json({ error: 'No active combat' });
  }

  const combatants = JSON.parse(combat.combatants || '[]');

  // If linking to a character, get their stats
  let char = null;
  if (character_id) {
    char = db.prepare('SELECT * FROM characters WHERE id = ?').get(character_id);
  }

  const dexMod = char ? Math.floor((char.dexterity - 10) / 2) : 0;
  const initBonus = char ? (char.initiative_bonus || 0) : 0;
  const initiativeRoll = initiative !== undefined ? initiative : Math.floor(Math.random() * 20) + 1 + dexMod + initBonus;

  const newCombatant = {
    id: crypto.randomUUID(),
    character_id: character_id || null,
    name: name || (char ? char.character_name : 'Unknown'),
    initiative: initiativeRoll,
    hp: hp !== undefined ? hp : (char ? char.hp : 10),
    max_hp: max_hp !== undefined ? max_hp : (char ? char.max_hp : 10),
    ac: ac !== undefined ? ac : (char ? char.ac : 10),
    is_player: is_player !== undefined ? is_player : !!char,
    is_active: true,
    conditions: [],
    notes: ''
  };

  combatants.push(newCombatant);
  combatants.sort((a, b) => b.initiative - a.initiative);

  db.prepare('UPDATE combats SET combatants = ? WHERE id = ?').run(JSON.stringify(combatants), combat.id);

  const updatedCombat = db.prepare('SELECT * FROM combats WHERE id = ?').get(combat.id);
  updatedCombat.combatants = JSON.parse(updatedCombat.combatants);

  io.emit('combat_updated', { sessionId: req.params.sessionId, combat: updatedCombat });
  res.json({ combat: updatedCombat });
});

// Update combatant (HP, conditions, etc.)
app.post('/api/sessions/:sessionId/combat/update-combatant', checkPassword, (req, res) => {
  const { combatant_id, hp, conditions, is_active, notes, initiative } = req.body;
  const combat = db.prepare('SELECT * FROM combats WHERE session_id = ? AND is_active = 1').get(req.params.sessionId);

  if (!combat) {
    return res.status(404).json({ error: 'No active combat' });
  }

  const combatants = JSON.parse(combat.combatants || '[]');
  const idx = combatants.findIndex(c => c.id === combatant_id);

  if (idx === -1) {
    return res.status(404).json({ error: 'Combatant not found' });
  }

  if (hp !== undefined) combatants[idx].hp = hp;
  if (conditions !== undefined) combatants[idx].conditions = conditions;
  if (is_active !== undefined) combatants[idx].is_active = is_active;
  if (notes !== undefined) combatants[idx].notes = notes;
  if (initiative !== undefined) {
    combatants[idx].initiative = initiative;
    combatants.sort((a, b) => b.initiative - a.initiative);
  }

  // Sync HP with character if linked
  if (combatants[idx].character_id && hp !== undefined) {
    db.prepare('UPDATE characters SET hp = ? WHERE id = ?').run(hp, combatants[idx].character_id);
    const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(combatants[idx].character_id);
    io.emit('character_updated', updatedChar);
  }

  db.prepare('UPDATE combats SET combatants = ? WHERE id = ?').run(JSON.stringify(combatants), combat.id);

  const updatedCombat = db.prepare('SELECT * FROM combats WHERE id = ?').get(combat.id);
  updatedCombat.combatants = JSON.parse(updatedCombat.combatants);

  io.emit('combat_updated', { sessionId: req.params.sessionId, combat: updatedCombat });
  res.json({ combat: updatedCombat });
});

// Remove combatant
app.post('/api/sessions/:sessionId/combat/remove-combatant', checkPassword, (req, res) => {
  const { combatant_id } = req.body;
  const combat = db.prepare('SELECT * FROM combats WHERE session_id = ? AND is_active = 1').get(req.params.sessionId);

  if (!combat) {
    return res.status(404).json({ error: 'No active combat' });
  }

  let combatants = JSON.parse(combat.combatants || '[]');
  const currentTurn = combat.current_turn;
  const removedIdx = combatants.findIndex(c => c.id === combatant_id);

  combatants = combatants.filter(c => c.id !== combatant_id);

  // Adjust current turn if needed
  let newCurrentTurn = currentTurn;
  if (removedIdx !== -1 && removedIdx < currentTurn) {
    newCurrentTurn = Math.max(0, currentTurn - 1);
  }
  if (newCurrentTurn >= combatants.length) {
    newCurrentTurn = 0;
  }

  db.prepare('UPDATE combats SET combatants = ?, current_turn = ? WHERE id = ?')
    .run(JSON.stringify(combatants), newCurrentTurn, combat.id);

  const updatedCombat = db.prepare('SELECT * FROM combats WHERE id = ?').get(combat.id);
  updatedCombat.combatants = JSON.parse(updatedCombat.combatants);

  io.emit('combat_updated', { sessionId: req.params.sessionId, combat: updatedCombat });
  res.json({ combat: updatedCombat });
});

// Next turn
app.post('/api/sessions/:sessionId/combat/next-turn', checkPassword, (req, res) => {
  const combat = db.prepare('SELECT * FROM combats WHERE session_id = ? AND is_active = 1').get(req.params.sessionId);

  if (!combat) {
    return res.status(404).json({ error: 'No active combat' });
  }

  const combatants = JSON.parse(combat.combatants || '[]');
  const activeCombatants = combatants.filter(c => c.is_active);

  if (activeCombatants.length === 0) {
    return res.status(400).json({ error: 'No active combatants' });
  }

  let nextTurn = combat.current_turn + 1;
  let newRound = combat.round;

  // Find next active combatant
  while (nextTurn < combatants.length && !combatants[nextTurn].is_active) {
    nextTurn++;
  }

  // If we've gone past the end, start new round
  if (nextTurn >= combatants.length) {
    nextTurn = 0;
    newRound++;
    // Find first active combatant in new round
    while (nextTurn < combatants.length && !combatants[nextTurn].is_active) {
      nextTurn++;
    }
  }

  db.prepare('UPDATE combats SET current_turn = ?, round = ? WHERE id = ?')
    .run(nextTurn, newRound, combat.id);

  const updatedCombat = db.prepare('SELECT * FROM combats WHERE id = ?').get(combat.id);
  updatedCombat.combatants = JSON.parse(updatedCombat.combatants);

  io.emit('combat_updated', { sessionId: req.params.sessionId, combat: updatedCombat });
  res.json({ combat: updatedCombat });
});

// Previous turn
app.post('/api/sessions/:sessionId/combat/prev-turn', checkPassword, (req, res) => {
  const combat = db.prepare('SELECT * FROM combats WHERE session_id = ? AND is_active = 1').get(req.params.sessionId);

  if (!combat) {
    return res.status(404).json({ error: 'No active combat' });
  }

  const combatants = JSON.parse(combat.combatants || '[]');
  let prevTurn = combat.current_turn - 1;
  let newRound = combat.round;

  // Find previous active combatant
  while (prevTurn >= 0 && !combatants[prevTurn].is_active) {
    prevTurn--;
  }

  // If we've gone before the start, go to previous round
  if (prevTurn < 0) {
    if (newRound > 1) {
      newRound--;
      prevTurn = combatants.length - 1;
      // Find last active combatant
      while (prevTurn >= 0 && !combatants[prevTurn].is_active) {
        prevTurn--;
      }
    } else {
      prevTurn = 0; // Can't go before round 1
    }
  }

  db.prepare('UPDATE combats SET current_turn = ?, round = ? WHERE id = ?')
    .run(prevTurn, newRound, combat.id);

  const updatedCombat = db.prepare('SELECT * FROM combats WHERE id = ?').get(combat.id);
  updatedCombat.combatants = JSON.parse(updatedCombat.combatants);

  io.emit('combat_updated', { sessionId: req.params.sessionId, combat: updatedCombat });
  res.json({ combat: updatedCombat });
});

// End combat
app.post('/api/sessions/:sessionId/combat/end', checkPassword, (req, res) => {
  const combat = db.prepare('SELECT * FROM combats WHERE session_id = ? AND is_active = 1').get(req.params.sessionId);

  if (!combat) {
    return res.status(404).json({ error: 'No active combat' });
  }

  db.prepare('UPDATE combats SET is_active = 0 WHERE id = ?').run(combat.id);

  io.emit('combat_ended', { sessionId: req.params.sessionId, combatId: combat.id });
  res.json({ success: true });
});

// Quick damage/heal
app.post('/api/sessions/:sessionId/combat/damage', checkPassword, (req, res) => {
  const { combatant_id, amount } = req.body; // amount: positive = damage, negative = heal
  const combat = db.prepare('SELECT * FROM combats WHERE session_id = ? AND is_active = 1').get(req.params.sessionId);

  if (!combat) {
    return res.status(404).json({ error: 'No active combat' });
  }

  const combatants = JSON.parse(combat.combatants || '[]');
  const idx = combatants.findIndex(c => c.id === combatant_id);

  if (idx === -1) {
    return res.status(404).json({ error: 'Combatant not found' });
  }

  const newHp = Math.max(0, Math.min(combatants[idx].max_hp, combatants[idx].hp - amount));
  combatants[idx].hp = newHp;

  // Auto-mark as inactive if HP reaches 0
  if (newHp === 0) {
    combatants[idx].is_active = false;
  }

  // Sync HP with character if linked
  if (combatants[idx].character_id) {
    db.prepare('UPDATE characters SET hp = ? WHERE id = ?').run(newHp, combatants[idx].character_id);
    const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(combatants[idx].character_id);
    io.emit('character_updated', updatedChar);
  }

  db.prepare('UPDATE combats SET combatants = ? WHERE id = ?').run(JSON.stringify(combatants), combat.id);

  const updatedCombat = db.prepare('SELECT * FROM combats WHERE id = ?').get(combat.id);
  updatedCombat.combatants = JSON.parse(updatedCombat.combatants);

  io.emit('combat_updated', { sessionId: req.params.sessionId, combat: updatedCombat });
  res.json({ combat: updatedCombat });
});

// Roll initiative for all party members
app.post('/api/sessions/:sessionId/combat/roll-party-initiative', checkPassword, (req, res) => {
  const characters = getSessionCharacters(req.params.sessionId);

  const partyInitiatives = characters.map(char => {
    const dexMod = Math.floor((char.dexterity - 10) / 2);
    const initBonus = char.initiative_bonus || 0;
    const roll = Math.floor(Math.random() * 20) + 1;
    const total = roll + dexMod + initBonus;

    return {
      character_id: char.id,
      name: char.character_name,
      roll,
      dexMod,
      initBonus,
      total,
      hp: char.hp,
      max_hp: char.max_hp,
      ac: char.ac || 10,
      is_player: true
    };
  });

  res.json({ initiatives: partyInitiatives });
});

// ============================================
// END COMBAT TRACKER API ENDPOINTS
// ============================================

// AI Processing function
async function processAITurn(sessionId, pendingActions, characters) {
  // Notify all clients that processing has started
  io.emit('turn_processing', { sessionId });

  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);
  const apiConfig = getActiveApiConfig();
  if (!apiConfig || !apiConfig.api_key) {
    throw new Error('No active API configuration. Please add and activate one in Settings.');
  }

  // Get general settings (non-API settings)
  const settings = {};
  db.prepare('SELECT key, value FROM settings').all().forEach(row => settings[row.key] = row.value);

  let fullHistory = JSON.parse(session.full_history || '[]');
  const compactedCount = session.compacted_count || 0;

  // Build character info
  const characterInfo = characters.map(c => {
    // Parse multiclass info
    let classDisplay = `${c.class} ${c.level}`;
    try {
      const classes = JSON.parse(c.classes || '{}');
      if (Object.keys(classes).length > 0) {
        classDisplay = Object.entries(classes).map(([cls, lvl]) => `${cls} ${lvl}`).join(' / ');
      }
    } catch (e) {}

    // Parse AC effects for display
    const acEffects = parseAcEffects(c.ac_effects);
    let acDisplay = `${c.ac || 10} (${acEffects.base_source}: ${acEffects.base_value}`;
    if (acEffects.effects.length > 0) {
      const effectsStr = acEffects.effects.map(e => `${e.name}: +${e.value}`).join(', ');
      acDisplay += ` + ${effectsStr}`;
    }
    acDisplay += ')';

    let info = `${c.character_name} (${c.race} ${classDisplay}, played by ${c.player_name}):\n`;
    info += `  Stats: STR:${c.strength} DEX:${c.dexterity} CON:${c.constitution} INT:${c.intelligence} WIS:${c.wisdom} CHA:${c.charisma}\n`;
    info += `  HP: ${c.hp}/${c.max_hp}, AC: ${acDisplay}`;
    if (c.appearance) info += `\n  Appearance: ${c.appearance}`;
    if (c.backstory) info += `\n  Backstory: ${c.backstory}`;
    if (c.skills) info += `\n  Skills: ${c.skills}`;
    if (c.spells) info += `\n  Spells: ${c.spells}`;
    if (c.passives) info += `\n  Passives: ${c.passives}`;
    if (c.class_features) info += `\n  Class Features: ${c.class_features}`;
    if (c.feats) info += `\n  Feats: ${c.feats}`;
    return info;
  }).join('\n\n');

  // Build action summary for AI
  const actionSummary = pendingActions.map(pa => {
    const char = characters.find(c => c.id === pa.character_id);
    return `${char ? char.character_name : 'Unknown'}: ${pa.action}`;
  }).join('\n');

  // Build the full AI message (includes everything for AI context)
  const aiUserMessage = `
PARTY STATUS:
${characterInfo}

PLAYER ACTIONS THIS TURN:
${actionSummary}

Please narrate the outcome of these actions and describe what happens next.`;

  // Store character context as hidden system context (not shown in UI but sent to AI)
  fullHistory.push({
    role: 'user',
    content: characterInfo,
    type: 'context',
    hidden: true
  });

  // Store each player action as a separate entry for display
  for (const pa of pendingActions) {
    const char = characters.find(c => c.id === pa.character_id);
    if (char) {
      fullHistory.push({
        role: 'user',
        content: pa.action,
        type: 'action',
        character_id: char.id,
        character_name: char.character_name,
        player_name: char.player_name
      });
    }
  }

  // Build messages array for AI - only send messages after compacted_count
  // The summary covers messages 0 to compactedCount-1
  // For AI, we combine the stored entries into proper user/assistant messages
  const recentHistory = fullHistory.slice(compactedCount);

  // Convert stored history to AI-compatible format
  // Combine context + actions into single user messages for AI
  const aiMessages = [];
  let currentUserContent = [];

  for (const entry of recentHistory) {
    if (entry.role === 'assistant') {
      // Flush any pending user content
      if (currentUserContent.length > 0) {
        aiMessages.push({ role: 'user', content: currentUserContent.join('\n\n') });
        currentUserContent = [];
      }
      aiMessages.push({ role: 'assistant', content: entry.content });
    } else if (entry.role === 'user') {
      if (entry.type === 'context') {
        currentUserContent.push(`PARTY STATUS:\n${entry.content}`);
      } else if (entry.type === 'action') {
        currentUserContent.push(`${entry.character_name}: ${entry.content}`);
      } else {
        // Legacy format - use content as-is
        currentUserContent.push(entry.content);
      }
    }
  }

  // Flush remaining user content and add the prompt
  if (currentUserContent.length > 0) {
    currentUserContent.push('Please narrate the outcome of these actions and describe what happens next.');
    aiMessages.push({ role: 'user', content: currentUserContent.join('\n\n') });
  }

  const messages = [
    { role: 'system', content: DEFAULT_SYSTEM_PROMPT + (session.story_summary ? `\n\nSTORY SO FAR:\n${session.story_summary}` : '') },
    ...aiMessages
  ];

  // Call AI API
  const response = await fetch(apiConfig.api_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiConfig.api_key}`
    },
    body: JSON.stringify({
      model: apiConfig.api_model,
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

  fullHistory.push({ role: 'assistant', content: aiResponse, type: 'narration' });

  // Debug: Log AI response to check for tags
  console.log('=== AI Response received ===');
  console.log('Looking for tags in response...');

  // Check what tags exist in the response
  const allTags = aiResponse.match(/\[[A-Z]+:[^\]]+\]/gi);
  console.log('All tags found:', allTags);

  // Parse and award XP from AI response
  // Format: [XP: CharacterName +100, OtherCharacter +50]
  const xpMatches = aiResponse.match(/\[XP:\s*([^\]]+)\]/gi);
  console.log('XP tags found:', xpMatches);
  if (xpMatches) {
    for (const match of xpMatches) {
      const xpAwards = match.replace(/\[XP:\s*/i, '').replace(']', '').split(',');
      for (const award of xpAwards) {
        // Allow optional spaces around the + sign
        const xpMatch = award.trim().match(/(.+?)\s*\+\s*(\d+)/);
        console.log('XP award parse:', award.trim(), '->', xpMatch);
        if (xpMatch) {
          const charName = xpMatch[1].trim();
          const xpAmount = parseInt(xpMatch[2]);
          // Find character by name and update XP
          const char = findCharacterByName(characters, charName);
          if (char) {
            db.prepare('UPDATE characters SET xp = xp + ? WHERE id = ?').run(xpAmount, char.id);
            const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(char.id);
            io.emit('character_updated', updatedChar);
            console.log(`XP Update: ${char.character_name} +${xpAmount} -> ${updatedChar.xp} XP`);
          } else {
            console.log(`XP Update FAILED: Character "${charName}" not found in session`);
          }
        }
      }
    }
  }

  // Parse and award MONEY (or GOLD for backward compatibility) from AI response
  // Format: [MONEY: CharacterName +50, OtherCharacter -25] or [GOLD: CharacterName +50]
  const moneyMatches = aiResponse.match(/\[(MONEY|GOLD):\s*([^\]]+)\]/gi);
  console.log('MONEY/GOLD tags found:', moneyMatches);
  if (moneyMatches) {
    for (const match of moneyMatches) {
      const moneyAwards = match.replace(/\[(MONEY|GOLD):\s*/i, '').replace(']', '').split(',');
      for (const award of moneyAwards) {
        // Allow optional spaces around the operator
        const moneyMatch = award.trim().match(/(.+?)\s*([+-])\s*(\d+)/);
        console.log('Money award parse:', award.trim(), '->', moneyMatch);
        if (moneyMatch) {
          const charName = moneyMatch[1].trim();
          const sign = moneyMatch[2] === '+' ? 1 : -1;
          const moneyAmount = parseInt(moneyMatch[3]) * sign;
          const char = findCharacterByName(characters, charName);
          if (char) {
            const newMoney = Math.max(0, (char.gold || 0) + moneyAmount);
            db.prepare('UPDATE characters SET gold = ? WHERE id = ?').run(newMoney, char.id);
            const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(char.id);
            io.emit('character_updated', updatedChar);
            console.log(`Money update: ${char.character_name} ${sign > 0 ? '+' : ''}${moneyAmount} -> ${newMoney}`);
          } else {
            console.log(`Money Update FAILED: Character "${charName}" not found in session`);
          }
        }
      }
    }
  }

  // Parse and update INVENTORY from AI response
  // Format: [ITEM: CharacterName +Sword of Fire, CharacterName -Health Potion]
  const itemMatches = aiResponse.match(/\[ITEM:([^\]]+)\]/gi);
  if (itemMatches) {
    console.log('Found item tags:', itemMatches);
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

          console.log(`Item ${isAdding ? 'add' : 'remove'}: "${itemName}" x${quantity} for "${charName}"`);

          const char = findCharacterByName(characters, charName);
          if (char) {
            let inventory = [];
            try {
              inventory = JSON.parse(char.inventory || '[]');
            } catch (e) {
              inventory = [];
            }

            if (isAdding) {
              // Check if item already exists (fuzzy match)
              const existingItem = inventory.find(i =>
                i.name.toLowerCase() === itemName.toLowerCase() ||
                i.name.toLowerCase().includes(itemName.toLowerCase()) ||
                itemName.toLowerCase().includes(i.name.toLowerCase())
              );
              if (existingItem) {
                existingItem.quantity = (existingItem.quantity || 1) + quantity;
                console.log(`Updated existing item: ${existingItem.name} -> qty ${existingItem.quantity}`);
              } else {
                inventory.push({ name: itemName, quantity: quantity });
                console.log(`Added new item: ${itemName} x${quantity}`);
              }
            } else {
              // Remove item (fuzzy match)
              const existingIdx = inventory.findIndex(i =>
                i.name.toLowerCase() === itemName.toLowerCase() ||
                i.name.toLowerCase().includes(itemName.toLowerCase()) ||
                itemName.toLowerCase().includes(i.name.toLowerCase())
              );
              if (existingIdx !== -1) {
                const oldQty = inventory[existingIdx].quantity || 1;
                inventory[existingIdx].quantity = oldQty - quantity;
                console.log(`Removed item: ${inventory[existingIdx].name} ${oldQty} -> ${inventory[existingIdx].quantity}`);
                if (inventory[existingIdx].quantity <= 0) {
                  console.log(`Item fully removed: ${inventory[existingIdx].name}`);
                  inventory.splice(existingIdx, 1);
                }
              } else {
                console.log(`Item not found for removal: "${itemName}" in inventory:`, inventory.map(i => i.name));
              }
            }

            db.prepare('UPDATE characters SET inventory = ? WHERE id = ?').run(JSON.stringify(inventory), char.id);
            io.emit('character_updated', { ...char, inventory: JSON.stringify(inventory) });
          } else {
            console.log(`Character not found: "${charName}". Available:`, characters.map(c => c.character_name));
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

          const char = findCharacterByName(characters, charName);
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

  // Parse and update AC EFFECTS from AI response
  // Format: [AC: CharacterName +EffectName +Value Type] or [AC: CharacterName -EffectName] or [AC: CharacterName base ArmorName Value]
  const acMatches = aiResponse.match(/\[AC:([^\]]+)\]/gi);
  if (acMatches) {
    for (const match of acMatches) {
      const acContent = match.replace(/\[AC:/i, '').replace(']', '').trim();

      // Try to match "base" command: CharacterName base ArmorName Value
      const baseMatch = acContent.match(/(.+?)\s+base\s+(.+?)\s+(\d+)$/i);
      if (baseMatch) {
        const charName = baseMatch[1].trim();
        const armorName = baseMatch[2].trim();
        const baseValue = parseInt(baseMatch[3]);

        const char = findCharacterByName(characters, charName);
        if (char) {
          let acEffects = parseAcEffects(char.ac_effects);
          acEffects.base_source = armorName;
          acEffects.base_value = baseValue;
          updateCharacterAC(char.id, acEffects);
          const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(char.id);
          io.emit('character_updated', updatedChar);
        }
        continue;
      }

      // Try to match add effect: CharacterName +EffectName +Value Type
      const addMatch = acContent.match(/(.+?)\s+\+(.+?)\s+\+(\d+)\s+(\w+)$/i);
      if (addMatch) {
        const charName = addMatch[1].trim();
        const effectName = addMatch[2].trim();
        const effectValue = parseInt(addMatch[3]);
        const effectType = addMatch[4].trim().toLowerCase();

        const char = findCharacterByName(characters, charName);
        if (char) {
          let acEffects = parseAcEffects(char.ac_effects);
          // Check if effect already exists, update it if so
          const existingIdx = acEffects.effects.findIndex(e => e.name.toLowerCase() === effectName.toLowerCase());
          if (existingIdx !== -1) {
            acEffects.effects[existingIdx].value = effectValue;
            acEffects.effects[existingIdx].type = effectType;
          } else {
            acEffects.effects.push({
              id: uuidv4(),
              name: effectName,
              value: effectValue,
              type: effectType,
              temporary: effectType === 'spell',
              notes: ''
            });
          }
          updateCharacterAC(char.id, acEffects);
          const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(char.id);
          io.emit('character_updated', updatedChar);
        }
        continue;
      }

      // Try to match remove effect: CharacterName -EffectName
      const removeMatch = acContent.match(/(.+?)\s+-(.+)$/i);
      if (removeMatch) {
        const charName = removeMatch[1].trim();
        const effectName = removeMatch[2].trim();

        const char = findCharacterByName(characters, charName);
        if (char) {
          let acEffects = parseAcEffects(char.ac_effects);
          acEffects.effects = acEffects.effects.filter(e => e.name.toLowerCase() !== effectName.toLowerCase());
          updateCharacterAC(char.id, acEffects);
          const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(char.id);
          io.emit('character_updated', updatedChar);
        }
        continue;
      }
    }
  }

  // Parse and update HP from AI response
  // Format: [HP: CharacterName -10] (damage) or [HP: CharacterName +5] (healing) or [HP: CharacterName =20] (set to specific value)
  const hpMatches = aiResponse.match(/\[HP:\s*([^\]]+)\]/gi);
  console.log('HP tags found:', hpMatches);
  if (hpMatches) {
    for (const match of hpMatches) {
      const hpContent = match.replace(/\[HP:\s*/i, '').replace(']', '').trim();
      console.log('HP content:', hpContent);

      // Match: CharacterName +/-/= Value (with optional spaces around operator)
      const hpMatch = hpContent.match(/(.+?)\s*([+\-=])\s*(\d+)/);
      console.log('HP regex match:', hpMatch);
      if (hpMatch) {
        const charName = hpMatch[1].trim();
        const operator = hpMatch[2];
        const value = parseInt(hpMatch[3]);
        console.log(`HP parsed: char="${charName}", op="${operator}", val=${value}`);

        const char = findCharacterByName(characters, charName);
        if (char) {
          let newHp;
          if (operator === '=') {
            newHp = value;
          } else if (operator === '+') {
            newHp = Math.min((char.hp || 0) + value, char.max_hp || value);
          } else {
            newHp = Math.max((char.hp || 0) - value, 0);
          }

          db.prepare('UPDATE characters SET hp = ? WHERE id = ?').run(newHp, char.id);
          const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(char.id);
          io.emit('character_updated', updatedChar);
          console.log(`HP Update: ${char.character_name} ${operator}${value} -> ${newHp} HP`);
        } else {
          console.log(`HP Update FAILED: Character "${charName}" not found in session`);
        }
      }
    }
  }

  // Parse COMBAT commands from AI response
  // Format: [COMBAT: START CombatName] or [COMBAT: END] or [COMBAT: NEXT] or [COMBAT: PREV]
  const combatMatches = aiResponse.match(/\[COMBAT:([^\]]+)\]/gi);
  if (combatMatches) {
    for (const match of combatMatches) {
      const combatContent = match.replace(/\[COMBAT:/i, '').replace(']', '').trim().toUpperCase();

      if (combatContent.startsWith('START')) {
        const combatName = combatContent.replace('START', '').trim() || 'Combat';
        // Start a new combat
        const combatId = uuidv4();
        const combatants = characters.map(c => ({
          id: c.id,
          name: c.character_name,
          initiative: Math.floor(Math.random() * 20) + 1 + Math.floor(((c.dexterity || 10) - 10) / 2),
          hp: c.hp,
          maxHp: c.max_hp,
          ac: c.ac,
          isPlayer: true
        })).sort((a, b) => b.initiative - a.initiative);

        db.prepare(`INSERT INTO combats (id, session_id, name, combatants, is_active) VALUES (?, ?, ?, ?, 1)`)
          .run(combatId, sessionId, combatName, JSON.stringify(combatants));

        const combat = db.prepare('SELECT * FROM combats WHERE id = ?').get(combatId);
        io.emit('combat_started', { sessionId, combat: { ...combat, combatants: JSON.parse(combat.combatants) } });
        console.log(`Combat started: ${combatName}`);
      } else if (combatContent === 'END') {
        // End active combat
        db.prepare('UPDATE combats SET is_active = 0 WHERE session_id = ? AND is_active = 1').run(sessionId);
        io.emit('combat_ended', { sessionId });
        console.log('Combat ended');
      } else if (combatContent === 'NEXT') {
        // Next turn
        const combat = db.prepare('SELECT * FROM combats WHERE session_id = ? AND is_active = 1').get(sessionId);
        if (combat) {
          const combatants = JSON.parse(combat.combatants || '[]');
          let newTurn = (combat.current_turn + 1) % combatants.length;
          let newRound = combat.round;
          if (newTurn === 0) newRound++;

          db.prepare('UPDATE combats SET current_turn = ?, round = ? WHERE id = ?').run(newTurn, newRound, combat.id);
          const updatedCombat = db.prepare('SELECT * FROM combats WHERE id = ?').get(combat.id);
          io.emit('combat_updated', { sessionId, combat: { ...updatedCombat, combatants: JSON.parse(updatedCombat.combatants) } });
        }
      } else if (combatContent === 'PREV') {
        // Previous turn
        const combat = db.prepare('SELECT * FROM combats WHERE session_id = ? AND is_active = 1').get(sessionId);
        if (combat) {
          const combatants = JSON.parse(combat.combatants || '[]');
          let newTurn = combat.current_turn - 1;
          let newRound = combat.round;
          if (newTurn < 0) {
            newTurn = combatants.length - 1;
            newRound = Math.max(1, newRound - 1);
          }

          db.prepare('UPDATE combats SET current_turn = ?, round = ? WHERE id = ?').run(newTurn, newRound, combat.id);
          const updatedCombat = db.prepare('SELECT * FROM combats WHERE id = ?').get(combat.id);
          io.emit('combat_updated', { sessionId, combat: { ...updatedCombat, combatants: JSON.parse(updatedCombat.combatants) } });
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
    newSummary = await compactHistory(apiConfig, session.story_summary, recentHistoryToCompact);
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
async function compactHistory(apiConfig, existingSummary, history) {
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

  const response = await fetch(apiConfig.api_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiConfig.api_key}`
    },
    body: JSON.stringify({
      model: apiConfig.api_model,
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
