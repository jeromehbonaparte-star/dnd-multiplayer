/**
 * Character Routes
 * Handles all character-related API endpoints
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { validate, validateBody, schemas } = require('../lib/validation');
const { getCached, setCache, invalidateCache } = require('../lib/cache');

/**
 * Create character router with dependencies
 * @param {Object} deps - Dependencies object
 * @param {Object} deps.db - Database instance
 * @param {Object} deps.io - Socket.IO instance
 * @param {Object} deps.auth - Auth middleware {checkPassword, checkAdminPassword}
 * @param {Object} deps.aiService - AI service module
 * @param {Function} deps.getActiveApiConfig - Function to get active API config
 * @returns {express.Router} Configured router
 */
function createCharacterRoutes(deps) {
  const { db, io, auth, aiService, getActiveApiConfig } = deps;
  const router = express.Router();
  const { checkPassword } = auth;
  const { upload } = require('../middleware/upload');
  const fs = require('fs');
  const path = require('path');

  // XP thresholds for each level (D&D 5e)
  const XP_THRESHOLDS = [0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000];

  const STATIC_CLASSES = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../data/srd/classes.json'), 'utf-8')
  );

  const CLASS_FEATURES_L1 = {
    'Barbarian': 'Rage (2/long rest, +2 damage), Unarmored Defense (AC = 10 + DEX + CON)',
    'Bard': 'Bardic Inspiration (d6, CHA mod/long rest), Spellcasting',
    'Cleric': 'Spellcasting, Divine Domain (choose at creation)',
    'Druid': 'Druidic (secret language), Spellcasting',
    'Fighter': 'Fighting Style (choose one), Second Wind (1d10 + 1 HP, 1/short rest)',
    'Monk': 'Unarmored Defense (AC = 10 + DEX + WIS), Martial Arts (d4)',
    'Paladin': 'Divine Sense (1 + CHA mod/long rest), Lay on Hands (5 HP pool)',
    'Ranger': 'Favored Enemy (choose one), Natural Explorer (choose one terrain)',
    'Rogue': 'Expertise (2 skills), Sneak Attack (1d6), Thieves\' Cant',
    'Sorcerer': 'Spellcasting, Sorcerous Origin (choose at creation)',
    'Warlock': 'Otherworldly Patron (choose at creation), Pact Magic',
    'Wizard': 'Spellcasting, Arcane Recovery (1/long rest, recover spell slots on short rest)',
  };

  const RACIAL_TRAITS = {
    'Human': '',
    'High Elf': 'Darkvision (60ft), Keen Senses, Fey Ancestry, Trance, Elf Weapon Training, Cantrip (1 wizard cantrip)',
    'Wood Elf': 'Darkvision (60ft), Keen Senses, Fey Ancestry, Trance, Elf Weapon Training, Fleet of Foot, Mask of the Wild',
    'Dark Elf (Drow)': 'Superior Darkvision (120ft), Keen Senses, Fey Ancestry, Trance, Drow Magic (Dancing Lights), Sunlight Sensitivity',
    'Elf': 'Darkvision (60ft), Keen Senses, Fey Ancestry, Trance',
    'Dwarf': 'Darkvision (60ft), Dwarven Resilience, Dwarven Combat Training, Stonecunning',
    'Halfling': 'Lucky, Brave, Halfling Nimbleness',
    'Dragonborn': 'Draconic Ancestry, Breath Weapon, Damage Resistance',
    'Gnome': 'Darkvision (60ft), Gnome Cunning',
    'Half-Elf': 'Darkvision (60ft), Fey Ancestry, Skill Versatility (2 extra skill proficiencies)',
    'Half-Orc': 'Darkvision (60ft), Menacing, Relentless Endurance, Savage Attacks',
    'Tiefling': 'Darkvision (60ft), Hellish Resistance (fire), Infernal Legacy (Thaumaturgy cantrip)',
  };

  function enrichCharacter(id) {
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
    if (!character) return;

    const calcMod = (score) => Math.floor(((score || 10) - 10) / 2);
    const updates = {};

    // Passives — check skill proficiency for bonus
    const wisMod = calcMod(character.wisdom);
    const intMod = calcMod(character.intelligence);
    const skills = (character.skills || '').toLowerCase();
    const profBonus = 2; // Level 1
    const passivePerception = 10 + wisMod + (skills.includes('perception') ? profBonus : 0);
    const passiveInsight = 10 + wisMod + (skills.includes('insight') ? profBonus : 0);
    const passiveInvestigation = 10 + intMod + (skills.includes('investigation') ? profBonus : 0);
    updates.passives = `Passive Perception: ${passivePerception}, Passive Insight: ${passiveInsight}, Passive Investigation: ${passiveInvestigation}`;

    // AC — class-specific unarmored defense
    const dexMod = calcMod(character.dexterity);
    const conMod = calcMod(character.constitution);
    const className = character.class || '';
    let ac = 10 + dexMod;
    let acSource = 'Unarmored';

    if (className === 'Barbarian') {
      ac = 10 + dexMod + conMod;
      acSource = 'Unarmored Defense (Barbarian)';
    } else if (className === 'Monk') {
      ac = 10 + dexMod + calcMod(character.wisdom);
      acSource = 'Unarmored Defense (Monk)';
    }

    updates.ac = ac;
    updates.ac_effects = JSON.stringify({ base_source: acSource, base_value: ac, effects: [] });

    // HP from class hit die
    const classData = STATIC_CLASSES.find(c => c.name === className);
    const hitDie = classData ? classData.hit_die : 10;
    const hp = hitDie + conMod;
    updates.hp = hp;
    updates.max_hp = hp;

    // Initiative
    updates.initiative_bonus = dexMod;

    // Class features + racial traits
    const classFeatures = CLASS_FEATURES_L1[className] || '';
    const racialTraits = RACIAL_TRAITS[character.race] || '';
    const parts = [];
    if (classFeatures) parts.push(classFeatures);
    if (racialTraits) parts.push(`[Racial] ${racialTraits}`);
    updates.class_features = parts.join('\n');

    // Apply
    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(updates), id];
    db.prepare(`UPDATE characters SET ${setClauses} WHERE id = ?`).run(...values);
  }

  function canLevelUp(xp, currentLevel) {
    if (currentLevel >= 20) return false;
    return xp >= XP_THRESHOLDS[currentLevel];
  }

  function getRequiredXP(currentLevel) {
    return XP_THRESHOLDS[currentLevel] || 999999;
  }

  /**
   * GET /api/characters
   * List all characters
   * Supports optional pagination: ?page=1&limit=20
   * - If no page param: returns flat array (backward compatible)
   * - If page param present: returns { characters, total, page, limit, totalPages }
   */
  router.get('/', checkPassword, (req, res) => {
    const { page, limit } = req.query;

    // If no page param, return all as flat array (backward compatible)
    if (!page) {
      const cacheKey = 'characters:list';
      const cached = getCached(cacheKey);
      if (cached) {
        return res.json(cached);
      }

      const characters = db.prepare('SELECT * FROM characters ORDER BY created_at DESC').all();
      setCache(cacheKey, characters);
      return res.json(characters);
    }

    // Paginated response
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
    const offset = (pageNum - 1) * limitNum;

    const cacheKey = `characters:page:${pageNum}:${limitNum}`;
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const total = db.prepare('SELECT COUNT(*) as count FROM characters').get().count;
    const totalPages = Math.ceil(total / limitNum);
    const characters = db.prepare('SELECT * FROM characters ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limitNum, offset);

    const result = {
      characters,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages
    };
    setCache(cacheKey, result);
    res.json(result);
  });

  /**
   * POST /api/characters
   * Create a new character (supports both simple and full builder payloads)
   */
  router.post('/', checkPassword, (req, res) => {
    const {
      player_name, character_name, race, class: charClass,
      strength, dexterity, constitution, intelligence, wisdom, charisma,
      background, skills, spells, passives, class_features, feats,
      appearance, backstory, gold, inventory, spell_slots, ac, classes
    } = req.body;

    // Validate required fields
    if (!character_name || !race || !charClass) {
      return res.status(400).json({ error: 'character_name, race, and class are required' });
    }

    const id = uuidv4();
    const con = constitution || 10;
    const hp = 10 + Math.floor((con - 10) / 2);

    db.prepare(`INSERT INTO characters (
      id, player_name, character_name, race, class,
      strength, dexterity, constitution, intelligence, wisdom, charisma,
      hp, max_hp, background, skills, spells, passives, class_features, feats,
      appearance, backstory, gold, inventory, spell_slots, ac, classes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id,
      validate.sanitizeString(player_name || 'Player', 100),
      validate.sanitizeString(character_name, 100),
      validate.sanitizeString(race, 50),
      validate.sanitizeString(charClass, 50),
      strength || 10, dexterity || 10, con, intelligence || 10, wisdom || 10, charisma || 10,
      req.body.hp || hp, req.body.max_hp || hp,
      validate.sanitizeString(background || '', 1000),
      skills || '', spells || '', passives || '', class_features || '', feats || '',
      appearance || '', backstory || '',
      gold || 0,
      typeof inventory === 'string' ? inventory : JSON.stringify(inventory || []),
      typeof spell_slots === 'string' ? spell_slots : JSON.stringify(spell_slots || {}),
      ac || 10,
      typeof classes === 'string' ? classes : JSON.stringify(classes || { [charClass]: 1 })
    );

    enrichCharacter(id);
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
    invalidateCache('characters:');
    io.emit('character_created', character);
    res.json(character);
  });

  /**
   * POST /api/characters/ai-assist
   * AI-assisted generation of appearance or backstory text
   * Must be defined BEFORE /:id param routes
   */
  router.post('/ai-assist', checkPassword, async (req, res) => {
    const { field, context } = req.body;
    if (!['appearance', 'backstory'].includes(field)) {
      return res.status(400).json({ error: 'Invalid field. Must be "appearance" or "backstory".' });
    }

    const apiConfig = getActiveApiConfig();
    if (!apiConfig || !apiConfig.api_key) {
      return res.status(400).json({ error: 'No active API configuration. Please add and activate one in Settings.' });
    }

    const prompt = field === 'appearance'
      ? `Generate a vivid physical description (2-3 sentences) for a D&D character: ${context.character_name || 'unnamed'}, a ${context.race || 'human'} ${context.class || 'adventurer'} with the ${context.background || 'folk hero'} background. Include hair, eyes, build, distinguishing features. Be creative and evocative.`
      : `Generate a brief backstory (3-4 sentences) for a D&D character: ${context.character_name || 'unnamed'}, a ${context.race || 'human'} ${context.class || 'adventurer'} with the ${context.background || 'folk hero'} background. Include motivations and a key formative event. Be creative.`;

    try {
      const config = { endpoint: apiConfig.api_endpoint, api_key: apiConfig.api_key, model: apiConfig.api_model };
      const data = await aiService.callAI(config, [
        { role: 'system', content: 'You are a creative D&D character description writer. Write concise, evocative descriptions. Output ONLY the description text, no labels or formatting.' },
        { role: 'user', content: prompt }
      ], { maxTokens: 300 });
      const text = aiService.extractAIMessage(data);
      res.json({ text });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * DELETE /api/characters/:id
   * Delete a character
   */
  router.delete('/:id', checkPassword, (req, res) => {
    db.prepare('DELETE FROM characters WHERE id = ?').run(req.params.id);
    invalidateCache('characters:');
    io.emit('character_deleted', req.params.id);
    res.json({ success: true });
  });

  /**
   * POST /api/characters/:id/xp
   * Award XP to a character
   */
  router.post('/:id/xp', checkPassword, (req, res) => {
    const { amount } = req.body;
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);

    if (!character) {
      return res.status(404).json({ error: 'Character not found' });
    }

    const newXP = (character.xp || 0) + amount;
    db.prepare('UPDATE characters SET xp = ? WHERE id = ?').run(newXP, req.params.id);

    const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
    invalidateCache('characters:');
    io.emit('character_updated', updated);
    res.json(updated);
  });

  /**
   * POST /api/characters/:id/reset-xp
   * Reset XP to 0
   */
  router.post('/:id/reset-xp', checkPassword, (req, res) => {
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);

    if (!character) {
      return res.status(404).json({ error: 'Character not found' });
    }

    db.prepare('UPDATE characters SET xp = 0 WHERE id = ?').run(req.params.id);
    const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
    invalidateCache('characters:');
    io.emit('character_updated', updated);
    res.json(updated);
  });

  /**
   * POST /api/characters/:id/gold
   * Update gold for a character
   */
  router.post('/:id/gold', checkPassword, (req, res) => {
    const { amount } = req.body;
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);

    if (!character) {
      return res.status(404).json({ error: 'Character not found' });
    }

    const newGold = Math.max(0, (character.gold || 0) + amount);
    db.prepare('UPDATE characters SET gold = ? WHERE id = ?').run(newGold, req.params.id);
    const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
    invalidateCache('characters:');
    io.emit('character_updated', updated);
    res.json(updated);
  });

  /**
   * GET /api/characters/:id/inventory
   * Get character inventory
   */
  router.get('/:id/inventory', checkPassword, (req, res) => {
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

  /**
   * POST /api/characters/:id/inventory
   * Update character inventory (add/remove items)
   */
  router.post('/:id/inventory', checkPassword, (req, res) => {
    const { action, item, quantity = 1 } = req.body;
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

    if (action === 'add') {
      const existingIndex = inventory.findIndex(i => i.name.toLowerCase() === item.toLowerCase());
      if (existingIndex >= 0) {
        inventory[existingIndex].quantity = (inventory[existingIndex].quantity || 1) + quantity;
      } else {
        inventory.push({ name: item, quantity });
      }
    } else if (action === 'remove') {
      const existingIndex = inventory.findIndex(i => i.name.toLowerCase() === item.toLowerCase());
      if (existingIndex >= 0) {
        inventory[existingIndex].quantity = Math.max(0, (inventory[existingIndex].quantity || 1) - quantity);
        if (inventory[existingIndex].quantity <= 0) {
          inventory.splice(existingIndex, 1);
        }
      }
    } else if (action === 'set') {
      inventory = Array.isArray(req.body.inventory) ? req.body.inventory : inventory;
    }

    db.prepare('UPDATE characters SET inventory = ? WHERE id = ?').run(JSON.stringify(inventory), req.params.id);
    const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
    invalidateCache('characters:');
    io.emit('character_updated', updated);
    res.json(updated);
  });

  /**
   * POST /api/characters/:id/spell-slots
   * Get/Update spell slots
   */
  router.post('/:id/spell-slots', checkPassword, (req, res) => {
    const { action, level, slots } = req.body;
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

    if (action === 'use' && level && spellSlots[level]) {
      spellSlots[level].current = Math.max(0, spellSlots[level].current - 1);
    } else if (action === 'restore' && level && spellSlots[level]) {
      spellSlots[level].current = Math.min(spellSlots[level].max, spellSlots[level].current + 1);
    } else if (action === 'rest') {
      Object.keys(spellSlots).forEach(lvl => {
        spellSlots[lvl].current = spellSlots[lvl].max;
      });
      // Restore inspiration points on long rest
      db.prepare('UPDATE characters SET inspiration_points = 4 WHERE id = ?').run(req.params.id);
    } else if (action === 'set' && slots) {
      spellSlots = slots;
    }

    db.prepare('UPDATE characters SET spell_slots = ? WHERE id = ?').run(JSON.stringify(spellSlots), req.params.id);
    const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
    invalidateCache('characters:');
    io.emit('character_updated', updated);
    res.json(updated);
  });

  /**
   * POST /api/characters/:id/ac
   * Update AC and AC effects
   */
  router.post('/:id/ac', checkPassword, (req, res) => {
    const { action, ac, base_source, base_value, effect } = req.body;
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);

    if (!character) {
      return res.status(404).json({ error: 'Character not found' });
    }

    let acEffects = { base_source: 'Unarmored', base_value: 10, effects: [] };
    try {
      acEffects = JSON.parse(character.ac_effects || '{}');
      if (!acEffects.effects) acEffects.effects = [];
    } catch (e) {}

    if (action === 'set') {
      db.prepare('UPDATE characters SET ac = ? WHERE id = ?').run(ac, req.params.id);
    } else if (action === 'set_base') {
      acEffects.base_source = base_source;
      acEffects.base_value = base_value;
      const totalAC = acEffects.base_value + acEffects.effects.reduce((sum, e) => sum + (e.value || 0), 0);
      db.prepare('UPDATE characters SET ac = ?, ac_effects = ? WHERE id = ?').run(totalAC, JSON.stringify(acEffects), req.params.id);
    } else if (action === 'add_effect' && effect) {
      effect.id = effect.id || uuidv4();
      acEffects.effects.push(effect);
      const totalAC = acEffects.base_value + acEffects.effects.reduce((sum, e) => sum + (e.value || 0), 0);
      db.prepare('UPDATE characters SET ac = ?, ac_effects = ? WHERE id = ?').run(totalAC, JSON.stringify(acEffects), req.params.id);
    } else if (action === 'remove_effect' && effect && effect.id) {
      acEffects.effects = acEffects.effects.filter(e => e.id !== effect.id);
      const totalAC = acEffects.base_value + acEffects.effects.reduce((sum, e) => sum + (e.value || 0), 0);
      db.prepare('UPDATE characters SET ac = ?, ac_effects = ? WHERE id = ?').run(totalAC, JSON.stringify(acEffects), req.params.id);
    } else if (action === 'clear_temporary') {
      acEffects.effects = acEffects.effects.filter(e => !e.temporary);
      const totalAC = acEffects.base_value + acEffects.effects.reduce((sum, e) => sum + (e.value || 0), 0);
      db.prepare('UPDATE characters SET ac = ?, ac_effects = ? WHERE id = ?').run(totalAC, JSON.stringify(acEffects), req.params.id);
    }

    const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
    invalidateCache('characters:');
    io.emit('character_updated', updated);
    res.json(updated);
  });

  /**
   * POST /api/characters/:id/quick-update
   * Quick update character fields (direct, no AI)
   */
  router.post('/:id/quick-update', checkPassword, (req, res) => {
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
    if (!character) {
      return res.status(404).json({ error: 'Character not found' });
    }

    const allowedFields = [
      'player_name', 'character_name', 'race', 'class', 'level',
      'strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma',
      'hp', 'max_hp', 'ac', 'xp', 'gold',
      'skills', 'spells', 'passives', 'feats', 'class_features',
      'appearance', 'backstory', 'initiative_bonus', 'image_url',
      'inspiration_points'
    ];

    const updates = [];
    const values = [];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(req.body[field]);
      }
    }

    // Handle multiclass updates
    if (req.body.classes !== undefined) {
      updates.push('classes = ?');
      values.push(typeof req.body.classes === 'string' ? req.body.classes : JSON.stringify(req.body.classes));
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    values.push(req.params.id);
    db.prepare(`UPDATE characters SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
    invalidateCache('characters:');
    io.emit('character_updated', updated);
    res.json(updated);
  });

  /**
   * POST /api/characters/:id/image
   * Upload a character image
   */
  router.post('/:id/image', checkPassword, upload.single('image'), (req, res) => {
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
    if (!character) return res.status(404).json({ error: 'Character not found' });
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });

    // Delete old image if exists
    if (character.image_url) {
      const oldPath = path.join(__dirname, '../../data/uploads/characters', path.basename(character.image_url));
      try { fs.unlinkSync(oldPath); } catch (e) { /* ignore */ }
    }

    const imageUrl = `/uploads/characters/${req.file.filename}`;
    db.prepare('UPDATE characters SET image_url = ? WHERE id = ?').run(imageUrl, req.params.id);

    const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
    invalidateCache('characters:');
    io.emit('character_updated', updated);
    res.json(updated);
  });

  /**
   * GET /api/characters/:id/levelinfo
   * Get level up info for a character
   */
  router.get('/:id/levelinfo', checkPassword, (req, res) => {
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);

    if (!character) {
      return res.status(404).json({ error: 'Character not found' });
    }

    // XP thresholds for each level (D&D 5e)
    const xpTable = [0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000];
    const requiredXP = xpTable[character.level] || 999999;
    const canLevel = (character.xp || 0) >= requiredXP && character.level < 20;

    res.json({ canLevel, currentXP: character.xp || 0, requiredXP, level: character.level });
  });

  /**
   * POST /api/characters/:id/reset-level
   * Reset character level to 1
   */
  router.post('/:id/reset-level', checkPassword, async (req, res) => {
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);

    if (!character) {
      return res.status(404).json({ error: 'Character not found' });
    }

    // Reset to level 1 with base stats
    const primaryClass = character.class;
    const newClasses = {};
    newClasses[primaryClass] = 1;

    db.prepare(`
      UPDATE characters SET
        level = 1,
        xp = 0,
        classes = ?,
        feats = '',
        class_features = ''
      WHERE id = ?
    `).run(JSON.stringify(newClasses), req.params.id);

    const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
    invalidateCache('characters:');
    io.emit('character_updated', updated);
    res.json(updated);
  });

  /**
   * POST /api/characters/:id/levelup
   * AI-assisted level up
   */
  router.post('/:id/levelup', checkPassword, async (req, res) => {
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

3. Check if this class level grants new features (check the specific class level, not total level!)

4. ASI/FEAT LEVELS: At class levels 4, 8, 12, 16, 19 in ANY class, offer the choice:
   - Ability Score Improvement: +2 to one stat OR +1 to two stats
   - OR take a FEAT instead

5. For spellcasters, check for new spell slots and spells (based on class level, not total level)

Guide the player through their choices conversationally. When ALL choices are finalized, output:
LEVELUP_COMPLETE:{"hp_increase":N,"class_leveled":"ClassName","new_class_level":N,"new_spells":"spells gained or None","new_skills":"skills gained or None","new_passives":"passives gained or None","new_class_features":"class features gained or None","stat_changes":"any stat increases or None","new_feat":"feat taken or None","summary":"Brief exciting summary"}`;

    try {
      const allMessages = [
        { role: 'system', content: levelUpSystemPrompt },
        ...(messages || [])
      ];

      const aiConfig = { endpoint: apiConfig.api_endpoint, api_key: apiConfig.api_key, model: apiConfig.api_model };
      const data = await aiService.callAI(aiConfig, allMessages, { maxTokens: 4096 });
      const aiMessage = aiService.extractAIMessage(data);

      if (!aiMessage) {
        throw new Error('Could not parse AI response');
      }

      // Check if level up is complete
      if (aiMessage.includes('LEVELUP_COMPLETE:')) {
        let jsonStr = null;
        const startIdx = aiMessage.indexOf('LEVELUP_COMPLETE:') + 'LEVELUP_COMPLETE:'.length;
        const jsonStart = aiMessage.indexOf('{', startIdx);

        if (jsonStart !== -1) {
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
            const newClassFeatures = levelData.new_class_features && levelData.new_class_features !== 'None'
              ? (character.class_features ? `${character.class_features}, ${levelData.new_class_features}` : levelData.new_class_features)
              : character.class_features;
            const newFeats = levelData.new_feat && levelData.new_feat !== 'None'
              ? (character.feats ? `${character.feats}, ${levelData.new_feat}` : levelData.new_feat)
              : character.feats;

            let updatedClasses = {};
            try {
              updatedClasses = JSON.parse(character.classes || '{}');
            } catch (e) {
              updatedClasses = {};
              if (character.class) {
                updatedClasses[character.class] = character.level;
              }
            }

            const classLeveled = levelData.class_leveled || character.class;
            updatedClasses[classLeveled] = (updatedClasses[classLeveled] || 0) + 1;

            const primaryClass = Object.entries(updatedClasses)
              .sort((a, b) => b[1] - a[1])[0][0];

            db.prepare(`
              UPDATE characters SET level = ?, hp = ?, max_hp = ?, spells = ?, skills = ?, passives = ?, class_features = ?, feats = ?, classes = ?, class = ? WHERE id = ?
            `).run(newLevel, newMaxHP, newMaxHP, newSpells || '', newSkills || '', newPassives || '', newClassFeatures || '', newFeats || '', JSON.stringify(updatedClasses), primaryClass, req.params.id);

            const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
            invalidateCache('characters:');
            io.emit('character_updated', updatedChar);
            io.emit('character_leveled_up', { character: updatedChar, summary: levelData.summary });

            const cleanMessage = aiMessage.substring(0, aiMessage.indexOf('LEVELUP_COMPLETE:')).trim();
            return res.json({ message: cleanMessage || 'Level up complete!', complete: true, character: updatedChar, levelUp: levelData });
          } catch (parseError) {
            console.error('Failed to parse level up JSON:', parseError.message);
          }
        }
      }

      res.json({ message: aiMessage, complete: false });
    } catch (error) {
      console.error('Level up error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/characters/:id/edit
   * AI-assisted character editing
   */
  router.post('/:id/edit', checkPassword, async (req, res) => {
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

    const editPrompt = `You are a D&D 5e character editor. Help modify this character.

CHARACTER: ${character.character_name} (${character.race} ${classesDisplay}, Lv${character.level})
Stats: STR ${character.strength}, DEX ${character.dexterity}, CON ${character.constitution}, INT ${character.intelligence}, WIS ${character.wisdom}, CHA ${character.charisma}
HP: ${character.hp}/${character.max_hp}, AC: ${character.ac || 10}, XP: ${character.xp || 0}, Gold: ${character.gold || 0}
Spells: ${character.spells || 'None'} | Skills: ${character.skills || 'None'}
Feats: ${character.feats || 'None'} | Features: ${character.class_features || 'None'}
Appearance: ${character.appearance || 'Not set'} | Backstory: ${character.backstory || 'Not set'}
Spell Slots: ${spellSlotsDisplay} | Classes JSON: ${classesJson}

${editRequest ? `USER REQUEST: ${editRequest}\n` : ''}Discuss changes with the user. When confirmed, output ONLY the CHANGED fields as JSON:
EDIT_COMPLETE:{"field":"new_value"}

Only include fields that changed. Valid fields: character_name, race, class, classes, level, xp, gold, strength, dexterity, constitution, intelligence, wisdom, charisma, hp, max_hp, ac, spell_slots, background, appearance, backstory, spells, skills, passives, class_features, feats.

Example - if only changing spells and HP:
EDIT_COMPLETE:{"spells":"Fireball, Shield, Misty Step","hp":35,"max_hp":35}

IMPORTANT: Output EDIT_COMPLETE: immediately followed by the JSON on ONE line. No code fences, no backticks, no extra formatting around it.`;

    try {
      const allMessages = [
        { role: 'system', content: editPrompt },
        ...(messages || [])
      ];

      const aiConfig = { endpoint: apiConfig.api_endpoint, api_key: apiConfig.api_key, model: apiConfig.api_model };
      const data = await aiService.callAI(aiConfig, allMessages, { maxTokens: 4096 });
      const aiMessage = aiService.extractAIMessage(data);

      if (!aiMessage) {
        throw new Error('Could not parse AI response');
      }

      // Check if edit is complete — try marker first, then fallback to JSON detection
      if (aiMessage.includes('EDIT_COMPLETE:') || aiMessage.includes('"EDIT_COMPLETE"')) {
        let jsonStr = null;
        const startIdx = aiMessage.indexOf('EDIT_COMPLETE:') + 'EDIT_COMPLETE:'.length;
        const jsonStart = aiMessage.indexOf('{', startIdx);

        if (jsonStart !== -1) {
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
            const updates = [];
            const values = [];

            const fields = ['character_name', 'race', 'class', 'level', 'xp', 'gold', 'strength', 'dexterity', 'constitution',
                           'intelligence', 'wisdom', 'charisma', 'hp', 'max_hp', 'ac', 'background',
                           'appearance', 'backstory', 'spells', 'skills', 'passives', 'class_features', 'feats'];

            fields.forEach(field => {
              if (editData[field] !== undefined && editData[field] !== null) {
                updates.push(`${field} = ?`);
                values.push(editData[field]);
              }
            });

            if (editData.spell_slots !== undefined) {
              updates.push('spell_slots = ?');
              values.push(typeof editData.spell_slots === 'string' ? editData.spell_slots : JSON.stringify(editData.spell_slots));
            }

            if (editData.classes !== undefined) {
              updates.push('classes = ?');
              values.push(typeof editData.classes === 'string' ? editData.classes : JSON.stringify(editData.classes));
            }

            if (updates.length > 0) {
              values.push(req.params.id);
              db.prepare(`UPDATE characters SET ${updates.join(', ')} WHERE id = ?`).run(...values);
            }

            const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
            invalidateCache('characters:');
            io.emit('character_updated', updatedChar);

            const markerIdx = aiMessage.indexOf('EDIT_COMPLETE:');
            const cleanMessage = markerIdx >= 0 ? aiMessage.substring(0, markerIdx).trim() : '';
            return res.json({ message: cleanMessage || 'Character updated!', complete: true, character: updatedChar });
          } catch (parseError) {
            console.error('Failed to parse edit JSON:', parseError.message, '\nJSON string:', jsonStr?.substring(0, 200));
          }
        }
      }

      // Fallback: only if the AI clearly intended to save (has confirmation language + JSON)
      if (!aiMessage.includes('EDIT_COMPLETE:')) {
        const hasConfirmation = /(?:updated|saved|applied|confirmed|here(?:'s| is) the|changes? (?:made|applied)|done)/i.test(aiMessage);
        const jsonFallback = hasConfirmation
          ? aiMessage.match(/\{[^{}]*(?:"(?:strength|dexterity|spells|hp|max_hp|skills|class_features|appearance|backstory)"[^{}]*)+\}/)
          : null;
        if (jsonFallback) {
          try {
            const editData = JSON.parse(jsonFallback[0]);
            const updates = [];
            const values = [];
            const fields = ['character_name', 'race', 'class', 'level', 'xp', 'gold', 'strength', 'dexterity', 'constitution',
                           'intelligence', 'wisdom', 'charisma', 'hp', 'max_hp', 'ac', 'background',
                           'appearance', 'backstory', 'spells', 'skills', 'passives', 'class_features', 'feats'];
            fields.forEach(field => {
              if (editData[field] !== undefined && editData[field] !== null) {
                updates.push(`${field} = ?`);
                values.push(editData[field]);
              }
            });
            if (editData.spell_slots !== undefined) {
              updates.push('spell_slots = ?');
              values.push(typeof editData.spell_slots === 'string' ? editData.spell_slots : JSON.stringify(editData.spell_slots));
            }
            if (editData.classes !== undefined) {
              updates.push('classes = ?');
              values.push(typeof editData.classes === 'string' ? editData.classes : JSON.stringify(editData.classes));
            }
            if (updates.length > 0) {
              values.push(req.params.id);
              db.prepare(`UPDATE characters SET ${updates.join(', ')} WHERE id = ?`).run(...values);
              const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
              invalidateCache('characters:');
              io.emit('character_updated', updatedChar);
              console.log('Edit saved via fallback JSON detection');
              return res.json({ message: 'Character updated!', complete: true, character: updatedChar });
            }
          } catch (e) {
            console.error('Fallback JSON parse failed:', e.message);
          }
        }
      }

      res.json({ message: aiMessage, complete: false });
    } catch (error) {
      console.error('Character edit error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/characters/ai-create
   * AI-assisted character creation
   */
  router.post('/ai-create', checkPassword, async (req, res) => {
    const { messages } = req.body;

    const apiConfig = getActiveApiConfig();
    if (!apiConfig || !apiConfig.api_key) {
      return res.status(400).json({ error: 'No active API configuration. Please add and activate one in Settings.' });
    }

    const CHARACTER_CREATION_PROMPT = aiService.CHARACTER_CREATION_PROMPT;

    try {
      const aiConfig = { endpoint: apiConfig.api_endpoint, api_key: apiConfig.api_key, model: apiConfig.api_model };
      const allMessages = [
        { role: 'system', content: CHARACTER_CREATION_PROMPT },
        ...(messages || [])
      ];
      const data = await aiService.callAI(aiConfig, allMessages, { maxTokens: 4096 });
      const aiMessage = aiService.extractAIMessage(data);

      if (!aiMessage) {
        throw new Error('Could not parse AI response');
      }

      // Check if character creation is complete
      if (aiMessage.includes('CHARACTER_COMPLETE:')) {
        let jsonStr = null;
        const startIdx = aiMessage.indexOf('CHARACTER_COMPLETE:') + 'CHARACTER_COMPLETE:'.length;
        const jsonStart = aiMessage.indexOf('{', startIdx);

        if (jsonStart !== -1) {
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
            const charData = JSON.parse(jsonStr);

            const id = uuidv4();
            const hp = 10 + Math.floor((charData.constitution - 10) / 2);
            const classesJson = charData.classes ? JSON.stringify(charData.classes) : JSON.stringify({ [charData.class]: 1 });

            db.prepare(`
              INSERT INTO characters (id, player_name, character_name, race, class, classes, level, strength, dexterity, constitution, intelligence, wisdom, charisma, hp, max_hp, background, appearance, backstory, spells, skills, passives, class_features, feats)
              VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              id,
              charData.player_name,
              charData.character_name,
              charData.race,
              charData.class,
              classesJson,
              charData.strength,
              charData.dexterity,
              charData.constitution,
              charData.intelligence,
              charData.wisdom,
              charData.charisma,
              hp,
              hp,
              charData.background || '',
              charData.appearance || '',
              charData.backstory || '',
              charData.spells || '',
              charData.skills || '',
              charData.passives || '',
              charData.class_features || '',
              charData.feats || ''
            );

            enrichCharacter(id);
            const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
            invalidateCache('characters:');
            io.emit('character_created', character);

            const cleanMessage = aiMessage.substring(0, aiMessage.indexOf('CHARACTER_COMPLETE:')).trim();
            return res.json({ message: cleanMessage || 'Character created!', complete: true, character });
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

  return router;
}

module.exports = { createCharacterRoutes };
