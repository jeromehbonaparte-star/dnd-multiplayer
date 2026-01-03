/**
 * Tag Parser Service
 * Parses DM response tags like [XP:], [HP:], [ITEM:], [SPELL:], [AC:], [COMBAT:], [MONEY:]
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../lib/logger');

/**
 * Find character by name with fuzzy matching
 * Matches: exact name, first name only, or partial match
 * @param {Array} characters - Array of character objects
 * @param {string} searchName - Name to search for
 * @returns {Object|null} Found character or null
 */
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

/**
 * Parse XP awards from AI response
 * Format: [XP: CharacterName +100, OtherCharacter +50]
 * @param {string} text - AI response text
 * @param {Array} characters - Array of character objects
 * @returns {Array} Array of {characterId, characterName, amount}
 */
function parseXPAwards(text, characters) {
  const awards = [];
  const xpMatches = text.match(/\[XP:\s*([^\]]+)\]/gi);

  if (!xpMatches) return awards;

  for (const match of xpMatches) {
    const xpAwards = match.replace(/\[XP:\s*/i, '').replace(']', '').split(',');
    for (const award of xpAwards) {
      const xpMatch = award.trim().match(/^(.+?)\s*\+\s*(\d+)$/);
      if (xpMatch) {
        const charName = xpMatch[1].trim();
        const xpAmount = parseInt(xpMatch[2]);
        const char = findCharacterByName(characters, charName);
        if (char) {
          awards.push({
            characterId: char.id,
            characterName: char.character_name,
            amount: xpAmount
          });
        }
      }
    }
  }

  return awards;
}

/**
 * Parse money/gold changes from AI response
 * Format: [MONEY: Name +50] or [MONEY: Name -25]
 * @param {string} text - AI response text
 * @param {Array} characters - Array of character objects
 * @returns {Array} Array of {characterId, characterName, amount}
 */
function parseMoneyChanges(text, characters) {
  const changes = [];
  const moneyMatches = text.match(/\[MONEY:\s*([^\]]+)\]/gi);

  if (!moneyMatches) return changes;

  for (const match of moneyMatches) {
    const moneyAwards = match.replace(/\[MONEY:\s*/i, '').replace(']', '').split(',');
    for (const award of moneyAwards) {
      const moneyMatch = award.trim().match(/^(.+?)\s*([+-])\s*(\d+)$/);
      if (moneyMatch) {
        const charName = moneyMatch[1].trim();
        const sign = moneyMatch[2] === '+' ? 1 : -1;
        const moneyAmount = parseInt(moneyMatch[3]) * sign;
        const char = findCharacterByName(characters, charName);
        if (char) {
          changes.push({
            characterId: char.id,
            characterName: char.character_name,
            amount: moneyAmount
          });
        }
      }
    }
  }

  return changes;
}

/**
 * Parse item changes from AI response
 * Format: [ITEM: Name +Sword] or [ITEM: Name -Potion] or [ITEM: Name +Health Potion x3]
 * @param {string} text - AI response text
 * @param {Array} characters - Array of character objects
 * @returns {Array} Array of {characterId, characterName, item, quantity, isAdding}
 */
function parseItemChanges(text, characters) {
  const changes = [];
  const itemMatches = text.match(/\[ITEM:\s*([^\]]+)\]/gi);

  if (!itemMatches) return changes;

  for (const match of itemMatches) {
    const content = match.replace(/\[ITEM:\s*/i, '').replace(']', '');
    // Match: "Name +Item" or "Name +Item x3" or "Name +Item (x3)" or "Name -Item"
    const itemMatch = content.match(/^(.+?)\s*([+-])\s*(.+?)(?:\s*(?:x|×|\(x)(\d+)\)?)?$/i);

    if (itemMatch) {
      const charName = itemMatch[1].trim();
      const isAdding = itemMatch[2] === '+';
      let itemName = itemMatch[3].trim();
      let quantity = itemMatch[4] ? parseInt(itemMatch[4]) : 1;

      // Handle quantity embedded in item name
      const qtyInName = itemName.match(/^(\d+)\s*x\s*(.+)$/i);
      if (qtyInName) {
        quantity = parseInt(qtyInName[1]);
        itemName = qtyInName[2].trim();
      }

      const char = findCharacterByName(characters, charName);
      if (char) {
        changes.push({
          characterId: char.id,
          characterName: char.character_name,
          item: itemName,
          quantity: quantity,
          isAdding: isAdding
        });
      }
    }
  }

  return changes;
}

