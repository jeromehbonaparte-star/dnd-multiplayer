/**
 * Turn Processor Service
 * Handles AI turn processing, history compaction, token estimation, and game snapshots
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../lib/logger');
const { estimateTokens } = require('../lib/tokens');
const { searchYoutubeMusic } = require('./youtubeService');
const { queueAutoPOVScenes } = require('./imageGenerationService');
const combatService = require('./combatService');
const combatIntegration = require('./combatIntegration');
const { normalizeAutoCombatSetup } = combatService;
const {
  NARRATION_WORD_LIMIT,
  NARRATION_MAX_TOKENS,
  NARRATION_CONTINUATION_MAX_TOKENS
} = require('./aiService');

// === History compaction tuning constants ===
// COMPACT_TAIL: number of most-recent raw entries ALWAYS retained (never summarized), so a
//   compaction never leaves the next turn re-accumulating from ~nothing (the "tail cliff"
//   that made the gap between summarizations vanish).
// MIN_MESSAGES_BEFORE_COMPACT: don't compact until at least this many entries have accumulated
//   since the last compaction (must be > COMPACT_TAIL so there is something left to compact).
// DEFAULT_MAX_TOKENS_BEFORE_COMPACT: fallback trigger threshold when settings omit one.
// MAX_SUMMARY_CHARS: cap on summary length before recursive re-summarization.
const COMPACT_TAIL = 10;
const MIN_MESSAGES_BEFORE_COMPACT = 14;
const DEFAULT_MAX_TOKENS_BEFORE_COMPACT = 16000;
const MAX_SUMMARY_CHARS = 8000;

function didTurnCommit(before, after) {
  let beforeLength = 0;
  let afterHistory = [];
  try { beforeLength = JSON.parse(before?.full_history || '[]').length; } catch (error) { beforeLength = 0; }
  try { afterHistory = JSON.parse(after?.full_history || '[]'); } catch (error) { afterHistory = []; }
  const lastEntry = afterHistory[afterHistory.length - 1];
  return Number(after?.current_turn || 0) > Number(before?.current_turn || 0)
    || (afterHistory.length > beforeLength && lastEntry?.type === 'narration');
}

/**
 * Compact history into a structured summary using AI
 * @param {Object} apiConfig - Active API config {endpoint, api_key, model}
 * @param {string} existingSummary - Current story summary
 * @param {Array} history - History entries to compact
 * @param {Array} characters - Array of character objects
 * @param {Function} extractAIMessage - Function to extract message from AI response
 * @returns {Promise<string>} New summary text
 */
async function compactHistory(apiConfig, existingSummary, history, characters, extractAIMessage) {
  // Format history with better context — include POV content for richer summaries
  const historyText = history.map(h => {
    if (h.type === 'action' && h.character_name) {
      return `[${h.character_name}]: ${h.content}`;
    } else if (h.type === 'narration' || h.role === 'assistant') {
      // If POVs exist, include them for richer summary context
      if (h.povs && Object.keys(h.povs).length > 0) {
        return Object.entries(h.povs).map(([name, pov]) => `[DM → ${name}]: ${pov}`).join('\n\n');
      }
      return `[DM]: ${h.content}`;
    } else if (h.type === 'gm_nudge') {
      return `[GM INSTRUCTION]: ${h.content}`;
    } else if (h.type === 'combat_turn') {
      // Combat beats never reach the live prompt (buildConversationMessages skips
      // them: they carry no `role`), but they belong in the long-term summary.
      return `[COMBAT${h.unitName ? ` — ${h.unitName}` : ''}]: ${h.content}`;
    } else if (h.hidden || h.type === 'context') {
      return ''; // Skip hidden context
    }
    return `${h.role}: ${h.content}`;
  }).filter(t => t).join('\n\n');

  const characterNames = characters.map(c => c.character_name).join(', ') || 'the party';

  const compactPrompt = `You are creating a STRUCTURED SUMMARY of a D&D adventure for continuity purposes.
This summary will be used to maintain context in future sessions, so accuracy and completeness are critical.

PLAYER CHARACTERS: ${characterNames}

${existingSummary ? `=== EXISTING SUMMARY (update and expand this) ===\n${existingSummary}\n\n` : ''}=== RECENT EVENTS TO INCORPORATE ===
${historyText}

=== OUTPUT FORMAT (use this EXACT structure) ===

## STORY SO FAR
[2-4 paragraphs summarizing the overall plot progression, major events, and narrative arc]

## CURRENT SITUATION
[1-2 paragraphs: Where is the party RIGHT NOW? What were they just doing? What immediate situation are they in?]

## ACTIVE QUESTS & OBJECTIVES
- List any active quests or goals for the party

## KEY NPCs ENCOUNTERED
[For each important NPC:]
- **NPC Name**: Who they are, relationship to party (friendly/hostile/neutral), last known status/location

## IMPORTANT DISCOVERIES
- Key items found, secrets learned, locations discovered
- Any plot-relevant information the party has learned

## UNRESOLVED THREADS
- Mysteries or questions left unanswered
- Enemies that escaped or threats that remain
- Promises made, debts owed, loose ends

## PARTY STATUS NOTES
- Any ongoing conditions, curses, blessings affecting the party
- Resources gained or lost (if narratively significant)
- Reputation changes with factions
- Identity continuity: aliases, disguises, false identities, secret identities, public names, and who knows each truth

=== INSTRUCTIONS ===
1. Be SPECIFIC with names, places, and details - vague summaries lose critical context
2. If updating an existing summary, MERGE the information - don't just append
3. Keep the most recent events in CURRENT SITUATION section
4. Remove outdated information (completed quests, dead NPCs, resolved threads)
5. Prioritize information the AI will need to maintain story consistency
6. Preserve identity/alias/disguise continuity explicitly; if one person is masquerading as another name, state that relationship clearly

Generate the structured summary now:`;

  console.log('=== Compacting History ===');
  console.log(`Previous summary length: ${existingSummary?.length || 0} chars`);
  console.log(`History entries to compact: ${history.length}`);

  try {
    // Use aiService.callAI to support both OpenAI and Anthropic providers
    const { callAI } = require('./aiService');
    const data = await callAI(apiConfig, [{ role: 'user', content: compactPrompt }], { maxTokens: 4000 });
    const summary = extractAIMessage(data);

    if (!summary) {
      console.error('Compaction failed - no summary extracted');
      return existingSummary + '\n\n[Compaction failed - could not parse response]';
    }

    console.log(`New summary length: ${summary.length} chars`);
    return summary;

  } catch (error) {
    console.error('Compaction error:', error);
    return existingSummary + `\n\n[Compaction failed - ${error.message}]`;
  }
}

