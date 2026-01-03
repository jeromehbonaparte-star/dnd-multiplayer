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

  // XP thresholds for each level (D&D 5e)
  const XP_THRESHOLDS = [0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000];

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
   */
  router.get('/', checkPassword, (req, res) => {
    const cacheKey = 'characters:list';
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const characters = db.prepare('SELECT * FROM characters ORDER BY created_at DESC').all();
    setCache(cacheKey, characters);
    res.json(characters);
  });

  /**
   * POST /api/characters
   * Create a new character manually
   */
  router.post('/', checkPassword, validateBody(schemas.character), (req, res) => {
    const { player_name, character_name, race, class: charClass, strength, dexterity, constitution, intelligence, wisdom, charisma, background } = req.body;

    // Sanitize string inputs
    const sanitizedPlayerName = validate.sanitizeString(player_name, 100);
    const sanitizedCharName = validate.sanitizeString(character_name, 100);
    const sanitizedRace = validate.sanitizeString(race, 50);
    const sanitizedClass = validate.sanitizeString(charClass, 50);
    const sanitizedBackground = validate.sanitizeString(background, 1000);

    const id = uuidv4();
    const hp = 10 + Math.floor((constitution - 10) / 2);

    db.prepare(`INSERT INTO characters (id, player_name, character_name, race, class, strength, dexterity, constitution, intelligence, wisdom, charisma, hp, max_hp, background) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, sanitizedPlayerName, sanitizedCharName, sanitizedRace, sanitizedClass, strength, dexterity, constitution, intelligence, wisdom, charisma, hp, hp, sanitizedBackground);

    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
    invalidateCache('characters:');
    io.emit('character_created', character);
    res.json(character);
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
      'appearance', 'backstory', 'initiative_bonus'
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

    const editPrompt = `You are a D&D 5e character editor assistant. Help modify this character based on the user's request.

CURRENT CHARACTER:
- Player: ${character.player_name}
- Name: ${character.character_name}
- Race: ${character.race}
- Classes: ${classesDisplay} (Total Level: ${character.level})
- Classes JSON: ${classesJson}
- XP: ${character.xp || 0}
- Gold: ${character.gold || 0}
- Stats: STR ${character.strength}, DEX ${character.dexterity}, CON ${character.constitution}, INT ${character.intelligence}, WIS ${character.wisdom}, CHA ${character.charisma}
- HP: ${character.hp}/${character.max_hp}
- AC (Armor Class): ${character.ac || 10}
- Spell Slots: ${spellSlotsDisplay}
- Background: ${character.background}
- Appearance: ${character.appearance || 'Not set'}
- Backstory: ${character.backstory || 'Not set'}
- Spells: ${character.spells || 'None'}
- Skills: ${character.skills || 'None'}
- Passives: ${character.passives || 'None'}
- Class Features: ${character.class_features || 'None'}
- Feats: ${character.feats || 'None'}

USER'S EDIT REQUEST: ${editRequest}

Discuss the changes with the user. When you have confirmed ALL changes, output the COMPLETE updated character in this EXACT JSON format.
EDIT_COMPLETE:{"character_name":"...","race":"...","class":"PrimaryClass","classes":{"Fighter":5},"level":N,"xp":N,"gold":N,"strength":N,"dexterity":N,"constitution":N,"intelligence":N,"wisdom":N,"charisma":N,"hp":N,"max_hp":N,"ac":N,"spell_slots":{"1":{"current":N,"max":N}},"background":"...","appearance":"...","backstory":"...","spells":"...","skills":"...","passives":"...","class_features":"...","feats":"..."}`;

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
      const aiMessage = aiService.extractAIMessage(data);

      if (!aiMessage) {
        throw new Error('Could not parse AI response');
      }

      // Check if edit is complete
      if (aiMessage.includes('EDIT_COMPLETE:')) {
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

            const cleanMessage = aiMessage.substring(0, aiMessage.indexOf('EDIT_COMPLETE:')).trim();
            return res.json({ message: cleanMessage || 'Character updated!', complete: true, character: updatedChar });
          } catch (parseError) {
            console.error('Failed to parse edit JSON:', parseError.message);
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
            ...(messages || [])
          ],
          max_tokens: 64000
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${errorText}`);
      }

      const data = await response.json();
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