/**
 * Parse HP changes from AI response
 * Format: [HP: Name -10] or [HP: Name +5] or [HP: Name =30]
 * @param {string} text - AI response text
 * @param {Array} characters - Array of character objects
 * @returns {Array} Array of {characterId, characterName, operator, value}
 */
function parseHPChanges(text, characters) {
  const changes = [];
  const hpMatches = text.match(/\[HP:\s*([^\]]+)\]/gi);

  if (!hpMatches) return changes;

  for (const match of hpMatches) {
    const content = match.replace(/\[HP:\s*/i, '').replace(']', '');
    const hpMatch = content.match(/^(.+?)\s*([+\-=])\s*(\d+)$/);

    if (hpMatch) {
      const charName = hpMatch[1].trim();
      const operator = hpMatch[2];
      const value = parseInt(hpMatch[3]);
      const char = findCharacterByName(characters, charName);

      if (char) {
        changes.push({
          characterId: char.id,
          characterName: char.character_name,
          operator: operator,
          value: value
        });
      }
    }
  }

  return changes;
}

/**
 * Parse spell slot usage from AI response
 * Format: [SPELL: Name -1st] or [SPELL: Name +REST]
 * @param {string} text - AI response text
 * @param {Array} characters - Array of character objects
 * @returns {Array} Array of {characterId, characterName, action, level}
 */
function parseSpellSlotChanges(text, characters) {
  const changes = [];
  const spellMatches = text.match(/\[SPELL:\s*([^\]]+)\]/gi);

  if (!spellMatches) return changes;

  for (const match of spellMatches) {
    const content = match.replace(/\[SPELL:\s*/i, '').replace(']', '');

    // Check for REST command
    const restMatch = content.match(/^(.+?)\s*\+\s*REST$/i);
    if (restMatch) {
      const charName = restMatch[1].trim();

      // Handle "Party" as special case
      if (charName.toLowerCase() === 'party') {
        changes.push({
          characterId: 'all',
          characterName: 'Party',
          action: 'rest',
          level: null
        });
      } else {
        const char = findCharacterByName(characters, charName);
        if (char) {
          changes.push({
            characterId: char.id,
            characterName: char.character_name,
            action: 'rest',
            level: null
          });
        }
      }
      continue;
    }

    // Check for slot usage/restore
    const slotMatch = content.match(/^(.+?)\s*([+-])\s*(\d+)(?:st|nd|rd|th)$/i);
    if (slotMatch) {
      const charName = slotMatch[1].trim();
      const isUsing = slotMatch[2] === '-';
      const level = slotMatch[3];
      const char = findCharacterByName(characters, charName);

      if (char) {
        changes.push({
          characterId: char.id,
          characterName: char.character_name,
          action: isUsing ? 'use' : 'restore',
          level: level
        });
      }
    }
  }

  return changes;
}

/**
 * Parse AC changes from AI response
 * Format: [AC: Name +Shield +2 equipment] or [AC: Name -Shield] or [AC: Name base Plate Armor 18]
 * @param {string} text - AI response text
 * @param {Array} characters - Array of character objects
 * @returns {Array} Array of AC changes
 */
function parseACChanges(text, characters) {
  const changes = [];
  const acMatches = text.match(/\[AC:\s*([^\]]+)\]/gi);

  if (!acMatches) return changes;

  for (const match of acMatches) {
    const content = match.replace(/\[AC:\s*/i, '').replace(']', '');

    // Check for base AC change: [AC: Name base ArmorName Value]
    const baseMatch = content.match(/^(.+?)\s+base\s+(.+?)\s+(\d+)$/i);
    if (baseMatch) {
      const charName = baseMatch[1].trim();
      const armorName = baseMatch[2].trim();
      const baseValue = parseInt(baseMatch[3]);
      const char = findCharacterByName(characters, charName);

      if (char) {
        changes.push({
          characterId: char.id,
          characterName: char.character_name,
          action: 'set_base',
          baseSource: armorName,
          baseValue: baseValue
        });
      }
      continue;
    }

    // Check for add effect: [AC: Name +EffectName +Value Type]
    const addMatch = content.match(/^(.+?)\s*\+\s*(.+?)\s*\+\s*(\d+)\s+(\w+)$/i);
    if (addMatch) {
      const charName = addMatch[1].trim();
      const effectName = addMatch[2].trim();
      const effectValue = parseInt(addMatch[3]);
      const effectType = addMatch[4].trim().toLowerCase();
      const char = findCharacterByName(characters, charName);

      if (char) {
        changes.push({
          characterId: char.id,
          characterName: char.character_name,
          action: 'add_effect',
          effect: {
            id: uuidv4(),
            name: effectName,
            value: effectValue,
            type: effectType,
            temporary: effectType === 'spell'
          }
        });
      }
      continue;
    }

    // Check for remove effect: [AC: Name -EffectName]
    const removeMatch = content.match(/^(.+?)\s*-\s*(.+)$/i);
    if (removeMatch) {
      const charName = removeMatch[1].trim();
      const effectName = removeMatch[2].trim();
      const char = findCharacterByName(characters, charName);

      if (char) {
        changes.push({
          characterId: char.id,
          characterName: char.character_name,
          action: 'remove_effect',
          effectName: effectName
        });
      }
    }
  }

  return changes;
}