/**
 * Build the AI-facing conversation messages array from stored recent-history entries.
 * This is the SINGLE source of truth for both the real AI send and the compaction token
 * count — it maps stored entries (which carry `povs` rewrites and metadata the model never
 * sees) down to the content-only user/assistant messages actually sent. When the window ends
 * on user content, a trailing "Narrate the outcome..." instruction is appended (as in a live
 * turn); when it ends on an assistant entry, nothing is appended.
 * @param {Array} recentHistory - Stored history entries (already sliced past compacted_count)
 * @returns {Array<{role:string, content:string}>} conversation messages (no system prompt)
 */
function buildConversationMessages(recentHistory) {
  const aiMessages = [];
  let currentUserContent = [];

  for (const entry of recentHistory) {
    if (entry.role === 'assistant') {
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
      } else if (entry.type === 'gm_nudge') {
        currentUserContent.push(`[GM INSTRUCTION - DO NOT REVEAL THIS TO PLAYERS]: ${entry.content}`);
      } else {
        currentUserContent.push(entry.content);
      }
    }
  }

  // Flush remaining user content
  if (currentUserContent.length > 0) {
    currentUserContent.push(`Narrate the outcome of these actions in 3rd person in no more than ${NARRATION_WORD_LIMIT} words. Output story prose only and end cleanly at the next player decision point.`);
    aiMessages.push({ role: 'user', content: currentUserContent.join('\n\n') });
  }

  return aiMessages;
}

/**
 * Estimate the tokens of the ACTUAL outgoing prompt payload (conversation content + story
 * summary) — NOT the stored history entries. Stored entries carry per-character `povs`
 * rewrites plus metadata (`type`, `hidden`, `character_id`, `player_name`) that are never
 * sent to the model, so counting them inflated the trigger signal ~(1+N)x with N players and
 * made compactions fire more and more often. This measures content only, the correct signal.
 * @param {Array} recentHistory - Stored history entries (sliced past compacted_count)
 * @param {string} storySummary - Current story summary (injected into the system prompt)
 * @returns {number} estimated prompt tokens
 */
function estimatePromptTokens(recentHistory, storySummary) {
  return estimateTokens(JSON.stringify(buildConversationMessages(recentHistory)))
    + estimateTokens(storySummary || '');
}

/**
 * PURE compaction decision logic — no DB, no AI. Decides whether to compact and how, always
 * keeping a tail of COMPACT_TAIL most-recent raw entries so the next turn does not immediately
 * re-cross the threshold from ~nothing.
 * @param {Array} fullHistory - The complete stored history
 * @param {number} compactedCount - Index up to which history is already summarized
 * @param {string} storySummary - Current story summary
 * @param {number} maxTokens - Compaction trigger threshold in tokens
 * @returns {{shouldCompact:boolean, tokens:number, mode?:string, toCompact?:Array, newCompactedCount?:number}}
 */
