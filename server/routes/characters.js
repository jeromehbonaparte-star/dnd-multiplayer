/**
 * Character Routes
 * Handles all character-related API endpoints
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { validate, validateBody, schemas } = require('../lib/validation');
const { getCached, setCache, invalidateCache } = require('../lib/cache');
const { extractMarkerJson } = require('../lib/markerJson');
const { loadPOVImageSettings, generatePOVSceneImage, saveCharacterAvatar, deleteCharacterAvatar } = require('../services/imageGenerationService');
const { resolveStartingInventory } = require('../services/startingEquipmentService');
const logger = require('../lib/logger');
const {
  ABILITY_NAMES,
  CLASS_RULES,
  FULL_CASTER_SLOTS,
  calculateMulticlassSpellcasterLevel,
  computeSlotState,
  getClassName,
  getClassOptions,
  getExactClassName,
  getProgression,
  getSpellSlots,
  normalizeClassesMap,
  parseClasses,
  planClassRepair,
  resolveClassAndSubclass,
  suggestClassNames
} = require('../services/classProgressionService');

/**
 * Create character router with dependencies
 * @param {Object} deps - Dependencies object
 * @param {Object} deps.db - Database instance
 * @param {Object} deps.io - Socket.IO instance
 * @param {Object} deps.auth - Auth middleware {requireUser, requireAdmin}
 * @param {Object} deps.aiService - AI service module
 * @param {Function} deps.getApiConfigForRole - Function to get agent API config
 * @returns {express.Router} Configured router
 */
