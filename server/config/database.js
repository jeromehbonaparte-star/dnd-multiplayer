/**
 * Database Configuration and Setup
 * Handles SQLite database initialization, migrations, and exports
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
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
  `);

  // Create indexes for better performance
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_pending_actions_session ON pending_actions(session_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_session_characters_session ON session_characters(session_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_combats_session ON combats(session_id)');
  } catch (e) {
    // Indexes may already exist
  }
}

/**
 * Run database migrations for new columns
 */
function runMigrations() {
  const columns = db.prepare("PRAGMA table_info(characters)").all().map(c => c.name);

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
    { col: 'scenario', sql: "ALTER TABLE game_sessions ADD COLUMN scenario TEXT DEFAULT 'classic'" },
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

// Initialize on module load
initializeTables();
runMigrations();
migrateMulticlass();

module.exports = {
  db,
  dbPath,
  initializeTables,
  runMigrations,
};