function planCompaction(fullHistory, compactedCount, storySummary, maxTokens) {
  const recent = fullHistory.slice(compactedCount);
  const tokens = estimatePromptTokens(recent, storySummary);

  const shouldCompact = tokens > maxTokens && recent.length >= MIN_MESSAGES_BEFORE_COMPACT;
  if (!shouldCompact) {
    return { shouldCompact: false, tokens };
  }

  // Keep a tail of raw entries; only summarize what precedes it.
  const toCompact = fullHistory.slice(compactedCount, -COMPACT_TAIL);
  if (toCompact.length === 0) {
    // Everything beyond the tail is already compacted — nothing left to summarize.
    return { shouldCompact: false, tokens };
  }

  if (toCompact.length > 50) {
    // Progressive: history is very long, compact only the first 25 this turn.
    return {
      shouldCompact: true,
      tokens,
      mode: 'progressive',
      toCompact: toCompact.slice(0, 25),
      newCompactedCount: compactedCount + 25
    };
  }

  // Normal compaction: summarize everything up to the retained tail.
  return {
    shouldCompact: true,
    tokens,
    mode: 'normal',
    toCompact,
    newCompactedCount: fullHistory.length - COMPACT_TAIL
  };
}

/**
 * Core AI turn processor — shared implementation behind processAITurn (non-streaming)
 * and streamAITurn (SSE streaming). The two paths are identical except for how the AI
 * response is acquired (single call vs streamed chunks) and cosmetic debug-log strings.
 * The `options.stream` flag selects the path.
 * @param {Object} deps - Dependencies
 * @param {Object} deps.db - Database instance
 * @param {Object} deps.io - Socket.IO instance
 * @param {Object} deps.aiService - AI service (extractAIMessage; callAIStream + detectProvider for streaming)
 * @param {Object} deps.tagParser - Tag parser service
 * @param {Function} deps.getApiConfigForRole - Get narrator or agent API config
 * @param {string} deps.DEFAULT_SYSTEM_PROMPT - Default DM system prompt
 * @param {Set} deps.processingSessions - Sessions currently being processed
 * @param {Function} deps.parseAcEffects - AC effects parser
 * @param {Function} deps.calculateTotalAC - AC calculator
 * @param {Function} deps.updateCharacterAC - AC updater (takes db, charId, acEffects)
 * @param {Function} deps.applyAllTags - Tag applicator function
 * @param {string} sessionId - Session ID
 * @param {Array} pendingActions - Pending actions
 * @param {Array} characters - Session characters
 * @param {Object} [options] - Options
 * @param {boolean} [options.stream=false] - Stream the AI response via SSE chunks
 * @returns {Promise<Object>} Result with response and token count
 */