function createCharacterRoutes(deps) {
  const { db, io, auth, aiService, getActiveApiConfig, getApiConfigForRole, emitCharacterUpdate } = deps;
  const router = express.Router();
  const { requireUser, requireAdmin } = auth;
  const { upload } = require('../middleware/upload');
  const fs = require('fs');
  const path = require('path');
  const getAgentApiConfig = () => getApiConfigForRole ? getApiConfigForRole('agent') : getActiveApiConfig();

  // Ownership guard: admin bypass, else character.user_id must equal req.user.id.
  // Returns the character on success, or sends a response and returns null.
  function loadOwnedCharacter(req, res) {
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
    if (!character) {
      res.status(404).json({ error: 'Character not found' });
      return null;
    }
    if (!req.user.is_admin && character.user_id !== req.user.id) {
      res.status(403).json({ error: 'You do not own this character' });
      return null;
    }
    return character;
  }

  // ---- Class write boundaries -------------------------------------------
  // Nothing in this router may persist a `class` / `classes` string that the
  // resolution ladder cannot turn into a canonical class name. Player-facing
  // writes reject with 400/409; AI-authored writes drop the offending field.

  /**
   * Merge newly discovered subclasses into a character's class_choices without
   * ever overwriting a choice the player already made.
   * @returns {string|null} JSON string for a `class_choices = ?` update, or null.
   */
  function mergeClassChoices(character, pendingSubclasses) {
    const entries = Object.entries(pendingSubclasses || {}).filter(([, subclass]) => subclass);
    if (!entries.length) return null;
    let choices = {};
    try { choices = JSON.parse(character.class_choices || '{}') || {}; } catch (e) { choices = {}; }
    if (!choices || typeof choices !== 'object' || Array.isArray(choices)) choices = {};
    let changed = false;
    for (const [className, subclass] of entries) {
      if (choices[className] && choices[className].subclass) continue;
      choices[className] = { ...(choices[className] || {}), subclass };
      changed = true;
    }
    return changed ? JSON.stringify(choices) : null;
  }

  /**
   * Persist a planClassRepair() plan and return the patched in-memory row.
   * Legacy rows like class="Wild Magic Sorcerer" heal the first time a level-up
   * endpoint touches them, instead of dead-ending the modal.
   */
  function applyClassRepair(character, plan, context) {
    if (!plan.changed) return character;
    const fields = Object.keys(plan.updates);
    db.prepare(`UPDATE characters SET ${fields.map(field => `${field} = ?`).join(', ')} WHERE id = ?`)
      .run(...fields.map(field => plan.updates[field]), character.id);
    logger.warn(`Repaired unresolved class strings during ${context}`, {
      characterId: character.id,
      before: { class: character.class, classes: character.classes, class_choices: character.class_choices },
      after: plan.updates
    });
    invalidateCache('characters:');
    return { ...character, ...plan.updates };
  }

  /**
   * Level-up entry guard. Repairs ladder-resolvable class strings in place and
   * returns { character, className }; sends 409 unresolved_class and returns
   * null when the class cannot be resolved at all (never silently treats an
   * unresolvable class as a fresh multiclass).
   */
  function resolveCharacterClass(res, character, requestedClass, context) {
    const reject = (unresolvedClass) => {
      logger.warn(`Unresolvable class blocked at ${context}`, { characterId: character.id, unresolvedClass });
      res.status(409).json({
        error: 'unresolved_class',
        unresolvedClass,
        suggestions: suggestClassNames(unresolvedClass)
      });
      return null;
    };

    const plan = planClassRepair(character);
    // Any leftover junk (including a stray `classes` key) is fatal here: dropping
    // it would silently lose class levels, and keeping it would let it reach the
    // `class` column via the primary-class recalculation.
    if (plan.unresolved.length) return reject(plan.unresolved[0]);
    const repaired = applyClassRepair(character, plan, context);

    const storedClasses = normalizeClassesMap(repaired.classes).classes;
    const highestStored = Object.entries(storedClasses).sort((a, b) => b[1] - a[1])[0];
    const effective = String(requestedClass || repaired.class || (highestStored ? highestStored[0] : '')).trim();
    const className = getExactClassName(effective) || resolveClassAndSubclass(effective).className;
    if (!className || !CLASS_RULES[className]) return reject(effective);
    return { character: repaired, className };
  }

  /**
   * Normalize AI-authored class fields onto an update statement. Unresolvable
   * values are dropped with a WARN — never written, never fatal.
   */
  function applyAiClassFields(editData, character, updates, values) {
    const pendingSubclasses = {};

    if (editData.class !== undefined && editData.class !== null && String(editData.class).trim() !== '') {
      const resolved = resolveClassAndSubclass(editData.class);
      if (resolved.className) {
        updates.push('class = ?');
        values.push(resolved.className);
        if (resolved.subclass) pendingSubclasses[resolved.className] = resolved.subclass;
      } else {
        logger.warn('AI editor emitted an unresolvable class; dropping field', {
          characterId: character.id, value: String(editData.class)
        });
      }
    }

    if (editData.classes !== undefined && editData.classes !== null) {
      const normalized = normalizeClassesMap(editData.classes);
      if (normalized.unresolved.length) {
        logger.warn('AI editor emitted unresolvable class keys; dropping them', {
          characterId: character.id, keys: normalized.unresolved
        });
      }
      if (Object.keys(normalized.classes).length) {
        updates.push('classes = ?');
        values.push(JSON.stringify(normalized.classes));
        for (const [className, subclass] of Object.entries(normalized.subclasses)) {
          if (!pendingSubclasses[className]) pendingSubclasses[className] = subclass;
        }
      } else {
        logger.warn('AI editor emitted a classes map with no resolvable keys; dropping field', {
          characterId: character.id
        });
      }
    }

    const choicesJson = mergeClassChoices(character, pendingSubclasses);
    if (choicesJson) {
      updates.push('class_choices = ?');
      values.push(choicesJson);
    }
  }

  // XP thresholds for each level (D&D 5e)
  const XP_THRESHOLDS = [0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000];

  const STATIC_CLASSES = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../data/srd/classes.json'), 'utf-8')
  );

  function normalizeSpellSlots(spellSlots) {
    const normalized = {};
    if (!spellSlots || typeof spellSlots !== 'object') return normalized;

    for (const [level, slot] of Object.entries(spellSlots)) {
      if (!/^\d+$/.test(level)) continue;
      if (!slot || typeof slot !== 'object') continue;
      const max = Math.max(0, Number(slot.max || 0));
      const current = Number.isFinite(slot.current)
        ? Number(slot.current)
        : Math.max(0, max - Number(slot.used || 0));
      normalized[level] = {
        max,
        current: Math.max(0, Math.min(max, current))
      };
    }
    return normalized;
  }

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
    // Legacy rows may still hold free-text classes; resolve before the lookups.
    const className = getClassName(character.class) || character.class || '';
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
  router.get('/', requireUser, (req, res) => {
    const { page, limit } = req.query;
    const isAdmin = !!req.user.is_admin;
    const scope = isAdmin ? 'all' : req.user.id;

    // If no page param, return all as flat array (backward compatible)
    if (!page) {
      const cacheKey = `characters:list:${scope}`;
      const cached = getCached(cacheKey);
      if (cached) {
        return res.json(cached);
      }

      const characters = isAdmin
        ? db.prepare('SELECT * FROM characters ORDER BY created_at DESC').all()
        : db.prepare('SELECT * FROM characters WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
      setCache(cacheKey, characters);
      return res.json(characters);
    }

    // Paginated response
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
    const offset = (pageNum - 1) * limitNum;

    const cacheKey = `characters:page:${scope}:${pageNum}:${limitNum}`;
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const total = isAdmin
      ? db.prepare('SELECT COUNT(*) as count FROM characters').get().count
      : db.prepare('SELECT COUNT(*) as count FROM characters WHERE user_id = ?').get(req.user.id).count;
    const totalPages = Math.ceil(total / limitNum);
    const characters = isAdmin
      ? db.prepare('SELECT * FROM characters ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limitNum, offset)
      : db.prepare('SELECT * FROM characters WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(req.user.id, limitNum, offset);

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
  router.post('/', requireUser, (req, res) => {
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

    // Write boundary: only a ladder-resolvable class may be persisted.
    const resolvedClass = resolveClassAndSubclass(charClass);
    if (!resolvedClass.className) {
      return res.status(400).json({
        error: 'Unknown class',
        input: String(charClass),
        suggestions: suggestClassNames(charClass)
      });
    }
    const canonicalClass = resolvedClass.className;

    const normalizedClasses = normalizeClassesMap(classes);
    if (normalizedClasses.unresolved.length) {
      return res.status(400).json({
        error: 'Unknown class',
        input: normalizedClasses.unresolved[0],
        suggestions: suggestClassNames(normalizedClasses.unresolved[0])
      });
    }
    const classesJson = Object.keys(normalizedClasses.classes).length
      ? JSON.stringify(normalizedClasses.classes)
      : JSON.stringify({ [canonicalClass]: 1 });

    const classChoices = {};
    const requestedSubclass = validate.sanitizeString(req.body.subclass || resolvedClass.subclass || '', 60);
    if (requestedSubclass) classChoices[canonicalClass] = { subclass: requestedSubclass };
    for (const [className, subclass] of Object.entries(normalizedClasses.subclasses)) {
      if (!classChoices[className]) classChoices[className] = { subclass };
    }

    const id = uuidv4();
    const con = constitution || 10;
    const hp = 10 + Math.floor((con - 10) / 2);

    db.prepare(`INSERT INTO characters (
      id, user_id, player_name, character_name, race, class,
      strength, dexterity, constitution, intelligence, wisdom, charisma,
      hp, max_hp, background, skills, spells, passives, class_features, feats,
      appearance, backstory, gold, inventory, spell_slots, ac, classes, class_choices
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id,
      req.user.id,
      validate.sanitizeString(player_name || 'Player', 100),
      validate.sanitizeString(character_name, 100),
      validate.sanitizeString(race, 50),
      canonicalClass,
      strength || 10, dexterity || 10, con, intelligence || 10, wisdom || 10, charisma || 10,
      req.body.hp || hp, req.body.max_hp || hp,
      validate.sanitizeString(background || '', 1000),
      skills || '', spells || '', passives || '', class_features || '', feats || '',
      appearance || '', backstory || '',
      gold || 0,
      JSON.stringify(resolveStartingInventory(canonicalClass, inventory)),
      typeof spell_slots === 'string' ? spell_slots : JSON.stringify(spell_slots || {}),
      ac || 10,
      classesJson,
      JSON.stringify(classChoices)
    );

    enrichCharacter(id);
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
    invalidateCache('characters:');
    emitCharacterUpdate(character.id, 'character_created', character);
    res.json(character);
  });

  /**
   * POST /api/characters/ai-assist
   * AI-assisted generation of appearance or backstory text
   * Must be defined BEFORE /:id param routes
   */
  router.post('/ai-assist', requireUser, async (req, res) => {
    const { field, context } = req.body;
    if (!['appearance', 'backstory'].includes(field)) {
      return res.status(400).json({ error: 'Invalid field. Must be "appearance" or "backstory".' });
    }

    const apiConfig = getAgentApiConfig();
    if (!apiConfig || !apiConfig.api_key) {
      return res.status(400).json({ error: 'No active API configuration. Please add and activate one in Settings.' });
    }

    const prompt = field === 'appearance'
      ? `Generate a vivid physical description (2-3 sentences) for a D&D character: ${context.character_name || 'unnamed'}, a ${context.race || 'human'} ${context.class || 'adventurer'} with the ${context.background || 'folk hero'} background. Include hair, eyes, build, distinguishing features. Be creative and evocative.`
      : `Generate a brief backstory (3-4 sentences) for a D&D character: ${context.character_name || 'unnamed'}, a ${context.race || 'human'} ${context.class || 'adventurer'} with the ${context.background || 'folk hero'} background. Include motivations and a key formative event. Be creative.`;

    try {
      const config = apiConfig;
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
  router.delete('/:id', requireAdmin, (req, res) => {
    // Resolve recipients (owner + sessions + admins) while the row still exists,
    // then delete. Clients refetch on the event, which lands after this sync delete.
    emitCharacterUpdate(req.params.id, 'character_deleted', req.params.id);
    db.prepare('DELETE FROM characters WHERE id = ?').run(req.params.id);
    invalidateCache('characters:');
    res.json({ success: true });
  });

  /**
   * POST /api/characters/:id/xp
   * Award XP to a character
   */
  router.post('/:id/xp', requireUser, (req, res) => {
    const { amount } = req.body;
    const character = loadOwnedCharacter(req, res);
    if (!character) return;

    const newXP = (character.xp || 0) + amount;
    db.prepare('UPDATE characters SET xp = ? WHERE id = ?').run(newXP, req.params.id);

    const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
    invalidateCache('characters:');
    emitCharacterUpdate(updated.id, 'character_updated', updated);
    res.json(updated);
  });

  /**
   * POST /api/characters/:id/reset-xp
   * Reset XP to 0
   */
  router.post('/:id/reset-xp', requireUser, (req, res) => {
    const character = loadOwnedCharacter(req, res);
    if (!character) return;

    db.prepare('UPDATE characters SET xp = 0 WHERE id = ?').run(req.params.id);
    const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
    invalidateCache('characters:');
    emitCharacterUpdate(updated.id, 'character_updated', updated);
    res.json(updated);
  });

  /**
   * POST /api/characters/:id/gold
   * Update gold for a character
   */
  router.post('/:id/gold', requireUser, (req, res) => {
    const { amount } = req.body;
    const character = loadOwnedCharacter(req, res);
    if (!character) return;

    const newGold = Math.max(0, (character.gold || 0) + amount);
    db.prepare('UPDATE characters SET gold = ? WHERE id = ?').run(newGold, req.params.id);
    const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
    invalidateCache('characters:');
    emitCharacterUpdate(updated.id, 'character_updated', updated);
    res.json(updated);
  });

  /**
   * GET /api/characters/:id/inventory
   * Get character inventory
   */
  router.get('/:id/inventory', requireUser, (req, res) => {
    const character = loadOwnedCharacter(req, res);
    if (!character) return;

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
  router.post('/:id/inventory', requireUser, (req, res) => {
    const { action, item, quantity = 1 } = req.body;
    const character = loadOwnedCharacter(req, res);
    if (!character) return;

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
    emitCharacterUpdate(updated.id, 'character_updated', updated);
    res.json(updated);
  });

  /**
   * POST /api/characters/:id/spell-slots
   * Get/Update spell slots
   */
  router.post('/:id/spell-slots', requireUser, (req, res) => {
    const { action, level, slots } = req.body;
    const character = loadOwnedCharacter(req, res);
    if (!character) return;

    let spellSlots = {};
    try {
      spellSlots = JSON.parse(character.spell_slots || '{}');
    } catch (e) {
      spellSlots = {};
    }
    spellSlots = normalizeSpellSlots(spellSlots);

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
      spellSlots = normalizeSpellSlots(slots);
    }

    db.prepare('UPDATE characters SET spell_slots = ? WHERE id = ?').run(JSON.stringify(spellSlots), req.params.id);
    const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
    invalidateCache('characters:');
    emitCharacterUpdate(updated.id, 'character_updated', updated);
    res.json(updated);
  });

  /**
   * POST /api/characters/:id/ac
   * Update AC and AC effects
   */
  router.post('/:id/ac', requireUser, (req, res) => {
    const { action, ac, base_source, base_value, effect } = req.body;
    const character = loadOwnedCharacter(req, res);
    if (!character) return;

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
    emitCharacterUpdate(updated.id, 'character_updated', updated);
    res.json(updated);
  });

  /**
   * POST /api/characters/:id/quick-update
   * Quick update character fields (direct, no AI)
   */
  router.post('/:id/quick-update', requireUser, (req, res) => {
    const character = loadOwnedCharacter(req, res);
    if (!character) return;

    const allowedFields = [
      'player_name', 'character_name', 'race', 'class', 'level', 'background',
      'strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma',
      'hp', 'max_hp', 'ac', 'xp', 'gold', 'spell_slots',
      'skills', 'spells', 'passives', 'feats', 'class_features',
      'appearance', 'backstory', 'initiative_bonus', 'image_url',
      'inspiration_points'
    ];

    const updates = [];
    const values = [];
    const pendingSubclasses = {};

    for (const field of allowedFields) {
      if (req.body[field] === undefined) continue;
      let value = req.body[field];

      if (field === 'class') {
        // Write boundary: canonicalize, split off any subclass, reject junk.
        const resolved = resolveClassAndSubclass(value);
        if (!resolved.className) {
          return res.status(400).json({
            error: 'Unknown class',
            input: String(value),
            suggestions: suggestClassNames(value)
          });
        }
        value = resolved.className;
        if (resolved.subclass) pendingSubclasses[resolved.className] = resolved.subclass;
      }

      if (field === 'spell_slots') {
        let parsed;
        if (typeof value === 'string') {
          const trimmed = value.trim();
          if (trimmed === '') {
            parsed = {};
          } else {
            try {
              parsed = JSON.parse(trimmed);
            } catch (e) {
              return res.status(400).json({ error: 'spell_slots must be valid JSON' });
            }
          }
        } else if (value && typeof value === 'object') {
          parsed = value;
        } else {
          return res.status(400).json({ error: 'spell_slots must be an object or JSON string' });
        }
        if (Array.isArray(parsed) || !parsed || typeof parsed !== 'object') {
          return res.status(400).json({ error: 'spell_slots must be a JSON object keyed by slot level' });
        }
        value = JSON.stringify(normalizeSpellSlots(parsed));
      }

      updates.push(`${field} = ?`);
      values.push(value);
    }

    // Handle multiclass updates — keys are normalized through the ladder
    if (req.body.classes !== undefined) {
      const normalized = normalizeClassesMap(req.body.classes);
      if (normalized.unresolved.length) {
        return res.status(400).json({
          error: 'Unknown class',
          input: normalized.unresolved[0],
          suggestions: suggestClassNames(normalized.unresolved[0])
        });
      }
      updates.push('classes = ?');
      values.push(JSON.stringify(normalized.classes));
      for (const [className, subclass] of Object.entries(normalized.subclasses)) {
        if (!pendingSubclasses[className]) pendingSubclasses[className] = subclass;
      }
    }

    const choicesJson = mergeClassChoices(character, pendingSubclasses);
    if (choicesJson) {
      updates.push('class_choices = ?');
      values.push(choicesJson);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    values.push(req.params.id);
    db.prepare(`UPDATE characters SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
    invalidateCache('characters:');
    emitCharacterUpdate(updated.id, 'character_updated', updated);
    res.json(updated);
  });

  /**
   * POST /api/characters/:id/image
   * Upload a character image
   */
  router.post('/:id/image', requireUser, upload.single('image'), (req, res) => {
    const character = loadOwnedCharacter(req, res);
    if (!character) return;
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
    emitCharacterUpdate(updated.id, 'character_updated', updated);
    res.json(updated);
  });

  /**
   * GET /api/characters/:id/levelinfo
   * Get level up info for a character
   */
  router.get('/:id/levelinfo', requireUser, (req, res) => {
    const loaded = loadOwnedCharacter(req, res);
    if (!loaded) return;

    // Repair ladder-resolvable class strings on the spot; 409 when hopeless so
    // the modal can render a repair widget instead of dead-ending on a null
    // nextProgression served as HTTP 200.
    const resolved = resolveCharacterClass(res, loaded, req.query.class, 'levelinfo');
    if (!resolved) return;
    const character = resolved.character;

    const requiredXP = getRequiredXP(character.level);
    const canLevel = (character.xp || 0) >= requiredXP && character.level < 20;
    const currentClasses = parseClasses(character.classes, character.class, character.level);
    const currentClass = resolved.className;
    const currentClassLevel = currentClasses[currentClass] || 0;
    const nextProgression = getProgression(currentClass, Math.min(20, currentClassLevel + 1));

    let classChoices = {};
    try { classChoices = JSON.parse(character.class_choices || '{}') || {}; } catch (e) { classChoices = {}; }

    res.json({
      canLevel,
      currentXP: character.xp || 0,
      requiredXP,
      level: character.level,
      nextLevel: character.level + 1,
      classOptions: getClassOptions(character),
      currentClass,
      currentClassLevel,
      currentSubclass: (classChoices[currentClass] || {}).subclass || null,
      nextProgression
    });
  });

  /**
   * POST /api/characters/:id/reset-level
   * Reset character level to 1
   */
  router.post('/:id/reset-level', requireAdmin, async (req, res) => {
    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);

    if (!character) {
      return res.status(404).json({ error: 'Character not found' });
    }

    // Reset to level 1 with base stats (canonical class key only)
    const primaryClass = getClassName(character.class) || character.class;
    const newClasses = {};
    if (primaryClass) newClasses[primaryClass] = 1;

    db.prepare(`
      UPDATE characters SET
        level = 1,
        xp = 0,
        classes = ?,
        feats = '',
        class_features = '',
        class_choices = '{}',
        class_resources = '{}'
      WHERE id = ?
    `).run(JSON.stringify(newClasses), req.params.id);

    enrichCharacter(req.params.id);

    const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
    invalidateCache('characters:');
    emitCharacterUpdate(updated.id, 'character_updated', updated);
    res.json(updated);
  });

  /**
   * POST /api/characters/:id/levelup
   * Apply a rules-validated 2014/5e level up. AI is not involved in mechanics.
   */
  router.post('/:id/levelup', requireUser, (req, res) => {
    const loaded = loadOwnedCharacter(req, res);
    if (!loaded) return;
    if (!canLevelUp(loaded.xp || 0, loaded.level)) {
      return res.status(400).json({ error: 'Not enough XP to level up', currentXP: loaded.xp || 0, requiredXP: getRequiredXP(loaded.level) });
    }

    const choices = req.body.choices;
    if (!choices || typeof choices !== 'object' || Array.isArray(choices)) {
      return res.status(400).json({ error: 'Level-up choices are required. Open the structured level-up form and choose the available options.' });
    }

    // Entry guard: repair the stored class first so an unresolvable current
    // class can never be mistaken for a fresh multiclass.
    const currentResolved = resolveCharacterClass(res, loaded, null, 'levelup');
    if (!currentResolved) return;
    const character = currentResolved.character;

    const requestedClass = choices.class_name || choices.className;
    const className = requestedClass ? getClassName(requestedClass) : currentResolved.className;
    if (!className || !CLASS_RULES[className]) return res.status(400).json({ error: 'Choose a valid class.' });

    const currentClasses = parseClasses(character.classes, character.class, character.level);
    const currentClassLevel = currentClasses[className] || 0;
    const isMulticlass = currentClassLevel === 0;
    const classOption = getClassOptions(character).find(option => option.name === className);
    if (isMulticlass && !classOption?.available) {
      return res.status(400).json({ error: `Multiclassing into ${className} requires the listed ability scores.` });
    }

    const classLevel = currentClassLevel + 1;
    const progression = getProgression(className, classLevel);
    if (!progression) return res.status(400).json({ error: 'That class is already at level 20.' });

    const abilityIncreases = choices.ability_increases || choices.abilityIncreases || {};
    const feat = String(choices.feat || '').trim();
    const increaseTotal = ABILITY_NAMES.reduce((sum, ability) => sum + Number(abilityIncreases[ability] || 0), 0);
    if (progression.asi) {
      if (feat && increaseTotal) return res.status(400).json({ error: 'Choose an Ability Score Improvement or a feat, not both.' });
      if (!feat && increaseTotal !== 2) return res.status(400).json({ error: 'An Ability Score Improvement must total exactly +2.' });
      if (feat && (feat.length < 2 || feat.length > 120)) return res.status(400).json({ error: 'Enter a valid feat name.' });
      for (const ability of ABILITY_NAMES) {
        const amount = Number(abilityIncreases[ability] || 0);
        if (!Number.isInteger(amount) || amount < 0 || amount > 2 || Number(character[ability] || 0) + amount > 20) {
          return res.status(400).json({ error: `${ability} cannot receive that increase.` });
        }
      }
    } else if (increaseTotal || feat) {
      return res.status(400).json({ error: 'This class level does not grant an Ability Score Improvement or feat.' });
    }

    let classChoices = {};
    try { classChoices = JSON.parse(character.class_choices || '{}'); } catch (e) { classChoices = {}; }
    const subclass = String(choices.subclass || '').trim();
    const existingSubclass = classChoices[className]?.subclass;
    const subclassWasAlreadyDue = CLASS_RULES[className].subclassLevels.some(level => level <= currentClassLevel);
    if (progression.subclass && subclass) classChoices[className] = { ...(classChoices[className] || {}), subclass };
    if (progression.subclass && !subclass && !existingSubclass && !subclassWasAlreadyDue) {
      return res.status(400).json({ error: `${className} requires a subclass choice at this level.` });
    }

    const newSpells = Array.isArray(choices.spells)
      ? choices.spells.map(spell => String(spell).trim()).filter(Boolean).slice(0, 20)
      : String(choices.spells || '').split(/[,\n]/).map(spell => spell.trim()).filter(Boolean).slice(0, 20);
    const existingSpells = String(character.spells || '').split(/[,\n]/).map(spell => spell.trim()).filter(Boolean);
    const spellList = [...new Set([...existingSpells, ...newSpells])];
    const updatedClasses = { ...currentClasses, [className]: classLevel };
    const primaryClass = Object.entries(updatedClasses).sort((a, b) => b[1] - a[1])[0][0];
    const conMod = Math.floor((Number(character.constitution || 10) - 10) / 2);
    const hpIncrease = Math.max(1, Math.floor(progression.hitDie / 2) + 1 + conMod);
    const oldMaxHP = Number(character.max_hp || character.hp || 0);
    const newMaxHP = oldMaxHP + hpIncrease;
    const newHP = Math.min(newMaxHP, Math.max(0, Number(character.hp || oldMaxHP)) + hpIncrease);
    const statValues = Object.fromEntries(ABILITY_NAMES.map(ability => [ability, Number(character[ability] || 10) + Number(abilityIncreases[ability] || 0)]));
    const casterLevel = calculateMulticlassSpellcasterLevel(updatedClasses);
    const hasRegularCaster = casterLevel > 0;
    const slots = hasRegularCaster ? FULL_CASTER_SLOTS[Math.min(20, casterLevel)] || [] : getSpellSlots(className, classLevel);
    let existingSlots = {};
    try { existingSlots = JSON.parse(character.spell_slots || '{}'); } catch (e) { existingSlots = {}; }
    // Floor guard: a level-up may never shrink stored slot capacity.
    const slotState = computeSlotState(slots, existingSlots);
    const spellSlots = slotState.state;
    let slotWarning = null;
    if (slotState.flooredLevels.length) {
      slotWarning = `Kept existing spell slot capacity at level ${slotState.flooredLevels.join(', ')}; the computed progression would have reduced it.`;
      logger.warn('Level-up slot floor applied', {
        characterId: character.id,
        className,
        classLevel,
        flooredLevels: slotState.flooredLevels
      });
    }
    let classResources = {};
    try { classResources = JSON.parse(character.class_resources || '{}'); } catch (e) { classResources = {}; }
    classResources[className] = { level: classLevel, features: progression.features, spell_slots: progression.spellSlots, resources: progression.resources, proficiency_bonus: progression.proficiencyBonus };
    const featureEntries = progression.features.map(feature => `[${className} ${classLevel}] ${feature}`);
    if (subclass) featureEntries.push(`[${className} choice] ${subclass}`);
    if (feat) featureEntries.push(`[${className} ${classLevel}] Feat: ${feat}`);
    const existingFeatures = String(character.class_features || '').trim();
    const newFeatures = [existingFeatures, ...featureEntries].filter(Boolean).join('\n');
    const newFeats = feat ? [String(character.feats || '').trim(), feat].filter(Boolean).join(', ') : (character.feats || '');
    const updates = {
      level: character.level + 1,
      class: primaryClass,
      classes: JSON.stringify(updatedClasses),
      class_choices: JSON.stringify(classChoices),
      class_resources: JSON.stringify(classResources),
      hp: newHP,
      max_hp: newMaxHP,
      spells: spellList.join(', '),
      spell_slots: JSON.stringify(spellSlots),
      class_features: newFeatures,
      feats: newFeats,
      ...statValues
    };
    const setClauses = Object.keys(updates).map(field => `${field} = ?`).join(', ');
    const updateResult = db.prepare(`UPDATE characters SET ${setClauses} WHERE id = ? AND level = ?`).run(...Object.values(updates), req.params.id, character.level);
    if (updateResult.changes !== 1) {
      return res.status(409).json({ error: 'This character was updated by another player. Refresh and review the current level.' });
    }

    const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
    invalidateCache('characters:');
    emitCharacterUpdate(updatedChar.id, 'character_updated', updatedChar);
    emitCharacterUpdate(updatedChar.id, 'character_leveled_up', { character: updatedChar, summary: `Level ${updatedChar.level} reached in ${className}.` });
    return res.json({
      message: `Level ${updatedChar.level} complete. ${className} gained ${featureEntries.join(', ') || 'no new named features'}; HP increased by ${hpIncrease}.`,
      complete: true,
      character: updatedChar,
      ...(slotWarning ? { slotWarning } : {}),
      levelUp: { class_leveled: className, new_class_level: classLevel, hp_increase: hpIncrease, features: progression.features, spell_slots: spellSlots }
    });
  });

  /**
   * POST /api/characters/:id/generate-avatar
   * Generate and persist an avatar using the admin-configured image provider.
   */
  router.post('/:id/generate-avatar', requireUser, async (req, res) => {
    const character = loadOwnedCharacter(req, res);
    if (!character) return;
    const settings = loadPOVImageSettings(db);
    if (settings.pov_image_enabled !== 'true') return res.status(400).json({ error: 'Image generation is disabled in Admin Settings.' });
    if (!settings.pov_image_endpoint || !settings.pov_image_api_key || !settings.pov_image_model) {
      return res.status(400).json({ error: 'Image generation is not fully configured in Admin Settings.' });
    }

    const prompt = [
      'Create a character avatar portrait for a Dungeons & Dragons campaign.',
      `Character: ${character.character_name}.`,
      `Ancestry: ${character.race || 'fantasy humanoid'}.`,
      `Class: ${character.class || 'adventurer'}.`,
      character.appearance ? `Appearance: ${String(character.appearance).slice(0, 1000)}.` : '',
      character.background ? `Background: ${String(character.background).slice(0, 300)}.` : '',
      character.backstory ? `Story clues: ${String(character.backstory).slice(0, 1000)}.` : '',
      settings.pov_image_style_prompt ? `Art direction: ${String(settings.pov_image_style_prompt).slice(0, 1000)}.` : '',
      'Square half-body or bust portrait, face clearly visible and centered in the upper half, expressive eyes, readable silhouette, character-focused composition, no text, no logos, no watermark, no UI.'
    ].filter(Boolean).join(' ');

    let generatedUrl = null;
    try {
      const image = await generatePOVSceneImage({
        provider: settings.pov_image_provider,
        endpoint: settings.pov_image_endpoint,
        apiKey: settings.pov_image_api_key,
        model: settings.pov_image_model,
        size: '1024x1024'
      }, prompt);
      generatedUrl = saveCharacterAvatar(image, character.id);
      db.prepare('UPDATE characters SET image_url = ? WHERE id = ?').run(generatedUrl, character.id);
      if (character.image_url) deleteCharacterAvatar(character.image_url);
      const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(character.id);
      invalidateCache('characters:');
      emitCharacterUpdate(updated.id, 'character_updated', updated);
      res.json({ character: updated, image_url: generatedUrl });
    } catch (error) {
      if (generatedUrl) deleteCharacterAvatar(generatedUrl);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/characters/:id/levelup-ai-legacy
   * Retained for old clients only; the normal level-up endpoint is deterministic.
   */
  router.post('/:id/levelup-ai-legacy', requireUser, async (req, res) => {
    const { messages } = req.body;
    const character = loadOwnedCharacter(req, res);
    if (!character) return;

    if (!canLevelUp(character.xp || 0, character.level)) {
      return res.status(400).json({
        error: 'Not enough XP to level up',
        currentXP: character.xp || 0,
        requiredXP: getRequiredXP(character.level)
      });
    }

    const apiConfig = getAgentApiConfig();
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

      const aiConfig = apiConfig;
      const data = await aiService.callAI(aiConfig, allMessages, { maxTokens: 4096 });
      const aiMessage = aiService.extractAIMessage(data);

      if (!aiMessage) {
        throw new Error('Could not parse AI response');
      }

      // Check if level up is complete
      if (aiMessage.includes('LEVELUP_COMPLETE:')) {
        const jsonStr = extractMarkerJson(aiMessage, 'LEVELUP_COMPLETE:');

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

            // Class keys are AI-authored: normalize through the ladder and
            // refuse to persist anything unresolvable.
            const normalizedExisting = normalizeClassesMap(character.classes);
            const canonicalCurrent = getClassName(character.class);
            const updatedClasses = { ...normalizedExisting.classes };
            if (normalizedExisting.unresolved.length) {
              logger.warn('Legacy AI level-up found unresolvable stored class keys; dropping them', {
                characterId: character.id, keys: normalizedExisting.unresolved
              });
            }
            if (!Object.keys(updatedClasses).length && canonicalCurrent) {
              updatedClasses[canonicalCurrent] = character.level;
            }

            const classLeveled = getClassName(levelData.class_leveled) || canonicalCurrent;
            if (!classLeveled) {
              const unresolvedClass = String(levelData.class_leveled || character.class || '');
              logger.warn('Legacy AI level-up produced an unresolvable class; refusing to write', {
                characterId: character.id, unresolvedClass
              });
              return res.status(409).json({
                error: 'unresolved_class',
                unresolvedClass,
                suggestions: suggestClassNames(unresolvedClass)
              });
            }
            updatedClasses[classLeveled] = (updatedClasses[classLeveled] || 0) + 1;

            const primaryClass = Object.entries(updatedClasses)
              .sort((a, b) => b[1] - a[1])[0][0];

            db.prepare(`
              UPDATE characters SET level = ?, hp = ?, max_hp = ?, spells = ?, skills = ?, passives = ?, class_features = ?, feats = ?, classes = ?, class = ? WHERE id = ?
            `).run(newLevel, newMaxHP, newMaxHP, newSpells || '', newSkills || '', newPassives || '', newClassFeatures || '', newFeats || '', JSON.stringify(updatedClasses), primaryClass, req.params.id);

            const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
            invalidateCache('characters:');
            emitCharacterUpdate(updatedChar.id, 'character_updated', updatedChar);
            emitCharacterUpdate(updatedChar.id, 'character_leveled_up', { character: updatedChar, summary: levelData.summary });

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
  router.post('/:id/edit', requireUser, async (req, res) => {
    const { editRequest, messages } = req.body;
    const character = loadOwnedCharacter(req, res);
    if (!character) return;

    const apiConfig = getAgentApiConfig();
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

    // Parse inventory for display
    let inventoryDisplay = 'None';
    try {
      const inv = JSON.parse(character.inventory || '[]');
      if (inv.length > 0) {
        inventoryDisplay = inv.map(i => i.quantity > 1 ? `${i.name} x${i.quantity}` : i.name).join(', ');
      }
    } catch (e) {}

    // Parse AC effects for display
    let acDisplay = `${character.ac || 10}`;
    try {
      const acEff = JSON.parse(character.ac_effects || '{}');
      if (acEff.base_source) {
        acDisplay = `${character.ac || 10} (${acEff.base_source}: ${acEff.base_value}`;
        if (acEff.effects && acEff.effects.length > 0) {
          acDisplay += ' + ' + acEff.effects.map(e => `${e.name}: +${e.value}`).join(', ');
        }
        acDisplay += ')';
      }
    } catch (e) {}

    const editPrompt = `You are a D&D 5e character editor. Help modify this character.

CHARACTER: ${character.character_name} (${character.race} ${classesDisplay}, Lv${character.level})
Stats: STR ${character.strength}, DEX ${character.dexterity}, CON ${character.constitution}, INT ${character.intelligence}, WIS ${character.wisdom}, CHA ${character.charisma}
HP: ${character.hp}/${character.max_hp}, AC: ${acDisplay}, XP: ${character.xp || 0}, Gold: ${character.gold || 0}
Inventory: ${inventoryDisplay}
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

      const aiConfig = apiConfig;
      const data = await aiService.callAI(aiConfig, allMessages, { maxTokens: 4096 });
      const aiMessage = aiService.extractAIMessage(data);

      if (!aiMessage) {
        throw new Error('Could not parse AI response');
      }

      // Check if edit is complete — try marker first, then fallback to JSON detection
      if (aiMessage.includes('EDIT_COMPLETE:') || aiMessage.includes('"EDIT_COMPLETE"')) {
        const jsonStr = extractMarkerJson(aiMessage, 'EDIT_COMPLETE:');

        if (jsonStr) {
          try {
            const editData = JSON.parse(jsonStr);
            const updates = [];
            const values = [];

            // `class` / `classes` are handled by applyAiClassFields (ladder-normalized,
            // unresolvable values dropped) and deliberately absent from this list.
            const fields = ['character_name', 'race', 'level', 'xp', 'gold', 'strength', 'dexterity', 'constitution',
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

            applyAiClassFields(editData, character, updates, values);

            if (updates.length > 0) {
              values.push(req.params.id);
              db.prepare(`UPDATE characters SET ${updates.join(', ')} WHERE id = ?`).run(...values);
            }

            const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
            invalidateCache('characters:');
            emitCharacterUpdate(updatedChar.id, 'character_updated', updatedChar);

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
            // Same boundary as the marker path: class fields go through the ladder.
            const fields = ['character_name', 'race', 'level', 'xp', 'gold', 'strength', 'dexterity', 'constitution',
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
            applyAiClassFields(editData, character, updates, values);
            if (updates.length > 0) {
              values.push(req.params.id);
              db.prepare(`UPDATE characters SET ${updates.join(', ')} WHERE id = ?`).run(...values);
              const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(req.params.id);
              invalidateCache('characters:');
              emitCharacterUpdate(updatedChar.id, 'character_updated', updatedChar);
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
  router.post('/ai-create', requireUser, async (req, res) => {
    const { messages } = req.body;

    const apiConfig = getAgentApiConfig();
    if (!apiConfig || !apiConfig.api_key) {
      return res.status(400).json({ error: 'No active API configuration. Please add and activate one in Settings.' });
    }

    const CHARACTER_CREATION_PROMPT = aiService.CHARACTER_CREATION_PROMPT;

    try {
      const aiConfig = apiConfig;
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
        const jsonStr = extractMarkerJson(aiMessage, 'CHARACTER_COMPLETE:');

        if (jsonStr) {
          try {
            const charData = JSON.parse(jsonStr);

            // Write boundary: never persist an AI-invented class string.
            const resolvedClass = resolveClassAndSubclass(charData.class);
            if (!resolvedClass.className) {
              logger.warn('AI character creation produced an unresolvable class; not saving', { value: String(charData.class || '') });
              return res.json({
                message: `I couldn't match "${String(charData.class || '')}" to a 5e class. Pick one of: ${suggestClassNames(charData.class).join(', ')} and I'll finish the sheet.`,
                complete: false
              });
            }
            const canonicalClass = resolvedClass.className;
            const normalizedClasses = normalizeClassesMap(charData.classes);
            if (normalizedClasses.unresolved.length) {
              logger.warn('AI character creation emitted unresolvable class keys; dropping them', { keys: normalizedClasses.unresolved });
            }
            const classesJson = Object.keys(normalizedClasses.classes).length
              ? JSON.stringify(normalizedClasses.classes)
              : JSON.stringify({ [canonicalClass]: 1 });
            const classChoices = {};
            if (resolvedClass.subclass) classChoices[canonicalClass] = { subclass: resolvedClass.subclass };
            for (const [className, subclass] of Object.entries(normalizedClasses.subclasses)) {
              if (!classChoices[className]) classChoices[className] = { subclass };
            }

            const id = uuidv4();
            const hp = 10 + Math.floor((charData.constitution - 10) / 2);

            db.prepare(`
              INSERT INTO characters (id, user_id, player_name, character_name, race, class, classes, class_choices, level, strength, dexterity, constitution, intelligence, wisdom, charisma, hp, max_hp, background, appearance, backstory, spells, skills, passives, class_features, feats)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              id,
              req.user.id,
              charData.player_name,
              charData.character_name,
              charData.race,
              canonicalClass,
              classesJson,
              JSON.stringify(classChoices),
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
            emitCharacterUpdate(character.id, 'character_created', character);

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
