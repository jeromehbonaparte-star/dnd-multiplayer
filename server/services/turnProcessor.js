/**
 * Turn Processor Service
 * Handles AI turn processing, history compaction, token estimation, and game snapshots
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../lib/logger');

/**
 * Estimate token count for text (rough approximation: ~4 chars per token)
 * @param {string} text - Text to estimate
 * @returns {number} Estimated token count
 */
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Compact history into a structured summary using AI
 * @param {Object} apiConfig - Active API config {api_endpoint, api_key, api_model}
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

=== INSTRUCTIONS ===
1. Be SPECIFIC with names, places, and details - vague summaries lose critical context
2. If updating an existing summary, MERGE the information - don't just append
3. Keep the most recent events in CURRENT SITUATION section
4. Remove outdated information (completed quests, dead NPCs, resolved threads)
5. Prioritize information the AI will need to maintain story consistency

Generate the structured summary now:`;

  console.log('=== Compacting History ===');
  console.log(`Previous summary length: ${existingSummary?.length || 0} chars`);
  console.log(`History entries to compact: ${history.length}`);

  try {
    // Use aiService.callAI to support both OpenAI and Anthropic providers
    const { callAI } = require('./aiService');
    const config = {
      endpoint: apiConfig.api_endpoint,
      api_key: apiConfig.api_key,
      model: apiConfig.api_model
    };
    const data = await callAI(config, [{ role: 'user', content: compactPrompt }], { maxTokens: 4000 });
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
 * Process an AI turn for a game session
 * @param {Object} deps - Dependencies
 * @param {Object} deps.db - Database instance
 * @param {Object} deps.io - Socket.IO instance
 * @param {Object} deps.aiService - AI service (extractAIMessage)
 * @param {Object} deps.tagParser - Tag parser service
 * @param {Function} deps.getActiveApiConfig - Get active API config
 * @param {string} deps.DEFAULT_SYSTEM_PROMPT - Default DM system prompt
 * @param {string} deps.AI_RESPONSE_PREFIX - Response prefix to strip
 * @param {Set} deps.processingSessions - Sessions currently being processed
 * @param {Function} deps.parseAcEffects - AC effects parser
 * @param {Function} deps.calculateTotalAC - AC calculator
 * @param {Function} deps.updateCharacterAC - AC updater (takes db, charId, acEffects)
 * @param {Function} deps.applyAllTags - Tag applicator function
 * @param {string} sessionId - Session ID
 * @param {Array} pendingActions - Pending actions
 * @param {Array} characters - Session characters
 * @returns {Promise<Object>} Result with response and token count
 */
async function processAITurn(deps, sessionId, pendingActions, characters) {
  const {
    db, io, aiService, tagParser,
    getActiveApiConfig, DEFAULT_SYSTEM_PROMPT, AI_RESPONSE_PREFIX,
    processingSessions, parseAcEffects, calculateTotalAC, updateCharacterAC,
    applyAllTags
  } = deps;
  const { extractAIMessage } = aiService;
  const { findCharacterByName } = tagParser;

  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);
  const apiConfig = getActiveApiConfig();
  if (!apiConfig || !apiConfig.api_key) {
    throw new Error('No active API configuration. Please add and activate one in Settings.');
  }

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
    return info;
  }).join('\n\n');

  // Build action summary
  const actionSummary = pendingActions.map(pa => {
    const char = characters.find(c => c.id === pa.character_id);
    return `${char ? char.character_name : 'Unknown'}: ${pa.action}`;
  }).join('\n');

  // Store character context as hidden system context
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
  let recentHistory = fullHistory.slice(compactedCount);

  // Safety net: If compacted_count is stale
  if (recentHistory.length === 0 && fullHistory.length > 0) {
    const fallbackCount = Math.min(10, fullHistory.length);
    recentHistory = fullHistory.slice(-fallbackCount);
    console.warn(`Safety fallback: compacted_count (${compactedCount}) exceeded history length (${fullHistory.length}). Using last ${fallbackCount} messages.`);
  }

  // Convert stored history to AI-compatible format
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
    currentUserContent.push('Narrate the outcome using [POV: CharacterName]...[/POV] blocks for each character, then [CHOICE:] tags at the end.');
    aiMessages.push({ role: 'user', content: currentUserContent.join('\n\n') });
  }

  const messages = [
    { role: 'system', content: DEFAULT_SYSTEM_PROMPT + (session.story_summary ? `\n\nSTORY SO FAR:\n${session.story_summary}` : '') },
    ...aiMessages,
    { role: 'assistant', content: AI_RESPONSE_PREFIX }
  ];

  // Debug logging
  console.log('=== AI Request Debug ===');
  console.log(`Compacted count: ${compactedCount}`);
  console.log(`Full history length: ${fullHistory.length}`);
  console.log(`Recent history length (sent to AI): ${recentHistory.length}`);
  console.log(`Has story summary: ${!!session.story_summary}`);
  if (session.story_summary) {
    console.log(`Story summary length: ${session.story_summary.length} chars`);
  }
  console.log(`Total messages to AI: ${messages.length} (1 system + ${aiMessages.length} conversation)`);

  // Call AI API (supports both OpenAI and Anthropic via aiService)
  const { callAI } = require('./aiService');
  const aiCallConfig = {
    endpoint: apiConfig.api_endpoint,
    api_key: apiConfig.api_key,
    model: apiConfig.api_model
  };
  const data = await callAI(aiCallConfig, messages, { maxTokens: 64000 });
  let aiResponse = extractAIMessage(data);

  if (!aiResponse) {
    console.log('Failed to extract AI response:', JSON.stringify(data, null, 2));
    throw new Error('Could not parse AI response. Check server logs.');
  }

  // Strip the response prefix
  const prefixTrimmed = AI_RESPONSE_PREFIX.trim();
  const responseTrimmed = aiResponse.trimStart();
  if (aiResponse.startsWith(AI_RESPONSE_PREFIX)) {
    aiResponse = aiResponse.slice(AI_RESPONSE_PREFIX.length);
  } else if (aiResponse.startsWith(prefixTrimmed)) {
    aiResponse = aiResponse.slice(prefixTrimmed.length).trimStart();
  } else if (responseTrimmed.startsWith(prefixTrimmed)) {
    aiResponse = responseTrimmed.slice(prefixTrimmed.length).trimStart();
  } else if (responseTrimmed.toLowerCase().startsWith(prefixTrimmed.toLowerCase())) {
    aiResponse = responseTrimmed.slice(prefixTrimmed.length).trimStart();
  }

  const tokensUsed = data.usage?.total_tokens || estimateTokens(JSON.stringify(messages) + aiResponse);

  // Parse choices before stripping them from the response
  const parsedChoices = tagParser.parseChoices ? tagParser.parseChoices(aiResponse, characters) : [];

  // Parse POV sections from AI response
  const parsedPOVs = tagParser.parsePOVSections ? tagParser.parsePOVSections(aiResponse, characters) : {};
  const hasPOVs = Object.keys(parsedPOVs).length > 0;
  console.log(`POV sections found: ${Object.keys(parsedPOVs).length}`, Object.keys(parsedPOVs));

  // Strip CHOICE and POV tags from the narration stored in history (they're stored separately)
  let cleanedResponse = aiResponse
    .replace(/\[CHOICE:\s*[^\]]+\]/gi, '')
    .replace(/\[POV:\s*[^\]]*\]/gi, '')
    .replace(/\[\/POV\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Build history entry with POVs attached
  const historyEntry = { role: 'assistant', content: cleanedResponse, type: 'narration' };
  if (hasPOVs) {
    historyEntry.povs = parsedPOVs;
  }
  fullHistory.push(historyEntry);

  // Snapshot character states BEFORE applying tags (for reroll restore)
  try {
    const characterStates = characters.map(c => ({
      id: c.id,
      hp: c.hp, max_hp: c.max_hp, ac: c.ac,
      xp: c.xp, gold: c.gold,
      inventory: c.inventory,
      spell_slots: c.spell_slots,
      ac_effects: c.ac_effects
    }));
    db.prepare('INSERT INTO game_snapshots (id, session_id, turn_number, character_states) VALUES (?, ?, ?, ?)')
      .run(uuidv4(), sessionId, session.current_turn, JSON.stringify(characterStates));
    console.log(`Snapshot saved for session ${sessionId}, turn ${session.current_turn}`);
  } catch (snapshotError) {
    console.error('Failed to save game snapshot:', snapshotError.message);
  }

  // Apply all tags from the AI response
  console.log('=== AI Response received ===');
  console.log('Looking for tags in response...');

  const tagApplicatorDeps = {
    db, io, tagParser, parseAcEffects, calculateTotalAC, updateCharacterAC
  };
  applyAllTags(tagApplicatorDeps, aiResponse, characters, sessionId);

  // Update session - calculate tokens based on recent history only
  const recentHistoryForTokenCount = fullHistory.slice(compactedCount);
  const recentHistoryTokens = estimateTokens(JSON.stringify(recentHistoryForTokenCount));

  const maxTokens = parseInt(settings.max_tokens_before_compact) || 8000;
  let newSummary = session.story_summary;
  let newCompactedCount = compactedCount;

  const minMessagesBeforeCompact = 4;
  const shouldCompact = recentHistoryTokens > maxTokens && recentHistoryForTokenCount.length >= minMessagesBeforeCompact;

  console.log(`Token check: recentHistoryTokens=${recentHistoryTokens}, maxTokens=${maxTokens}, messagesSinceCompact=${recentHistoryForTokenCount.length}, shouldCompact=${shouldCompact}`);

  if (shouldCompact) {
    console.log('Compacting history...');
    const recentHistoryToCompact = fullHistory.slice(compactedCount, -1);

    // Progressive: if history is very long, compact in chunks of 25
    if (recentHistoryToCompact.length > 50) {
      console.log(`Progressive compaction: ${recentHistoryToCompact.length} entries, compacting first 25`);
      const chunk = recentHistoryToCompact.slice(0, 25);
      const chunkSummary = await compactHistory(apiConfig, '', chunk, characters, extractAIMessage);

      // Merge chunk summary with existing summary
      newSummary = await compactHistory(apiConfig, session.story_summary,
        [{ role: 'assistant', content: chunkSummary }], characters, extractAIMessage);

      // Only mark the compacted chunk as compacted (not all history)
      newCompactedCount = compactedCount + 25;
    } else {
      // Normal compaction for shorter histories
      newSummary = await compactHistory(apiConfig, session.story_summary, recentHistoryToCompact, characters, extractAIMessage);
      newCompactedCount = fullHistory.length - 1;
    }

    // Cap summary length at 4000 chars
    if (newSummary && newSummary.length > 4000) {
      console.log(`Summary too long (${newSummary.length} chars), performing recursive summarization`);
      newSummary = await compactHistory(apiConfig, '',
        [{ role: 'assistant', content: newSummary }], characters, extractAIMessage);
    }

    db.prepare('UPDATE game_sessions SET story_summary = ?, full_history = ?, compacted_count = ?, total_tokens = 0, current_turn = current_turn + 1 WHERE id = ?')
      .run(newSummary, JSON.stringify(fullHistory), newCompactedCount, sessionId);
  } else {
    db.prepare('UPDATE game_sessions SET full_history = ?, total_tokens = ?, current_turn = current_turn + 1 WHERE id = ?')
      .run(JSON.stringify(fullHistory), recentHistoryTokens, sessionId);
  }

  // Clear pending actions
  db.prepare('DELETE FROM pending_actions WHERE session_id = ?').run(sessionId);

  // Emit update to all clients
  io.emit('turn_processed', {
    sessionId,
    response: cleanedResponse,
    turn: session.current_turn + 1,
    tokensUsed: recentHistoryTokens,
    compacted: shouldCompact,
    choices: parsedChoices,
    povs: hasPOVs ? parsedPOVs : null
  });

  return { response: cleanedResponse, tokensUsed: recentHistoryTokens };
}

/**
 * Process an AI turn with SSE streaming - sends chunks to clients in real-time
 * Same logic as processAITurn but uses streaming for the AI API call
 * @param {Object} deps - Dependencies (same as processAITurn + deps.aiService.callAIStream)
 * @param {string} sessionId - Session ID
 * @param {Array} pendingActions - Pending actions
 * @param {Array} characters - Session characters
 * @returns {Promise<Object>} Result with response and token count
 */
async function streamAITurn(deps, sessionId, pendingActions, characters) {
  const {
    db, io, aiService, tagParser,
    getActiveApiConfig, DEFAULT_SYSTEM_PROMPT, AI_RESPONSE_PREFIX,
    processingSessions, parseAcEffects, calculateTotalAC, updateCharacterAC,
    applyAllTags
  } = deps;
  const { extractAIMessage, callAIStream, detectProvider } = aiService;
  const { findCharacterByName } = tagParser;

  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);
  const apiConfig = getActiveApiConfig();
  if (!apiConfig || !apiConfig.api_key) {
    throw new Error('No active API configuration. Please add and activate one in Settings.');
  }

  // Check if the provider/endpoint supports streaming
  // For now, we assume all providers support streaming
  const provider = detectProvider ? detectProvider(apiConfig.api_endpoint) : 'openai';

  // Get general settings
  const settings = {};
  db.prepare('SELECT key, value FROM settings').all().forEach(row => settings[row.key] = row.value);

  let fullHistory = JSON.parse(session.full_history || '[]');
  const compactedCount = session.compacted_count || 0;

  // Build character info (same as processAITurn)
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
    return info;
  }).join('\n\n');

  // Build action summary
  const actionSummary = pendingActions.map(pa => {
    const char = characters.find(c => c.id === pa.character_id);
    return `${char ? char.character_name : 'Unknown'}: ${pa.action}`;
  }).join('\n');

  // Store character context as hidden system context
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
  let recentHistory = fullHistory.slice(compactedCount);

  // Safety net
  if (recentHistory.length === 0 && fullHistory.length > 0) {
    const fallbackCount = Math.min(10, fullHistory.length);
    recentHistory = fullHistory.slice(-fallbackCount);
    console.warn(`Safety fallback: compacted_count (${compactedCount}) exceeded history length (${fullHistory.length}). Using last ${fallbackCount} messages.`);
  }

  // Convert stored history to AI-compatible format
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
    currentUserContent.push('Narrate the outcome using [POV: CharacterName]...[/POV] blocks for each character, then [CHOICE:] tags at the end.');
    aiMessages.push({ role: 'user', content: currentUserContent.join('\n\n') });
  }

  const messages = [
    { role: 'system', content: DEFAULT_SYSTEM_PROMPT + (session.story_summary ? `\n\nSTORY SO FAR:\n${session.story_summary}` : '') },
    ...aiMessages,
    { role: 'assistant', content: AI_RESPONSE_PREFIX }
  ];

  // Debug logging
  console.log('=== AI Stream Request Debug ===');
  console.log(`Provider: ${provider}`);
  console.log(`Compacted count: ${compactedCount}`);
  console.log(`Full history length: ${fullHistory.length}`);
  console.log(`Recent history length (sent to AI): ${recentHistory.length}`);
  console.log(`Total messages to AI: ${messages.length}`);

  // Stream the AI response
  const streamConfig = {
    endpoint: apiConfig.api_endpoint,
    api_key: apiConfig.api_key,
    model: apiConfig.api_model
  };

  let aiResponse = '';
  try {
    for await (const chunk of callAIStream(streamConfig, messages, { maxTokens: 64000 })) {
      aiResponse += chunk;
      // Emit each chunk to clients for real-time display
      io.emit('turn_chunk', { sessionId, text: chunk });
    }
  } catch (streamError) {
    console.error('Stream error:', streamError);
    throw new Error(`AI Streaming Error: ${streamError.message}`);
  }

  if (!aiResponse) {
    throw new Error('AI returned empty streaming response.');
  }

  // Strip the response prefix (same logic as processAITurn)
  const prefixTrimmed = AI_RESPONSE_PREFIX.trim();
  const responseTrimmed = aiResponse.trimStart();
  if (aiResponse.startsWith(AI_RESPONSE_PREFIX)) {
    aiResponse = aiResponse.slice(AI_RESPONSE_PREFIX.length);
  } else if (aiResponse.startsWith(prefixTrimmed)) {
    aiResponse = aiResponse.slice(prefixTrimmed.length).trimStart();
  } else if (responseTrimmed.startsWith(prefixTrimmed)) {
    aiResponse = responseTrimmed.slice(prefixTrimmed.length).trimStart();
  } else if (responseTrimmed.toLowerCase().startsWith(prefixTrimmed.toLowerCase())) {
    aiResponse = responseTrimmed.slice(prefixTrimmed.length).trimStart();
  }

  const tokensUsed = estimateTokens(JSON.stringify(messages) + aiResponse);

  // Parse choices before stripping them from the response
  const parsedChoices = tagParser.parseChoices ? tagParser.parseChoices(aiResponse, characters) : [];

  // Parse POV sections from AI response
  const parsedPOVs = tagParser.parsePOVSections ? tagParser.parsePOVSections(aiResponse, characters) : {};
  const hasPOVs = Object.keys(parsedPOVs).length > 0;
  console.log(`POV sections found: ${Object.keys(parsedPOVs).length}`, Object.keys(parsedPOVs));

  // Strip CHOICE and POV tags from the narration stored in history
  let cleanedResponse = aiResponse
    .replace(/\[CHOICE:\s*[^\]]+\]/gi, '')
    .replace(/\[POV:\s*[^\]]*\]/gi, '')
    .replace(/\[\/POV\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Build history entry with POVs attached
  const historyEntry = { role: 'assistant', content: cleanedResponse, type: 'narration' };
  if (hasPOVs) {
    historyEntry.povs = parsedPOVs;
  }
  fullHistory.push(historyEntry);

  // Snapshot character states BEFORE applying tags (for reroll restore)
  try {
    const characterStates = characters.map(c => ({
      id: c.id,
      hp: c.hp, max_hp: c.max_hp, ac: c.ac,
      xp: c.xp, gold: c.gold,
      inventory: c.inventory,
      spell_slots: c.spell_slots,
      ac_effects: c.ac_effects
    }));
    db.prepare('INSERT INTO game_snapshots (id, session_id, turn_number, character_states) VALUES (?, ?, ?, ?)')
      .run(uuidv4(), sessionId, session.current_turn, JSON.stringify(characterStates));
    console.log(`Snapshot saved for session ${sessionId}, turn ${session.current_turn}`);
  } catch (snapshotError) {
    console.error('Failed to save game snapshot:', snapshotError.message);
  }

  // Apply all tags from the AI response
  console.log('=== AI Stream Response complete ===');
  console.log('Looking for tags in response...');

  const tagApplicatorDeps = {
    db, io, tagParser, parseAcEffects, calculateTotalAC, updateCharacterAC
  };
  applyAllTags(tagApplicatorDeps, aiResponse, characters, sessionId);

  // Update session - calculate tokens based on recent history only
  const recentHistoryForTokenCount = fullHistory.slice(compactedCount);
  const recentHistoryTokens = estimateTokens(JSON.stringify(recentHistoryForTokenCount));

  const maxTokens = parseInt(settings.max_tokens_before_compact) || 8000;
  let newSummary = session.story_summary;
  let newCompactedCount = compactedCount;

  const minMessagesBeforeCompact = 4;
  const shouldCompact = recentHistoryTokens > maxTokens && recentHistoryForTokenCount.length >= minMessagesBeforeCompact;

  console.log(`Token check: recentHistoryTokens=${recentHistoryTokens}, maxTokens=${maxTokens}, messagesSinceCompact=${recentHistoryForTokenCount.length}, shouldCompact=${shouldCompact}`);

  if (shouldCompact) {
    console.log('Compacting history...');
    const recentHistoryToCompact = fullHistory.slice(compactedCount, -1);

    // Progressive: if history is very long, compact in chunks of 25
    if (recentHistoryToCompact.length > 50) {
      console.log(`Progressive compaction: ${recentHistoryToCompact.length} entries, compacting first 25`);
      const chunk = recentHistoryToCompact.slice(0, 25);
      const chunkSummary = await compactHistory(apiConfig, '', chunk, characters, extractAIMessage);

      // Merge chunk summary with existing summary
      newSummary = await compactHistory(apiConfig, session.story_summary,
        [{ role: 'assistant', content: chunkSummary }], characters, extractAIMessage);

      // Only mark the compacted chunk as compacted (not all history)
      newCompactedCount = compactedCount + 25;
    } else {
      // Normal compaction for shorter histories
      newSummary = await compactHistory(apiConfig, session.story_summary, recentHistoryToCompact, characters, extractAIMessage);
      newCompactedCount = fullHistory.length - 1;
    }

    // Cap summary length at 4000 chars
    if (newSummary && newSummary.length > 4000) {
      console.log(`Summary too long (${newSummary.length} chars), performing recursive summarization`);
      newSummary = await compactHistory(apiConfig, '',
        [{ role: 'assistant', content: newSummary }], characters, extractAIMessage);
    }

    db.prepare('UPDATE game_sessions SET story_summary = ?, full_history = ?, compacted_count = ?, total_tokens = 0, current_turn = current_turn + 1 WHERE id = ?')
      .run(newSummary, JSON.stringify(fullHistory), newCompactedCount, sessionId);
  } else {
    db.prepare('UPDATE game_sessions SET full_history = ?, total_tokens = ?, current_turn = current_turn + 1 WHERE id = ?')
      .run(JSON.stringify(fullHistory), recentHistoryTokens, sessionId);
  }

  // Clear pending actions
  db.prepare('DELETE FROM pending_actions WHERE session_id = ?').run(sessionId);

  // Emit final turn_processed to all clients (replaces streaming content with formatted version)
  io.emit('turn_processed', {
    sessionId,
    response: cleanedResponse,
    turn: session.current_turn + 1,
    tokensUsed: recentHistoryTokens,
    compacted: shouldCompact,
    choices: parsedChoices,
    povs: hasPOVs ? parsedPOVs : null
  });

  return { response: cleanedResponse, tokensUsed: recentHistoryTokens };
}

module.exports = {
  processAITurn,
  streamAITurn,
  compactHistory,
  estimateTokens
};