async function runAITurn(deps, sessionId, pendingActions, characters, options = {}) {
  const stream = options.stream === true;
  const {
    db, io, aiService, tagParser,
    getActiveApiConfig, getApiConfigForRole, DEFAULT_SYSTEM_PROMPT,
    processingSessions, parseAcEffects, calculateTotalAC, updateCharacterAC,
    emitToSession,
    emitCharacterUpdate,
    applyAllTags
  } = deps;
  const { extractAIMessage, callAIStream, detectProvider, extractFinishReason, isLengthFinish, buildContinuationMessages } = aiService;
  const { findCharacterByName } = tagParser;
  const sendToSession = typeof emitToSession === 'function'
    ? emitToSession
    : (id, event, payload) => io.emit(event, payload);

  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);
  const narratorConfig = getApiConfigForRole ? getApiConfigForRole('narrator') : getActiveApiConfig();
  const agentConfig = getApiConfigForRole ? getApiConfigForRole('agent') : getActiveApiConfig();
  const povConfig = getApiConfigForRole ? getApiConfigForRole('pov') : getActiveApiConfig();
  if (!narratorConfig?.api_key) throw new Error('No narrator API configuration. Choose one in Settings.');
  if (!agentConfig?.api_key) throw new Error('No agent API configuration. Choose one in Settings.');
  if (!povConfig?.api_key) throw new Error('No POV API configuration. Choose one in Settings.');

  // Get general settings
  const settings = {};
  db.prepare('SELECT key, value FROM settings').all().forEach(row => settings[row.key] = row.value);

  let fullHistory = JSON.parse(session.full_history || '[]');
  const compactedCount = session.compacted_count || 0;

  // Build character info
  const characterInfo = characters.map(c => {
    let classDisplay = `${c.class} ${c.level}`;
    try {
      const classes = JSON.parse(c.classes || '{}');
      if (Object.keys(classes).length > 0) {
        classDisplay = Object.entries(classes).map(([cls, lvl]) => `${cls} ${lvl}`).join(' / ');
      }
    } catch (e) {}

    const acEffects = parseAcEffects(c.ac_effects);
    let acDisplay = `${c.ac || 10} (${acEffects.base_source}: ${acEffects.base_value}`;
    if (acEffects.effects.length > 0) {
      const effectsStr = acEffects.effects.map(e => `${e.name}: +${e.value}`).join(', ');
      acDisplay += ` + ${effectsStr}`;
    }
    acDisplay += ')';

    // Parse inventory for display
    let inventoryDisplay = '';
    try {
      const inv = JSON.parse(c.inventory || '[]');
      if (inv.length > 0) {
        inventoryDisplay = inv.map(i => i.quantity > 1 ? `${i.name} x${i.quantity}` : i.name).join(', ');
      }
    } catch (e) {}

    let info = `${c.character_name} (${c.race} ${classDisplay}, played by ${c.player_name}):\n`;
    info += `  Stats: STR:${c.strength} DEX:${c.dexterity} CON:${c.constitution} INT:${c.intelligence} WIS:${c.wisdom} CHA:${c.charisma}\n`;
    info += `  HP: ${c.hp}/${c.max_hp}, AC: ${acDisplay}, Gold: ${c.gold || 0}`;
    if (c.inspiration_points !== undefined) info += `, Inspiration: ${c.inspiration_points}`;
    if (inventoryDisplay) info += `\n  Inventory: ${inventoryDisplay}`;
    if (c.appearance) info += `\n  Appearance: ${c.appearance}`;
    if (c.backstory) info += `\n  Backstory: ${c.backstory}`;
    if (c.skills) info += `\n  Skills: ${c.skills}`;
    if (c.spells) info += `\n  Spells: ${c.spells}`;
    if (c.passives) info += `\n  Passives: ${c.passives}`;
    if (c.class_features) info += `\n  Class Features: ${c.class_features}`;
    if (c.feats) info += `\n  Feats: ${c.feats}`;
    if (c.class_resources && c.class_resources !== '{}') info += `\n  Rules Resources: ${c.class_resources}`;
    return info;
  }).join('\n\n');

  // Build action summary
  const actionSummary = pendingActions.map(pa => {
    const char = characters.find(c => c.id === pa.character_id);
    return `${char ? char.character_name : 'Unknown'}: ${pa.action}`;
  }).join('\n');
  const resolverPartyState = `${characterInfo}\n\nCURRENT MECHANICAL RESOURCES:\n${characters.map(character =>
    `- ${character.character_name}: XP ${character.xp || 0}, Spell slots ${character.spell_slots || '{}'}, Inspiration ${character.inspiration_points ?? 0}`
  ).join('\n')}`;

  // Store character context as hidden system context
  fullHistory.push({
    role: 'user',
    content: characterInfo,
    type: 'context',
    hidden: true
  });

  if (options.combatConclusion) {
    fullHistory.push({
      role: 'user',
      content: `AUTHORITATIVE COMBAT RESULT:\n${options.combatConclusion.summary}`,
      type: 'combat_result',
      hidden: true
    });
  } else {
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
  }

  // Build messages array for AI - only send messages after compacted_count
  let recentHistory = fullHistory.slice(compactedCount);

  // Safety net: If compacted_count is stale
  if (recentHistory.length === 0 && fullHistory.length > 0) {
    const fallbackCount = Math.min(10, fullHistory.length);
    recentHistory = fullHistory.slice(-fallbackCount);
    console.warn(`Safety fallback: compacted_count (${compactedCount}) exceeded history length (${fullHistory.length}). Using last ${fallbackCount} messages.`);
  }

  let turnResolution;
  if (options.combatConclusion) {
    turnResolution = {
      resolution: [
        options.combatConclusion.openingResolution,
        options.combatConclusion.summary,
        'Portray the submitted player actions as the cause of the encounter and the combat result as authoritative. Do not replay the battle blow by blow; narrate its decisive ending and immediate aftermath.'
      ].filter(Boolean).join('\n\n'),
      stateTags: '',
      combat: null
    };
  } else {
    const recentResolverContext = buildConversationMessages(recentHistory.slice(-12))
      .map(message => `${message.role.toUpperCase()}: ${message.content}`)
      .join('\n\n');
    turnResolution = await aiService.generateTurnResolution(agentConfig, {
      actions: actionSummary,
      partyState: resolverPartyState,
      storySummary: session.story_summary || '',
      recentContext: recentResolverContext
    });
  }
  const automaticCombatSetup = normalizeAutoCombatSetup(turnResolution?.combat);

  if (automaticCombatSetup) {
    try {
      const characterStates = characters.map(character => ({
        id: character.id,
        hp: character.hp,
        max_hp: character.max_hp,
        ac: character.ac,
        xp: character.xp,
        gold: character.gold,
        inventory: character.inventory,
        spell_slots: character.spell_slots,
        ac_effects: character.ac_effects,
        inspiration_points: character.inspiration_points
      }));
      db.prepare('INSERT INTO game_snapshots (id, session_id, turn_number, character_states) VALUES (?, ?, ?, ?)')
        .run(uuidv4(), sessionId, session.current_turn, JSON.stringify(characterStates));
    } catch (snapshotError) {
      logger.warn('Unable to snapshot the pre-combat turn', { sessionId, error: snapshotError.message });
    }

    applyAllTags({
      db, io, tagParser, parseAcEffects, calculateTotalAC, updateCharacterAC, emitCharacterUpdate
    }, turnResolution?.stateTags || '', characters, sessionId);

    const currentCharacters = db.prepare(`
      SELECT c.* FROM characters c
      INNER JOIN session_characters sc ON sc.character_id = c.id
      WHERE sc.session_id = ? AND c.hp > 0
      ORDER BY c.created_at DESC
    `).all(sessionId);
    if (!currentCharacters.length) throw new Error('The party has no conscious combatants.');

    const state = combatService.createCombat({
      name: automaticCombatSetup.name,
      environment: automaticCombatSetup.environment,
      characters: currentCharacters,
      enemies: automaticCombatSetup.enemies
    });
    state.deferredTurn = {
      openingResolution: turnResolution?.resolution || '',
      startedAt: new Date().toISOString()
    };
    const combat = {
      id: uuidv4(),
      session_id: sessionId,
      name: automaticCombatSetup.name,
      is_active: 1,
      current_turn: state.turnIndex,
      round: state.round,
      created_at: new Date().toISOString()
    };
    db.prepare('INSERT INTO combats (id, session_id, name, is_active, current_turn, round, combatants) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(combat.id, sessionId, combat.name, 1, state.turnIndex, state.round, combatService.serialize(state));
    const updateCombatHp = db.prepare('UPDATE characters SET hp = ? WHERE id = ?');
    for (const unit of state.units) {
      if (unit.side !== 'party' || !unit.sourceCharacterId) continue;
      updateCombatHp.run(unit.hp, unit.sourceCharacterId);
      const updatedCharacter = db.prepare('SELECT * FROM characters WHERE id = ?').get(unit.sourceCharacterId);
      if (updatedCharacter) emitCharacterUpdate(unit.sourceCharacterId, 'character_updated', updatedCharacter);
    }
    // Visible "the fight is on" beat. Carries no `role`, so it never reaches the
    // narrator prompt and never bumps current_turn.
    fullHistory.push(combatIntegration.buildCombatHistoryEntry({
      content: `Combat begins: ${state.name}. Every player rolls a d20 for initiative.`,
      unitName: '',
      round: state.round
    }));

    const promptTokens = estimatePromptTokens(fullHistory.slice(compactedCount), session.story_summary || '');
    db.prepare('UPDATE game_sessions SET full_history = ?, total_tokens = ? WHERE id = ?')
      .run(JSON.stringify(fullHistory), promptTokens, sessionId);
    db.prepare('DELETE FROM pending_actions WHERE session_id = ?').run(sessionId);

    const payload = { ...combat, state: combatIntegration.publicCombatState(state) };
    // `combat_updated` MUST go first. `turn_processed` makes the client reload
    // the session, which renders the tracker and populates `activeCombat`; a
    // later `combat_updated` would then see a previous state and swallow the
    // "roll for initiative!" toast (its `automatic && !previous` guard).
    sendToSession(sessionId, 'combat_updated', combatIntegration.buildCombatUpdatedPayload({
      sessionId,
      combatId: combat.id,
      state,
      events: state.log,
      automatic: true
    }));
    sendToSession(sessionId, 'turn_processed', {
      sessionId,
      response: '',
      turn: session.current_turn,
      tokensUsed: promptTokens,
      compacted: false,
      choices: [],
      combatPending: true
    });
    logger.info('Deferred narration and started narrative combat', { sessionId, combatId: combat.id, enemies: automaticCombatSetup.enemies.length });
    return { response: '', tokensUsed: promptTokens, combat: payload, deferredNarration: true };
  }

  // Convert stored history to AI-compatible format (single source of truth shared with the
  // compaction token count, so the trigger measures the same payload we actually send).
  const aiMessages = buildConversationMessages(recentHistory);
  if (turnResolution?.resolution && aiMessages.length > 0) {
    aiMessages[aiMessages.length - 1].content += `\n\nAUTHORITATIVE TURN RESOLUTION FROM THE RULES AGENT:\n${turnResolution.resolution}\n\nRender this resolution faithfully as story prose. Do not alter its outcomes or add mechanical tags.`;
  }

  const messages = [
    { role: 'system', content: DEFAULT_SYSTEM_PROMPT + (session.story_summary ? `\n\nSTORY SO FAR:\n${session.story_summary}` : '') },
    ...aiMessages,
    // No assistant prefill — Anthropic rejects trailing whitespace and it adds unnecessary tokens
  ];

  // Debug logging
  if (stream) {
    // Check if the provider/endpoint supports streaming
    // For now, we assume all providers support streaming
    const provider = detectProvider ? detectProvider(narratorConfig.endpoint) : 'openai';
    console.log('=== AI Stream Request Debug ===');
    console.log(`Provider: ${provider}`);
    console.log(`Compacted count: ${compactedCount}`);
    console.log(`Full history length: ${fullHistory.length}`);
    console.log(`Recent history length (sent to AI): ${recentHistory.length}`);
    console.log(`Total messages to AI: ${messages.length}`);
  } else {
    console.log('=== AI Request Debug ===');
    console.log(`Compacted count: ${compactedCount}`);
    console.log(`Full history length: ${fullHistory.length}`);
    console.log(`Recent history length (sent to AI): ${recentHistory.length}`);
    console.log(`Has story summary: ${!!session.story_summary}`);
    if (session.story_summary) {
      console.log(`Story summary length: ${session.story_summary.length} chars`);
    }
    console.log(`Total messages to AI: ${messages.length} (1 system + ${aiMessages.length} conversation)`);
  }

  // Acquire the AI response (streamed chunk-by-chunk, or a single non-streaming call)
  let aiResponse;
  if (stream) {
    // Stream the AI response
    aiResponse = '';
    try {
      const meta = {};
      for await (const chunk of callAIStream(narratorConfig, messages, { maxTokens: NARRATION_MAX_TOKENS, meta })) {
        aiResponse += chunk;
        // Emit each chunk to clients for real-time display
        sendToSession(sessionId, 'turn_chunk', { sessionId, text: chunk });
      }

      let guard = 0;
      const provider = detectProvider ? detectProvider(narratorConfig.endpoint) : 'openai';
      while (isLengthFinish(meta.finishReason) && aiResponse && guard < 2) {
        guard++;
        console.warn(`Narration hit token cap (finish_reason=${meta.finishReason}); continuing (${guard}/2)...`);
        const contMeta = {};
        for await (const chunk of callAIStream(narratorConfig, buildContinuationMessages(messages, aiResponse, provider), { maxTokens: NARRATION_CONTINUATION_MAX_TOKENS, meta: contMeta })) {
          aiResponse += chunk;
          sendToSession(sessionId, 'turn_chunk', { sessionId, text: chunk });
        }
        meta.finishReason = contMeta.finishReason;
      }
    } catch (streamError) {
      console.error('Stream error:', streamError);
      throw new Error(`AI Streaming Error: ${streamError.message}`);
    }

    if (!aiResponse) {
      throw new Error('AI returned empty streaming response.');
    }

    // No prefix stripping needed — prefill removed
  } else {
    // Call AI API (supports both OpenAI and Anthropic via aiService)
    const { callAI } = require('./aiService');
    const data = await callAI(narratorConfig, messages, { maxTokens: NARRATION_MAX_TOKENS, timeoutMs: 300000 });
    aiResponse = extractAIMessage(data);

    if (!aiResponse) {
      console.log('Failed to extract AI response:', JSON.stringify(data, null, 2));
      throw new Error('Could not parse AI response. Check server logs.');
    }

    let finish = extractFinishReason(data);
    let guard = 0;
    const provider = detectProvider ? detectProvider(narratorConfig.endpoint) : 'openai';
    while (isLengthFinish(finish) && aiResponse && guard < 2) {
      guard++;
      console.warn(`Narration hit token cap (finish_reason=${finish}); continuing (${guard}/2)...`);
      const contData = await callAI(narratorConfig, buildContinuationMessages(messages, aiResponse, provider), { maxTokens: NARRATION_CONTINUATION_MAX_TOKENS, timeoutMs: 300000 });
      const contText = extractAIMessage(contData);
      if (!contText || !contText.trim()) break;
      aiResponse += contText;
      finish = extractFinishReason(contData);
    }
  }

  // Choices come from the agent pass; keep this empty unless that pass succeeds.
  let parsedChoices = [];

  // Strip CHOICE tags from the narration stored in history. The narrator no longer emits
  // tracking tags (the bookkeeper does), but defensively strip any stray ones too so a model
  // slip never surfaces raw brackets to players or pollutes the stored/re-sent narration.
  const cleanedResponse = aiResponse
    .replace(/\[CHOICE:\s*[^\]]+\]/gi, '')
    .replace(/\[(HP|XP|MONEY|GOLD|ITEM|SPELL|AC|REST):[^\]]*\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Generate suggested actions and per-character POVs from the finished narration. If the
  // pre-narration resolver failed, the legacy bookkeeper pass recovers state tags here.
  const {
    generateCharacterPOV,
    generateStateTags,
    buildPOVPartyRoster,
    buildPOVCampaignContext,
    generateYoutubeDJPick,
    generateSceneChoices
  } = require('./aiService');
  let parsedPOVs = {};
  let stateTags = turnResolution?.stateTags || '';
  let previousMusic = {};
  try { previousMusic = JSON.parse(session.music_state || '{}'); } catch (error) { previousMusic = {}; }
  const musicEnabled = settings.youtube_dj_enabled === 'true' && settings.youtube_api_key;
  const musicPickPromise = musicEnabled
    ? generateYoutubeDJPick(agentConfig, cleanedResponse, previousMusic.query || '')
    : Promise.resolve(null);
  if (characters.length > 0) {
    if (stream) {
      console.log(`Converting streamed scene to POV for ${characters.length} characters...`);
    } else {
      console.log(`Converting scene to POV for ${characters.length} characters...`);
    }

    const storySummary = session.story_summary || '';
    const povCampaignContext = buildPOVCampaignContext(fullHistory);

    // Compact party-state line used only by the fallback post-scene bookkeeper.
    const bookkeeperState = characters.map(c => {
      let inv = '';
      try {
        const arr = JSON.parse(c.inventory || '[]');
        inv = arr.map(i => (i.quantity > 1 ? `${i.name} x${i.quantity}` : i.name)).join(', ');
      } catch (e) {}
      return `- ${c.character_name}: HP ${c.hp}/${c.max_hp}, Gold ${c.gold || 0}${inv ? `, Inventory: ${inv}` : ''}`;
    }).join('\n');

    const [tagResult, choiceResult, povResults] = await Promise.all([
      turnResolution ? Promise.resolve(turnResolution.stateTags) : generateStateTags(agentConfig, cleanedResponse, bookkeeperState),
      automaticCombatSetup ? Promise.resolve('') : generateSceneChoices(agentConfig, cleanedResponse, characters),
      Promise.all(characters.map(async (c) => {
        const partyRoster = buildPOVPartyRoster(characters, c);
        const pov = await generateCharacterPOV(povConfig, c, cleanedResponse, partyRoster, storySummary, povCampaignContext);
        return pov ? { name: c.character_name, pov } : null;
      }))
    ]);

    stateTags = tagResult || '';
    parsedChoices = tagParser.parseChoices ? tagParser.parseChoices(choiceResult || '', characters) : [];
    for (const result of povResults) {
      if (result) parsedPOVs[result.name] = result.pov;
    }
    console.log(`POV conversion complete: ${Object.keys(parsedPOVs).length}/${characters.length} characters`);
    console.log(`State tags: ${stateTags ? stateTags.replace(/\n/g, ' | ') : '(none)'}`);
  }
  const hasPOVs = Object.keys(parsedPOVs).length > 0;
  let musicState = previousMusic;
  const musicPick = await musicPickPromise;
  if (musicPick) {
    try {
      const [track] = await searchYoutubeMusic(settings.youtube_api_key, musicPick.query);
      if (track) {
        musicState = {
          videoId: track.videoId,
          title: track.title,
          channel: track.channel,
          thumbnail: track.thumbnail,
          query: musicPick.query,
          mood: musicPick.mood,
          startedAt: new Date().toISOString()
        };
      }
    } catch (error) {
      logger.warn('YouTube DJ search failed', { sessionId, error: error.message });
    }
  }

  // Build history entry with POVs attached
  const historyEntry = { role: 'assistant', content: cleanedResponse, type: 'narration' };
  if (hasPOVs) {
    historyEntry.povs = parsedPOVs;
  }
  // Persist the bookkeeper's tags on the entry (like povs, never sent to the model): the
  // narration itself is now tag-free, so the admin "recalculate from history" endpoints read
  // the state changes from here. Older entries (pre-bookkeeper) still carry tags in content.
  if (stateTags) {
    historyEntry.stateTags = stateTags;
  }
  fullHistory.push(historyEntry);

  // The combat-trigger branch already saved the pre-turn snapshot. Preserve that
  // snapshot so rerolling an aftermath restores the state from before initiative.
  if (!options.combatConclusion) {
    try {
      const characterStates = characters.map(c => ({
        id: c.id,
        hp: c.hp, max_hp: c.max_hp, ac: c.ac,
        xp: c.xp, gold: c.gold,
        inventory: c.inventory,
        spell_slots: c.spell_slots,
        ac_effects: c.ac_effects,
        inspiration_points: c.inspiration_points
      }));
      db.prepare('INSERT INTO game_snapshots (id, session_id, turn_number, character_states) VALUES (?, ?, ?, ?)')
        .run(uuidv4(), sessionId, session.current_turn, JSON.stringify(characterStates));
      console.log(`Snapshot saved for session ${sessionId}, turn ${session.current_turn}`);
    } catch (snapshotError) {
      console.error('Failed to save game snapshot:', snapshotError.message);
    }
  }

  // Apply the rules agent's state-change tags (the narrator never emits them inline).
  console.log(stream ? '=== AI Stream Response complete ===' : '=== AI Response received ===');
  console.log('Applying bookkeeper state tags...');

  const tagApplicatorDeps = {
    db, io, tagParser, parseAcEffects, calculateTotalAC, updateCharacterAC, emitCharacterUpdate
  };
  applyAllTags(tagApplicatorDeps, stateTags, characters, sessionId);

  // Update session — decide compaction from the ACTUAL outgoing prompt tokens (content only),
  // keeping a raw tail so the gap between summarizations does not vanish.
  const maxTokens = parseInt(settings.max_tokens_before_compact) || DEFAULT_MAX_TOKENS_BEFORE_COMPACT;
  const plan = planCompaction(fullHistory, compactedCount, session.story_summary, maxTokens);
  const recentHistoryTokens = plan.tokens;
  let newSummary = session.story_summary;
  let newCompactedCount = compactedCount;

  console.log(`Token check: promptTokens=${plan.tokens}, maxTokens=${maxTokens}, recentEntries=${fullHistory.length - compactedCount}, shouldCompact=${plan.shouldCompact}`);

  if (plan.shouldCompact) {
    console.log(`Compacting history (mode=${plan.mode}, keeping tail of ${COMPACT_TAIL})...`);
    if (plan.mode === 'progressive') {
      const chunkSummary = await compactHistory(agentConfig, '', plan.toCompact, characters, extractAIMessage);
      newSummary = await compactHistory(agentConfig, session.story_summary,
        [{ role: 'assistant', content: chunkSummary }], characters, extractAIMessage);
    } else {
      newSummary = await compactHistory(agentConfig, session.story_summary, plan.toCompact, characters, extractAIMessage);
    }
    newCompactedCount = plan.newCompactedCount;

    if (newSummary && newSummary.length > MAX_SUMMARY_CHARS) {
      console.log(`Summary too long (${newSummary.length} chars), performing recursive summarization`);
      newSummary = await compactHistory(agentConfig, '',
        [{ role: 'assistant', content: newSummary }], characters, extractAIMessage);
    }

    db.prepare('UPDATE game_sessions SET story_summary = ?, full_history = ?, compacted_count = ?, total_tokens = 0, music_state = ?, current_turn = current_turn + 1 WHERE id = ?')
      .run(newSummary, JSON.stringify(fullHistory), newCompactedCount, JSON.stringify(musicState), sessionId);
  } else {
    db.prepare('UPDATE game_sessions SET full_history = ?, total_tokens = ?, music_state = ?, current_turn = current_turn + 1 WHERE id = ?')
      .run(JSON.stringify(fullHistory), recentHistoryTokens, JSON.stringify(musicState), sessionId);
  }

  // Clear pending actions
  db.prepare('DELETE FROM pending_actions WHERE session_id = ?').run(sessionId);

  // Emit update to all clients
  sendToSession(sessionId, 'turn_processed', {
    sessionId,
    response: cleanedResponse,
    turn: session.current_turn + 1,
    tokensUsed: recentHistoryTokens,
    compacted: plan.shouldCompact,
    choices: parsedChoices,
    povs: hasPOVs ? parsedPOVs : null
  });
  try {
    queueAutoPOVScenes({
      db,
      aiService,
      sessionId,
      index: fullHistory.length - 1,
      characters,
      aiConfig: agentConfig,
      sendToSession
    });
    if (musicPick && musicState.videoId) {
      sendToSession(sessionId, 'music_updated', { sessionId, music: musicState });
    }
  } catch (error) {
    logger.error('Optional post-turn work failed after narration was committed', { sessionId, error: error.message });
  }

  return { response: cleanedResponse, tokensUsed: recentHistoryTokens, combat: null };
}

