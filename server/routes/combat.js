/**
 * Combat Routes
 * Handles combat tracker API endpoints
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');

/**
 * Create combat router with dependencies
 * @param {Object} db - Database instance
 * @param {Object} io - Socket.IO instance
 * @param {Object} auth - Auth middleware {checkPassword}
 * @returns {express.Router} Configured router
 */
function createCombatRoutes(db, io, auth) {
  const router = express.Router();
  const { checkPassword } = auth;

  /**
   * Helper: Get characters for a specific session
   */
  function getSessionCharacters(sessionId) {
    return db.prepare(`
      SELECT c.* FROM characters c
      INNER JOIN session_characters sc ON c.id = sc.character_id
      WHERE sc.session_id = ?
      ORDER BY c.created_at DESC
    `).all(sessionId);
  }

  /**
   * GET /api/sessions/:sessionId/combat
   * Get active combat for a session
   */
  router.get('/:sessionId/combat', checkPassword, (req, res) => {
    const combat = db.prepare('SELECT * FROM combats WHERE session_id = ? AND is_active = 1').get(req.params.sessionId);
    if (combat) {
      combat.combatants = JSON.parse(combat.combatants || '[]');
    }
    res.json(combat || null);
  });

  /**
   * POST /api/sessions/:sessionId/combat/start
   * Start new combat
   */
  router.post('/:sessionId/combat/start', checkPassword, (req, res) => {
    const { name, combatants } = req.body;
    const sessionId = req.params.sessionId;

    // End any existing active combat
    db.prepare('UPDATE combats SET is_active = 0 WHERE session_id = ? AND is_active = 1').run(sessionId);

    const id = uuidv4();

    // Sort combatants by initiative (descending)
    const sortedCombatants = (combatants || [])
      .map(c => ({
        ...c,
        id: c.id || uuidv4(),
        hp: c.hp || c.max_hp || 10,
        max_hp: c.max_hp || c.hp || 10,
        ac: c.ac || 10,
        conditions: c.conditions || [],
        is_active: true
      }))
      .sort((a, b) => (b.initiative || 0) - (a.initiative || 0));

    db.prepare(`
      INSERT INTO combats (id, session_id, name, combatants, is_active, current_turn, round)
      VALUES (?, ?, ?, ?, 1, 0, 1)
    `).run(id, sessionId, name || 'Combat', JSON.stringify(sortedCombatants));

    const combat = db.prepare('SELECT * FROM combats WHERE id = ?').get(id);
    combat.combatants = JSON.parse(combat.combatants);

    io.emit('combat_started', { sessionId, combat });
    res.json(combat);
  });

  /**
   * POST /api/sessions/:sessionId/combat/add-combatant
   * Add combatant to existing combat
   */
  router.post('/:sessionId/combat/add-combatant', checkPassword, (req, res) => {
    const { name, initiative, hp, max_hp, ac, is_player, character_id } = req.body;
    const combat = db.prepare('SELECT * FROM combats WHERE session_id = ? AND is_active = 1').get(req.params.sessionId);

    if (!combat) {
      return res.status(404).json({ error: 'No active combat' });
    }

    const combatants = JSON.parse(combat.combatants || '[]');

    const newCombatant = {
      id: uuidv4(),
      character_id: character_id || null,
      name: name,
      initiative: initiative || 0,
      hp: hp || max_hp || 10,
      max_hp: max_hp || hp || 10,
      ac: ac || 10,
      is_player: is_player || false,
      is_active: true,
      conditions: []
    };

    combatants.push(newCombatant);

    // Re-sort by initiative
    combatants.sort((a, b) => (b.initiative || 0) - (a.initiative || 0));

    db.prepare('UPDATE combats SET combatants = ? WHERE id = ?').run(JSON.stringify(combatants), combat.id);

    const updated = db.prepare('SELECT * FROM combats WHERE id = ?').get(combat.id);
    updated.combatants = JSON.parse(updated.combatants);

    io.emit('combat_updated', { sessionId: req.params.sessionId, combat: updated });
    res.json(updated);
  });

  /**
   * POST /api/sessions/:sessionId/combat/update-combatant
   * Update combatant (HP, conditions, etc.)
   */
  router.post('/:sessionId/combat/update-combatant', checkPassword, (req, res) => {
    const { combatant_id, hp, conditions, is_active, notes, initiative } = req.body;
    const combat = db.prepare('SELECT * FROM combats WHERE session_id = ? AND is_active = 1').get(req.params.sessionId);

    if (!combat) {
      return res.status(404).json({ error: 'No active combat' });
    }

    const combatants = JSON.parse(combat.combatants || '[]');
    const combatantIndex = combatants.findIndex(c => c.id === combatant_id);

    if (combatantIndex === -1) {
      return res.status(404).json({ error: 'Combatant not found' });
    }

    if (hp !== undefined) combatants[combatantIndex].hp = hp;
    if (conditions !== undefined) combatants[combatantIndex].conditions = conditions;
    if (is_active !== undefined) combatants[combatantIndex].is_active = is_active;
    if (notes !== undefined) combatants[combatantIndex].notes = notes;
    if (initiative !== undefined) {
      combatants[combatantIndex].initiative = initiative;
      // Re-sort by initiative
      combatants.sort((a, b) => (b.initiative || 0) - (a.initiative || 0));
    }

    db.prepare('UPDATE combats SET combatants = ? WHERE id = ?').run(JSON.stringify(combatants), combat.id);

    const updated = db.prepare('SELECT * FROM combats WHERE id = ?').get(combat.id);
    updated.combatants = JSON.parse(updated.combatants);

    io.emit('combat_updated', { sessionId: req.params.sessionId, combat: updated });
    res.json(updated);
  });

  /**
   * POST /api/sessions/:sessionId/combat/remove-combatant
   * Remove combatant
   */
  router.post('/:sessionId/combat/remove-combatant', checkPassword, (req, res) => {
    const { combatant_id } = req.body;
    const combat = db.prepare('SELECT * FROM combats WHERE session_id = ? AND is_active = 1').get(req.params.sessionId);

    if (!combat) {
      return res.status(404).json({ error: 'No active combat' });
    }

    let combatants = JSON.parse(combat.combatants || '[]');
    const removedIndex = combatants.findIndex(c => c.id === combatant_id);

    if (removedIndex === -1) {
      return res.status(404).json({ error: 'Combatant not found' });
    }

    combatants = combatants.filter(c => c.id !== combatant_id);

    // Adjust current_turn if needed
    let currentTurn = combat.current_turn;
    if (removedIndex < currentTurn) {
      currentTurn = Math.max(0, currentTurn - 1);
    } else if (currentTurn >= combatants.length) {
      currentTurn = 0;
    }

    db.prepare('UPDATE combats SET combatants = ?, current_turn = ? WHERE id = ?').run(JSON.stringify(combatants), currentTurn, combat.id);

    const updated = db.prepare('SELECT * FROM combats WHERE id = ?').get(combat.id);
    updated.combatants = JSON.parse(updated.combatants);

    io.emit('combat_updated', { sessionId: req.params.sessionId, combat: updated });
    res.json(updated);
  });

  /**
   * POST /api/sessions/:sessionId/combat/next-turn
   * Advance to next turn
   */
  router.post('/:sessionId/combat/next-turn', checkPassword, (req, res) => {
    const combat = db.prepare('SELECT * FROM combats WHERE session_id = ? AND is_active = 1').get(req.params.sessionId);

    if (!combat) {
      return res.status(404).json({ error: 'No active combat' });
    }

    const combatants = JSON.parse(combat.combatants || '[]');
    const activeCombatants = combatants.filter(c => c.is_active !== false);

    if (activeCombatants.length === 0) {
      return res.status(400).json({ error: 'No active combatants' });
    }

    let nextTurn = combat.current_turn + 1;
    let round = combat.round;

    // Find next active combatant
    while (nextTurn < combatants.length && combatants[nextTurn].is_active === false) {
      nextTurn++;
    }

    // Wrap to next round if needed
    if (nextTurn >= combatants.length) {
      nextTurn = 0;
      round++;
      // Find first active combatant in new round
      while (nextTurn < combatants.length && combatants[nextTurn].is_active === false) {
        nextTurn++;
      }
    }

    db.prepare('UPDATE combats SET current_turn = ?, round = ? WHERE id = ?').run(nextTurn, round, combat.id);

    const updated = db.prepare('SELECT * FROM combats WHERE id = ?').get(combat.id);
    updated.combatants = JSON.parse(updated.combatants);

    io.emit('combat_updated', { sessionId: req.params.sessionId, combat: updated });
    res.json(updated);
  });

  /**
   * POST /api/sessions/:sessionId/combat/prev-turn
   * Go back to previous turn
   */
  router.post('/:sessionId/combat/prev-turn', checkPassword, (req, res) => {
    const combat = db.prepare('SELECT * FROM combats WHERE session_id = ? AND is_active = 1').get(req.params.sessionId);

    if (!combat) {
      return res.status(404).json({ error: 'No active combat' });
    }

    const combatants = JSON.parse(combat.combatants || '[]');
    let prevTurn = combat.current_turn - 1;
    let round = combat.round;

    // Find previous active combatant
    while (prevTurn >= 0 && combatants[prevTurn].is_active === false) {
      prevTurn--;
    }

    // Wrap to previous round if needed
    if (prevTurn < 0 && round > 1) {
      round--;
      prevTurn = combatants.length - 1;
      while (prevTurn >= 0 && combatants[prevTurn].is_active === false) {
        prevTurn--;
      }
    }

    if (prevTurn < 0) prevTurn = 0;

    db.prepare('UPDATE combats SET current_turn = ?, round = ? WHERE id = ?').run(prevTurn, round, combat.id);

    const updated = db.prepare('SELECT * FROM combats WHERE id = ?').get(combat.id);
    updated.combatants = JSON.parse(updated.combatants);

    io.emit('combat_updated', { sessionId: req.params.sessionId, combat: updated });
    res.json(updated);
  });

  /**
   * POST /api/sessions/:sessionId/combat/end
   * End combat
   */
  router.post('/:sessionId/combat/end', checkPassword, (req, res) => {
    const combat = db.prepare('SELECT * FROM combats WHERE session_id = ? AND is_active = 1').get(req.params.sessionId);

    if (!combat) {
      return res.status(404).json({ error: 'No active combat' });
    }

    db.prepare('UPDATE combats SET is_active = 0 WHERE id = ?').run(combat.id);
    io.emit('combat_ended', { sessionId: req.params.sessionId });
    res.json({ success: true });
  });

  /**
   * POST /api/sessions/:sessionId/combat/damage
   * Quick damage/heal
   */
  router.post('/:sessionId/combat/damage', checkPassword, (req, res) => {
    const { combatant_id, amount } = req.body; // amount: positive = damage, negative = heal
    const combat = db.prepare('SELECT * FROM combats WHERE session_id = ? AND is_active = 1').get(req.params.sessionId);

    if (!combat) {
      return res.status(404).json({ error: 'No active combat' });
    }

    const combatants = JSON.parse(combat.combatants || '[]');
    const combatantIndex = combatants.findIndex(c => c.id === combatant_id);

    if (combatantIndex === -1) {
      return res.status(404).json({ error: 'Combatant not found' });
    }

    const combatant = combatants[combatantIndex];
    const newHp = Math.max(0, Math.min(combatant.max_hp, combatant.hp - amount));
    combatants[combatantIndex].hp = newHp;

    db.prepare('UPDATE combats SET combatants = ? WHERE id = ?').run(JSON.stringify(combatants), combat.id);

    const updated = db.prepare('SELECT * FROM combats WHERE id = ?').get(combat.id);
    updated.combatants = JSON.parse(updated.combatants);

    io.emit('combat_updated', { sessionId: req.params.sessionId, combat: updated });
    res.json(updated);
  });

  /**
   * POST /api/sessions/:sessionId/combat/roll-party-initiative
   * Roll initiative for all party members
   */
  router.post('/:sessionId/combat/roll-party-initiative', checkPassword, (req, res) => {
    const characters = getSessionCharacters(req.params.sessionId);

    const partyInitiatives = characters.map(char => {
      // Roll d20 + DEX modifier + initiative_bonus
      const dexMod = Math.floor((char.dexterity - 10) / 2);
      const initBonus = char.initiative_bonus || 0;
      const roll = Math.floor(Math.random() * 20) + 1;
      const total = roll + dexMod + initBonus;

      return {
        character_id: char.id,
        name: char.character_name,
        initiative: total,
        roll: roll,
        dexMod: dexMod,
        initBonus: initBonus,
        hp: char.hp,
        max_hp: char.max_hp,
        ac: char.ac || 10,
        is_player: true
      };
    });

    res.json(partyInitiatives);
  });

  return router;
}

module.exports = { createCombatRoutes };
