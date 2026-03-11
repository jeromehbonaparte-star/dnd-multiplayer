/**
 * Tag Applicator Service
 * Parses all tags from AI responses and applies them to the database
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../lib/logger');

/**
 * Apply all parsed tags from an AI response to the database
 * @param {Object} deps - Dependencies
 * @param {Object} deps.db - Database instance
 * @param {Object} deps.io - Socket.IO instance
 * @param {Object} deps.tagParser - Tag parser service
 * @param {Function} deps.parseAcEffects - AC effects parser
 * @param {Function} deps.calculateTotalAC - AC calculator
 * @param {Function} deps.updateCharacterAC - AC updater (takes db, charId, acEffects)
 * @param {string} aiResponse - The AI response text
 * @param {Array} characters - Array of character objects
 * @param {string} sessionId - Session ID
 * @returns {Object} Summary of what was applied
 */
function applyAllTags(deps, aiResponse, characters, sessionId) {
  const { db, io, tagParser, parseAcEffects, calculateTotalAC, updateCharacterAC } = deps;
  const { findCharacterByName } = tagParser;

  const summary = {
    xp: [],
    money: [],
    items: [],
    hp: [],
    spellSlots: [],
    ac: [],
    combat: []
  };

  // Debug: Log tag detection
  const allTags = aiResponse.match(/\[[A-Z]+:[^\]]+\]/gi);
  console.log('All tags found:', allTags);

  // ==================== XP ====================
  const xpMatches = aiResponse.match(/\[XP:\s*([^\]]+)\]/gi);
  console.log('XP tags found:', xpMatches);
  if (xpMatches) {
    for (const match of xpMatches) {
      const xpAwards = match.replace(/\[XP:\s*/i, '').replace(']', '').split(',');
      for (const award of xpAwards) {
        const xpMatch = award.trim().match(/(.+?)\s*\+\s*(\d+)/);
        console.log('XP award parse:', award.trim(), '->', xpMatch);
        if (xpMatch) {
          const charName = xpMatch[1].trim();
          const xpAmount = parseInt(xpMatch[2]);
          const char = findCharacterByName(characters, charName);
          if (char) {
            db.prepare('UPDATE characters SET xp = MAX(0, xp + ?) WHERE id = ?').run(xpAmount, char.id);
            const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(char.id);
            io.emit('character_updated', updatedChar);
            console.log(`XP Update: ${char.character_name} +${xpAmount} -> ${updatedChar.xp} XP`);
            summary.xp.push({ character: char.character_name, amount: xpAmount });
          } else {
            console.log(`XP Update FAILED: Character "${charName}" not found in session`);
          }
        }
      }
    }
  }

  // ==================== MONEY ====================
  const moneyMatches = aiResponse.match(/\[(MONEY|GOLD):\s*([^\]]+)\]/gi);
  console.log('MONEY/GOLD tags found:', moneyMatches);
  if (moneyMatches) {
    for (const match of moneyMatches) {
      const moneyAwards = match.replace(/\[(MONEY|GOLD):\s*/i, '').replace(']', '').split(',');
      for (const award of moneyAwards) {
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
            summary.money.push({ character: char.character_name, amount: moneyAmount });
          } else {
            console.log(`Money Update FAILED: Character "${charName}" not found in session`);
          }
        }
      }
    }
  }

  // ==================== ITEMS ====================
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

            // Clean up any items with quantity <= 0 that might have slipped through
            const cleanedInventory = inventory.filter(i => (i.quantity || 1) > 0);
            db.prepare('UPDATE characters SET inventory = ? WHERE id = ?').run(JSON.stringify(cleanedInventory), char.id);
            io.emit('character_updated', { ...char, inventory: JSON.stringify(cleanedInventory) });
            summary.items.push({ character: char.character_name, item: itemName, quantity, isAdding });
          } else {
            console.log(`Character not found: "${charName}". Available:`, characters.map(c => c.character_name));
          }
        }
      }
    }
  }

  // ==================== SPELL SLOTS ====================
  // Uses .current/.max pattern: REST sets current = max, use decreases current by 1, restore increases current by 1
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
              // Restore all spell slots: set current = max
              for (const level in spellSlots) {
                if (spellSlots[level].max) {
                  spellSlots[level].current = spellSlots[level].max;
                }
              }
              summary.spellSlots.push({ character: char.character_name, action: 'rest' });
            } else {
              // Parse slot level (1st, 2nd, 3rd, etc. OR first, second, third, etc.)
              const ordinalMap = { 'first': '1', 'second': '2', 'third': '3', 'fourth': '4',
                'fifth': '5', 'sixth': '6', 'seventh': '7', 'eighth': '8', 'ninth': '9' };
              let levelNum = slotLevel.replace(/[^0-9]/g, '');
              if (!levelNum && ordinalMap[slotLevel]) {
                levelNum = ordinalMap[slotLevel];
              }
              if (levelNum && spellSlots[levelNum]) {
                if (!isAdding) {
                  // Using a spell slot: decrease current by 1
                  spellSlots[levelNum].current = Math.max(
                    (spellSlots[levelNum].current ?? spellSlots[levelNum].max ?? 0) - 1,
                    0
                  );
                  summary.spellSlots.push({ character: char.character_name, action: 'use', level: levelNum });
                } else {
                  // Restoring a spell slot: increase current by 1
                  spellSlots[levelNum].current = Math.min(
                    (spellSlots[levelNum].current ?? 0) + 1,
                    spellSlots[levelNum].max || 0
                  );
                  summary.spellSlots.push({ character: char.character_name, action: 'restore', level: levelNum });
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

  // ==================== AC EFFECTS ====================
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
          updateCharacterAC(db, char.id, acEffects);
          const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(char.id);
          io.emit('character_updated', updatedChar);
          summary.ac.push({ character: char.character_name, action: 'set_base', armor: armorName, value: baseValue });
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
          updateCharacterAC(db, char.id, acEffects);
          const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(char.id);
          io.emit('character_updated', updatedChar);
          summary.ac.push({ character: char.character_name, action: 'add_effect', effect: effectName, value: effectValue });
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
          updateCharacterAC(db, char.id, acEffects);
          const updatedChar = db.prepare('SELECT * FROM characters WHERE id = ?').get(char.id);
          io.emit('character_updated', updatedChar);
          summary.ac.push({ character: char.character_name, action: 'remove_effect', effect: effectName });
        }
        continue;
      }
    }
  }

  // ==================== HP ====================
  const hpMatches = aiResponse.match(/\[HP:\s*([^\]]+)\]/gi);
  console.log('HP tags found:', hpMatches);
  if (hpMatches) {
    for (const match of hpMatches) {
      const hpContent = match.replace(/\[HP:\s*/i, '').replace(']', '').trim();
      console.log('HP content:', hpContent);

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
          summary.hp.push({ character: char.character_name, operator, value, newHp });
        } else {
          console.log(`HP Update FAILED: Character "${charName}" not found in session`);
        }
      }
    }
  }

  // ==================== COMBAT ====================
  const combatMatches = aiResponse.match(/\[COMBAT:([^\]]+)\]/gi);
  if (combatMatches) {
    for (const match of combatMatches) {
      const combatContent = match.replace(/\[COMBAT:/i, '').replace(']', '').trim().toUpperCase();

      if (combatContent.startsWith('START')) {
        // Parse extended format: "START Name | Enemy1 15hp 13ac, Enemy2 30hp 16ac"
        const rawContent = match.replace(/\[COMBAT:/i, '').replace(']', '').trim();
        const startContent = rawContent.replace(/^START\s*/i, '').trim();

        let combatName = 'Combat';
        let parsedEnemies = [];

        const pipeIdx = startContent.indexOf('|');
        if (pipeIdx !== -1) {
          combatName = startContent.substring(0, pipeIdx).trim() || 'Combat';
          const enemyDefs = startContent.substring(pipeIdx + 1).trim();
          for (const enemyStr of enemyDefs.split(',')) {
            const trimmed = enemyStr.trim();
            const enemyMatch = trimmed.match(/^(.+?)\s+(\d+)\s*hp\s+(\d+)\s*ac$/i);
            if (enemyMatch) {
              parsedEnemies.push({
                name: enemyMatch[1].trim(),
                hp: parseInt(enemyMatch[2]),
                ac: parseInt(enemyMatch[3])
              });
            }
          }
        } else {
          combatName = startContent || 'Combat';
        }

        const combatId = uuidv4();
        const combatants = characters.map(c => ({
          id: c.id,
          name: c.character_name,
          initiative: Math.floor(Math.random() * 20) + 1 + Math.floor(((c.dexterity || 10) - 10) / 2),
          hp: c.hp,
          maxHp: c.max_hp,
          ac: c.ac,
          isPlayer: true
        }));

        // Add parsed enemies as combatants
        if (parsedEnemies.length > 0) {
          for (const enemy of parsedEnemies) {
            combatants.push({
              id: uuidv4(),
              name: enemy.name,
              initiative: Math.floor(Math.random() * 20) + 1,
              hp: enemy.hp,
              maxHp: enemy.hp,
              ac: enemy.ac,
              isPlayer: false
            });
          }
        }

        // Sort all combatants by initiative
        combatants.sort((a, b) => b.initiative - a.initiative);

        db.prepare(`INSERT INTO combats (id, session_id, name, combatants, is_active) VALUES (?, ?, ?, ?, 1)`)
          .run(combatId, sessionId, combatName, JSON.stringify(combatants));

        const combat = db.prepare('SELECT * FROM combats WHERE id = ?').get(combatId);
        io.emit('combat_started', { sessionId, combat: { ...combat, combatants: JSON.parse(combat.combatants) } });
        console.log(`Combat started: ${combatName}`);
        summary.combat.push({ action: 'start', name: combatName });
      } else if (combatContent === 'END') {
        db.prepare('UPDATE combats SET is_active = 0 WHERE session_id = ? AND is_active = 1').run(sessionId);
        io.emit('combat_ended', { sessionId });
        console.log('Combat ended');
        summary.combat.push({ action: 'end' });
      } else if (combatContent === 'NEXT') {
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
        summary.combat.push({ action: 'next' });
      } else if (combatContent === 'PREV') {
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
        summary.combat.push({ action: 'prev' });
      }
    }
  }

  return summary;
}

module.exports = { applyAllTags };