/**
 * Process an AI turn for a game session (non-streaming).
 * Thin wrapper over runAITurn — signature preserved for index.js.
 * @param {Object} deps - Dependencies (see runAITurn)
 * @param {string} sessionId - Session ID
 * @param {Array} pendingActions - Pending actions
 * @param {Array} characters - Session characters
 * @returns {Promise<Object>} Result with response and token count
 */
function processAITurn(deps, sessionId, pendingActions, characters) {
  return runAITurn(deps, sessionId, pendingActions, characters, { stream: false });
}

/**
 * Process an AI turn with SSE streaming - sends chunks to clients in real-time.
 * Same logic as processAITurn but uses streaming for the AI API call.
 * Thin wrapper over runAITurn — signature preserved for index.js.
 * @param {Object} deps - Dependencies (same as processAITurn + deps.aiService.callAIStream)
 * @param {string} sessionId - Session ID
 * @param {Array} pendingActions - Pending actions
 * @param {Array} characters - Session characters
 * @returns {Promise<Object>} Result with response and token count
 */
function streamAITurn(deps, sessionId, pendingActions, characters) {
  return runAITurn(deps, sessionId, pendingActions, characters, { stream: true });
}

function completeCombatTurn(deps, sessionId, characters, combatConclusion, options = {}) {
  return runAITurn(deps, sessionId, [], characters, {
    stream: options.stream === true,
    combatConclusion
  });
}

module.exports = {
  processAITurn,
  streamAITurn,
  completeCombatTurn,
  compactHistory,
  estimateTokens,
  // Pure, testable compaction helpers (U2.2)
  buildConversationMessages,
  estimatePromptTokens,
  didTurnCommit,
  planCompaction,
  // Tuning constants (exported for tests)
  COMPACT_TAIL,
  MIN_MESSAGES_BEFORE_COMPACT,
  DEFAULT_MAX_TOKENS_BEFORE_COMPACT,
  MAX_SUMMARY_CHARS
};
