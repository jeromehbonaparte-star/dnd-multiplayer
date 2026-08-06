/**
 * Database Configuration and Setup
 * Handles SQLite database initialization, migrations, and exports
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const logger = require('../lib/logger');

// Ensure data directory exists
const dbPath = process.env.DB_PATH || './data/dnd.db';
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Database setup
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
// Enforce FK constraints (required per-connection in SQLite). The CASCADE on
// auth_sessions.user_id is a no-op without this.
db.pragma('foreign_keys = ON');

/**
 * Initialize all database tables
 */
function initializeTables() {
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
      music_state TEXT DEFAULT '{}',
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
      reasoning_effort TEXT DEFAULT '',
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
    );

    CREATE TABLE IF NOT EXISTS game_snapshots (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      character_states TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES game_sessions(id)
    );

    CREATE TABLE IF NOT EXISTS dnd_data_cache (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Create indexes for better performance
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_pending_actions_session ON pending_actions(session_id);
      CREATE INDEX IF NOT EXISTS idx_pending_actions_character ON pending_actions(character_id);
      CREATE INDEX IF NOT EXISTS idx_session_characters_session ON session_characters(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_characters_character ON session_characters(character_id);
      CREATE INDEX IF NOT EXISTS idx_combats_session ON combats(session_id);
      CREATE INDEX IF NOT EXISTS idx_api_configs_active ON api_configs(is_active);
      CREATE INDEX IF NOT EXISTS idx_characters_created ON characters(created_at);
      CREATE INDEX IF NOT EXISTS idx_game_sessions_created ON game_sessions(created_at);
      CREATE INDEX IF NOT EXISTS idx_snapshots_session ON game_snapshots(session_id);
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_characters_user ON characters(user_id);
    `);
  } catch (e) {
    // Indexes may already exist
  }
}

/**
 * Run database migrations for new columns
 */
function runMigrations() {
  const columns = db.prepare("PRAGMA table_info(characters)").all().map(c => c.name);

  const apiConfigColumns = db.prepare("PRAGMA table_info(api_configs)").all().map(c => c.name);
  if (!apiConfigColumns.includes('reasoning_effort')) {
    try {
      db.exec("ALTER TABLE api_configs ADD COLUMN reasoning_effort TEXT DEFAULT ''");
      logger.info('Migration: Added api_configs.reasoning_effort');
    } catch (e) {
      logger.error('Migration failed for api_configs.reasoning_effort:', e.message);
    }
  }

  const migrations = [
    { col: 'xp', sql: 'ALTER TABLE characters ADD COLUMN xp INTEGER DEFAULT 0' },
    { col: 'spells', sql: 'ALTER TABLE characters ADD COLUMN spells TEXT' },
    { col: 'skills', sql: 'ALTER TABLE characters ADD COLUMN skills TEXT' },
    { col: 'passives', sql: 'ALTER TABLE characters ADD COLUMN passives TEXT' },
    { col: 'gold', sql: 'ALTER TABLE characters ADD COLUMN gold INTEGER DEFAULT 0' },
    { col: 'inventory', sql: "ALTER TABLE characters ADD COLUMN inventory TEXT DEFAULT '[]'" },
    { col: 'ac', sql: 'ALTER TABLE characters ADD COLUMN ac INTEGER DEFAULT 10' },
    { col: 'spell_slots', sql: "ALTER TABLE characters ADD COLUMN spell_slots TEXT DEFAULT '{}'" },
    { col: 'feats', sql: "ALTER TABLE characters ADD COLUMN feats TEXT DEFAULT ''" },
    { col: 'classes', sql: "ALTER TABLE characters ADD COLUMN classes TEXT DEFAULT '{}'" },
    { col: 'ac_effects', sql: `ALTER TABLE characters ADD COLUMN ac_effects TEXT DEFAULT '{"base_source":"Unarmored","base_value":10,"effects":[]}'` },
    { col: 'class_features', sql: "ALTER TABLE characters ADD COLUMN class_features TEXT DEFAULT ''" },
    { col: 'appearance', sql: "ALTER TABLE characters ADD COLUMN appearance TEXT DEFAULT ''" },
    { col: 'backstory', sql: "ALTER TABLE characters ADD COLUMN backstory TEXT DEFAULT ''" },
    { col: 'initiative_bonus', sql: "ALTER TABLE characters ADD COLUMN initiative_bonus INTEGER DEFAULT 0" },
    { col: 'image_url', sql: "ALTER TABLE characters ADD COLUMN image_url TEXT DEFAULT ''" },
    { col: 'inspiration_points', sql: 'ALTER TABLE characters ADD COLUMN inspiration_points INTEGER DEFAULT 4' },
    { col: 'user_id', sql: 'ALTER TABLE characters ADD COLUMN user_id TEXT' },
    { col: 'class_choices', sql: "ALTER TABLE characters ADD COLUMN class_choices TEXT DEFAULT '{}'" },
    { col: 'class_resources', sql: "ALTER TABLE characters ADD COLUMN class_resources TEXT DEFAULT '{}'" },
  ];

  for (const { col, sql } of migrations) {
    if (!columns.includes(col)) {
      try {
        db.exec(sql);
        logger.info(`Migration: Added column ${col}`);
      } catch (e) {
        logger.error(`Migration failed for ${col}:`, e.message);
      }
    }
  }

  // Session table migrations
  const sessionColumns = db.prepare("PRAGMA table_info(game_sessions)").all().map(c => c.name);
  const sessionMigrations = [
    { col: 'compacted_count', sql: 'ALTER TABLE game_sessions ADD COLUMN compacted_count INTEGER DEFAULT 0' },
    { col: 'scenario', sql: "ALTER TABLE game_sessions ADD COLUMN scenario TEXT DEFAULT 'classic_fantasy'" },
    { col: 'music_state', sql: "ALTER TABLE game_sessions ADD COLUMN music_state TEXT DEFAULT '{}'" },
  ];

  for (const { col, sql } of sessionMigrations) {
    if (!sessionColumns.includes(col)) {
      try {
        db.exec(sql);
        logger.info(`Migration: Added session column ${col}`);
      } catch (e) {
        logger.error(`Migration failed for session.${col}:`, e.message);
      }
    }
  }
}

/**
 * Migrate existing characters to use multiclass format
 */
function migrateMulticlass() {
  const charsToMigrate = db.prepare("SELECT id, class, level, classes FROM characters WHERE classes = '{}' OR classes IS NULL").all();
  for (const char of charsToMigrate) {
    if (char.class && char.level) {
      const classesObj = {};
      classesObj[char.class] = char.level;
      db.prepare("UPDATE characters SET classes = ? WHERE id = ?").run(JSON.stringify(classesObj), char.id);
    }
  }
  if (charsToMigrate.length > 0) {
    logger.info(`Migrated ${charsToMigrate.length} characters to multiclass format`);
  }
}

/**
 * Migrate existing characters to use ac_effects format
 */
function migrateAcEffects() {
  const charsToMigrateAc = db.prepare("SELECT id, ac, ac_effects FROM characters WHERE ac_effects IS NULL OR ac_effects = '{\"base_source\":\"Unarmored\",\"base_value\":10,\"effects\":[]}'").all();
  for (const char of charsToMigrateAc) {
    const currentAc = char.ac || 10;
    if (currentAc !== 10 || !char.ac_effects) {
      const acEffects = {
        base_source: currentAc > 10 ? "Equipment" : "Unarmored",
        base_value: currentAc,
        effects: []
      };
      db.prepare("UPDATE characters SET ac_effects = ? WHERE id = ?").run(JSON.stringify(acEffects), char.id);
    }
  }
  if (charsToMigrateAc.length > 0) {
    logger.info(`Migrated ${charsToMigrateAc.length} characters to ac_effects format`);
  }
}

/**
 * Migrate equipment text to inventory items
 */
function migrateEquipmentToInventory() {
  const charsWithEquipment = db.prepare("SELECT id, equipment, inventory FROM characters WHERE equipment IS NOT NULL AND equipment != ''").all();
  for (const char of charsWithEquipment) {
    try {
      let inventory = [];
      try {
        inventory = JSON.parse(char.inventory || '[]');
      } catch (e) {
        inventory = [];
      }

      const equipmentText = char.equipment || '';
      const equipmentItems = equipmentText
        .split(/[,\n]/)
        .map(item => item.trim())
        .filter(item => item.length > 0);

      for (const itemName of equipmentItems) {
        let name = itemName;
        let quantity = 1;

        const qtyPrefixMatch = itemName.match(/^(\d+)\s+(.+)$/);
        const qtySuffixMatch = itemName.match(/^(.+?)\s*x(\d+)$/i);

        if (qtyPrefixMatch) {
          quantity = parseInt(qtyPrefixMatch[1]);
          name = qtyPrefixMatch[2];
        } else if (qtySuffixMatch) {
          name = qtySuffixMatch[1].trim();
          quantity = parseInt(qtySuffixMatch[2]);
        }

        const existingItem = inventory.find(i => i.name.toLowerCase() === name.toLowerCase());
        if (existingItem) {
          existingItem.quantity = (existingItem.quantity || 1) + quantity;
        } else {
          inventory.push({ name, quantity });
        }
      }

      db.prepare('UPDATE characters SET inventory = ?, equipment = NULL WHERE id = ?')
        .run(JSON.stringify(inventory), char.id);
    } catch (e) {
      logger.error(`Failed to migrate equipment for character ${char.id}`, { error: e.message });
    }
  }
  if (charsWithEquipment.length > 0) {
    logger.info(`Migrated equipment to inventory for ${charsWithEquipment.length} characters`);
  }
}

/**
 * Repair character rows whose `class` / `classes` keys are free text
 * ("Wild Magic Sorcerer", "sorceror", "fighter") rather than canonical class
 * names. Runs the shared resolution ladder, rewrites the columns and merges any
 * split-off subclass into class_choices. Naturally idempotent: a repaired row
 * resolves exactly on the next boot and produces no updates. Rows that cannot
 * be resolved at all are logged at ERROR and left untouched.
 */
function migrateClassStrings() {
  const { planClassRepair } = require('../services/classProgressionService');
  let rows = [];
  try {
    rows = db.prepare('SELECT id, class, classes, class_choices FROM characters').all();
  } catch (e) {
    logger.error('Class-string repair migration could not read characters', { error: e.message });
    return;
  }

  let repaired = 0;
  let unresolved = 0;
  for (const row of rows) {
    let plan;
    try {
      plan = planClassRepair(row);
    } catch (e) {
      logger.error(`Class-string repair failed for character ${row.id}`, { error: e.message });
      continue;
    }

    if (plan.unresolved.length) {
      unresolved += 1;
      logger.error(`Character ${row.id} has unresolvable class strings; left untouched`, {
        characterId: row.id,
        unresolved: plan.unresolved,
        class: row.class,
        classes: row.classes
      });
    }

    if (!plan.changed) continue;
    const fields = Object.keys(plan.updates);
    try {
      db.prepare(`UPDATE characters SET ${fields.map(field => `${field} = ?`).join(', ')} WHERE id = ?`)
        .run(...fields.map(field => plan.updates[field]), row.id);
    } catch (e) {
      logger.error(`Class-string repair could not write character ${row.id}`, { error: e.message });
      continue;
    }
    repaired += 1;
    logger.info(`Class repair for character ${row.id}`, {
      before: { class: row.class, classes: row.classes, class_choices: row.class_choices },
      after: plan.updates,
      matched: plan.matched
    });
  }

  if (repaired || unresolved) {
    logger.info(`Class-string repair complete: ${repaired} character(s) repaired, ${unresolved} still unresolvable`);
  }
}

/**
 * Seed API config from legacy settings if needed
 */
function seedApiConfig() {
  const existingConfigs = db.prepare('SELECT COUNT(*) as count FROM api_configs').get();
  if (existingConfigs.count === 0) {
    const oldEndpoint = db.prepare("SELECT value FROM settings WHERE key = 'api_endpoint'").get();
    const oldKey = db.prepare("SELECT value FROM settings WHERE key = 'api_key'").get();
    const oldModel = db.prepare("SELECT value FROM settings WHERE key = 'api_model'").get();

    if (oldKey && oldKey.value) {
      db.prepare('INSERT INTO api_configs (id, name, endpoint, api_key, model, is_active) VALUES (?, ?, ?, ?, ?, 1)')
        .run(uuidv4(), 'Default', oldEndpoint?.value || 'https://api.openai.com/v1/chat/completions', oldKey.value, oldModel?.value || 'gpt-4');
      logger.info('Migrated legacy API settings to api_configs table');
    }
  }
}

/**
 * Bootstrap admin user from env vars (ADMIN_USERNAME + ADMIN_PASSWORD).
 * - If both env vars set: upsert the admin user (re-hash password on every boot
 *   so rotation is just change env + redeploy).
 * - If missing and no admin exists yet: create an `admin` user with a generated
 *   password and log it once to console.
 */
function bootstrapAdminUser() {
  const rawUsername = process.env.ADMIN_USERNAME;
  const rawPassword = process.env.ADMIN_PASSWORD;
  // Treat unset, empty, or whitespace-only envs as "not provided" so a misconfigured
  // ADMIN_USERNAME="" doesn't fall through to the generate-random fallback on every boot.
  const username = typeof rawUsername === 'string' ? rawUsername.trim() : '';
  const password = typeof rawPassword === 'string' ? rawPassword : '';

  function generateSecurePassword() {
    return require('crypto').randomBytes(16).toString('hex');
  }

  if (username && password) {
    const existing = db.prepare('SELECT id, is_admin, password_hash FROM users WHERE username = ?').get(username);
    if (existing) {
      // Only accept env credentials for a user that is already flagged as admin.
      // Refuse to silently elevate an existing non-admin via ADMIN_USERNAME collision —
      // that would let anyone with deploy access promote any player by renaming the env.
      if (!existing.is_admin) {
        logger.error(
          `bootstrapAdminUser: refusing to elevate existing non-admin user "${username}". ` +
          `Pick a different ADMIN_USERNAME, or promote the user via the Users admin panel.`
        );
        return;
      }
      // Only rewrite + invalidate sessions when the env password actually changed.
      // (bcrypt is salted, so we can't just compare hashes — use compare against the existing hash.)
      if (!bcrypt.compareSync(password, existing.password_hash)) {
        const hash = bcrypt.hashSync(password, 10);
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, existing.id);
        // Rotate sessions so a revoked admin password can't be used via a lingering cookie.
        db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(existing.id);
        logger.info(`Admin user "${username}" password rotated; existing sessions invalidated`);
      }
    } else {
      const hash = bcrypt.hashSync(password, 10);
      db.prepare('INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, 1)')
        .run(uuidv4(), username, hash);
      logger.info(`Admin user "${username}" created from env vars`);
    }
    return;
  }

  const anyAdmin = db.prepare('SELECT id FROM users WHERE is_admin = 1 LIMIT 1').get();
  if (!anyAdmin) {
    const generated = generateSecurePassword();
    db.prepare('INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, 1)')
      .run(uuidv4(), 'admin', bcrypt.hashSync(generated, 10));
    console.log('\n' + '='.repeat(60));
    console.log('SECURITY: No ADMIN_USERNAME / ADMIN_PASSWORD env vars set.');
    console.log('Generated admin user: admin');
    console.log('Generated password: ' + generated);
    console.log('Set ADMIN_USERNAME and ADMIN_PASSWORD env vars to use custom credentials.');
    console.log('='.repeat(60) + '\n');
  }
}

/**
 * Initialize default non-auth settings.
 */
function initializeSettings() {
  const initSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  initSetting.run('api_endpoint', 'https://api.openai.com/v1/chat/completions');
  initSetting.run('api_key', '');
  initSetting.run('api_model', 'gpt-4');
  initSetting.run('narrator_api_config_id', '');
  initSetting.run('agent_api_config_id', '');
  initSetting.run('pov_api_config_id', '');
  initSetting.run('max_tokens_before_compact', '8000');
  initSetting.run('youtube_dj_enabled', 'false');
  initSetting.run('youtube_api_key', '');
  initSetting.run('pov_image_enabled', 'false');
  initSetting.run('pov_image_auto_enabled', 'false');
  initSetting.run('pov_image_provider', 'openai');
  initSetting.run('pov_image_endpoint', 'https://api.openai.com/v1');
  initSetting.run('pov_image_api_key', '');
  initSetting.run('pov_image_model', 'gpt-image-1');
  initSetting.run('pov_image_style_prompt', 'Cinematic fantasy illustration, grounded detail, dramatic natural lighting, cohesive campaign art direction.');
}

/**
 * Prune expired auth_sessions rows.
 */
function pruneExpiredSessions() {
  try {
    db.prepare('DELETE FROM auth_sessions WHERE expires_at < CURRENT_TIMESTAMP').run();
  } catch (e) {
    // Table may not exist yet on very first boot — safe to ignore
  }
}

// Initialize on module load
initializeTables();
runMigrations();
migrateMulticlass();
migrateAcEffects();
migrateEquipmentToInventory();
migrateClassStrings();
seedApiConfig();
initializeSettings();
bootstrapAdminUser();
pruneExpiredSessions();

module.exports = {
  db,
  dbPath,
  initializeTables,
  runMigrations,
};