/**
 * Parse combat commands from AI response
 * Format: [COMBAT: START Name] or [COMBAT: END] or [COMBAT: NEXT]
 * @param {string} text - AI response text
 * @returns {Array} Array of combat commands
 */
function parseCombatCommands(text) {
  const commands = [];
  const combatMatches = text.match(/\[COMBAT:\s*([^\]]+)\]/gi);

  if (!combatMatches) return commands;

  for (const match of combatMatches) {
    const content = match.replace(/\[COMBAT:\s*/i, '').replace(']', '').trim();

    if (content.toLowerCase() === 'end') {
      commands.push({ action: 'end' });
    } else if (content.toLowerCase() === 'next') {
      commands.push({ action: 'next' });
    } else if (content.toLowerCase().startsWith('start')) {
      const name = content.replace(/^start\s*/i, '').trim() || 'Combat';
      commands.push({ action: 'start', name: name });
    }
  }

  return commands;
}

/**
 * Parse all tags from AI response
 * @param {string} text - AI response text
 * @param {Array} characters - Array of character objects
 * @returns {Object} All parsed changes
 */
function parseAllTags(text, characters) {
  return {
    xp: parseXPAwards(text, characters),
    money: parseMoneyChanges(text, characters),
    items: parseItemChanges(text, characters),
    hp: parseHPChanges(text, characters),
    spellSlots: parseSpellSlotChanges(text, characters),
    ac: parseACChanges(text, characters),
    combat: parseCombatCommands(text)
  };
}

/**
 * Apply inventory change to character
 * @param {Array} inventory - Current inventory array
 * @param {string} itemName - Item name
 * @param {number} quantity - Quantity to add/remove
 * @param {boolean} isAdding - Whether adding or removing
 * @returns {Array} Updated inventory
 */
function applyInventoryChange(inventory, itemName, quantity, isAdding) {
  const normalizedName = itemName.toLowerCase();
  const existingIndex = inventory.findIndex(i =>
    i.name.toLowerCase() === normalizedName
  );

  if (isAdding) {
    if (existingIndex >= 0) {
      inventory[existingIndex].quantity = (inventory[existingIndex].quantity || 1) + quantity;
    } else {
      inventory.push({ name: itemName, quantity: quantity });
    }
  } else {
    if (existingIndex >= 0) {
      inventory[existingIndex].quantity = Math.max(0, (inventory[existingIndex].quantity || 1) - quantity);
      if (inventory[existingIndex].quantity <= 0) {
        inventory.splice(existingIndex, 1);
      }
    }
  }

  return inventory;
}

/**
 * Apply HP change to character
 * @param {Object} character - Character object with hp and max_hp
 * @param {string} operator - '+', '-', or '='
 * @param {number} value - Amount
 * @returns {number} New HP value
 */
function calculateNewHP(character, operator, value) {
  let newHp;
  switch (operator) {
    case '+':
      newHp = Math.min((character.hp || 0) + value, character.max_hp);
      break;
    case '-':
      newHp = Math.max((character.hp || 0) - value, 0);
      break;
    case '=':
      newHp = Math.min(Math.max(value, 0), character.max_hp);
      break;
    default:
      newHp = character.hp;
  }
  return newHp;
}

module.exports = {
  findCharacterByName,
  parseXPAwards,
  parseMoneyChanges,
  parseItemChanges,
  parseHPChanges,
  parseSpellSlotChanges,
  parseACChanges,
  parseCombatCommands,
  parseAllTags,
  applyInventoryChange,
  calculateNewHP
};
