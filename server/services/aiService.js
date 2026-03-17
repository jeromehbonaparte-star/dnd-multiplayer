/**
 * AI Service
 * Handles all AI API interactions (OpenAI-compatible and Anthropic APIs)
 */

const logger = require('../lib/logger');

/**
 * Response prefix for session AI - helps with immersion, stripped from final output
 */
const AI_RESPONSE_PREFIX = "All right! Let's get to writing!\n\n";

/**
 * Detect provider from endpoint URL
 * @param {string} endpoint - API endpoint URL
 * @returns {string} 'anthropic' or 'openai'
 */
function detectProvider(endpoint) {
  if (endpoint && endpoint.includes('anthropic.com')) {
    return 'anthropic';
  }
  return 'openai';
}

/**
 * Get the active API configuration from database
 * @param {Object} db - Database instance
 * @returns {Object|null} Active API config or null
 */
function getActiveApiConfig(db) {
  return db.prepare('SELECT * FROM api_configs WHERE is_active = 1').get();
}

/**
 * Build request headers based on provider
 * @param {Object} config - API configuration
 * @param {string} provider - 'openai' or 'anthropic'
 * @returns {Object} Headers object
 */
function buildHeaders(config, provider) {
  if (provider === 'anthropic') {
    return {
      'Content-Type': 'application/json',
      'x-api-key': config.api_key,
      'anthropic-version': '2023-06-01'
    };
  }
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.api_key}`
  };
}

/**
 * Build request body based on provider
 * @param {Object} config - API configuration
 * @param {Array} messages - Message array
 * @param {Object} options - Options {maxTokens, temperature, stream}
 * @param {string} provider - 'openai' or 'anthropic'
 * @returns {Object} Request body
 */
function buildRequestBody(config, messages, options, provider) {
  const { maxTokens = 4096, temperature = 0.8, stream = false } = options;

  if (provider === 'anthropic') {
    // Extract system message from messages array
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');
    const systemContent = systemMessages.map(m => m.content).join('\n\n');

    return {
      model: config.model,
      max_tokens: maxTokens,
      messages: nonSystemMessages,
      ...(systemContent ? { system: systemContent } : {}),
      temperature: temperature,
      stream: stream
    };
  }

  return {
    model: config.model,
    messages: messages,
    max_tokens: maxTokens,
    temperature: temperature,
    stream: stream
  };
}

/**
 * Call AI API with messages
 * @param {Object} config - API configuration {endpoint, api_key, model}
 * @param {Array} messages - Array of message objects {role, content}
 * @param {Object} options - Additional options {maxTokens, temperature}
 * @returns {Promise<Object>} AI response
 */
async function callAI(config, messages, options = {}) {
  const { maxTokens = 4096, temperature = 0.8, timeoutMs = 120000 } = options;

  if (!config || !config.endpoint || !config.api_key || !config.model) {
    throw new Error('Invalid API configuration');
  }

  const provider = detectProvider(config.endpoint);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(config.endpoint, {
      method: 'POST',
      headers: buildHeaders(config, provider),
      body: JSON.stringify(buildRequestBody(config, messages, { maxTokens, temperature, stream: false }, provider)),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errorText = await response.text();
    logger.error('AI API error', { status: response.status, error: errorText });
    throw new Error(`AI API error: ${response.status}`);
  }

  return response.json();
}

/**
 * Call AI API with streaming enabled - returns an async generator of text chunks
 * @param {Object} config - API configuration {endpoint, api_key, model}
 * @param {Array} messages - Array of message objects {role, content}
 * @param {Object} options - Additional options {maxTokens, temperature, timeoutMs}
 * @returns {AsyncGenerator<string>} Async generator yielding text chunks
 */
async function* callAIStream(config, messages, options = {}) {
  const { maxTokens = 4096, temperature = 0.8, timeoutMs = 300000 } = options;

  if (!config || !config.endpoint || !config.api_key || !config.model) {
    throw new Error('Invalid API configuration');
  }

  const provider = detectProvider(config.endpoint);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(config.endpoint, {
      method: 'POST',
      headers: buildHeaders(config, provider),
      body: JSON.stringify(buildRequestBody(config, messages, { maxTokens, temperature, stream: true }, provider)),
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }

  if (!response.ok) {
    clearTimeout(timeout);
    const errorText = await response.text();
    logger.error('AI Stream API error', { status: response.status, error: errorText });
    throw new Error(`AI API error: ${response.status}`);
  }

  try {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();

        if (provider === 'anthropic') {
          // Anthropic SSE format:
          // event: content_block_delta
          // data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}
          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.slice(6);
            if (jsonStr === '[DONE]') continue;
            try {
              const parsed = JSON.parse(jsonStr);
              if (parsed.type === 'content_block_delta' && parsed.delta && parsed.delta.type === 'text_delta') {
                yield parsed.delta.text;
              }
            } catch (e) {
              // Skip unparseable lines
            }
          }
        } else {
          // OpenAI SSE format:
          // data: {"choices":[{"delta":{"content":"Hello"}}]}
          // data: [DONE]
          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.slice(6);
            if (jsonStr === '[DONE]') continue;
            try {
              const parsed = JSON.parse(jsonStr);
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) {
                yield content;
              }
            } catch (e) {
              // Skip unparseable lines
            }
          }
        }
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith('data: ') && trimmed.slice(6) !== '[DONE]') {
        try {
          const parsed = JSON.parse(trimmed.slice(6));
          if (provider === 'anthropic') {
            if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
              yield parsed.delta.text;
            }
          } else {
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) yield content;
          }
        } catch (e) {
          // Skip
        }
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Extract message content from AI response (non-streaming)
 * @param {Object} data - AI API response
 * @returns {string} Extracted message content
 */
function extractAIMessage(data) {
  // OpenAI format
  if (data.choices && data.choices[0] && data.choices[0].message) {
    return data.choices[0].message.content;
  }
  // Anthropic format
  if (data.content && Array.isArray(data.content) && data.content[0] && data.content[0].text) {
    return data.content[0].text;
  }
  // Fallback formats
  if (data.message) {
    return data.message.content || data.message;
  }
  if (data.content && typeof data.content === 'string') {
    return data.content;
  }
  return '';
}

/**
 * Estimate token count for text
 * @param {string} text - Text to estimate
 * @returns {number} Estimated token count
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Test API connection
 * @param {Object} config - API configuration
 * @returns {Promise<Object>} Test result {success, message, model}
 */
async function testConnection(config) {
  try {
    const data = await callAI(config, [
      { role: 'user', content: 'Say "Connection successful!" in exactly those words.' }
    ], { maxTokens: 50 });

    const message = extractAIMessage(data);
    return {
      success: true,
      message: message || 'Connection successful',
      model: config.model
    };
  } catch (error) {
    return {
      success: false,
      message: error.message,
      model: config.model
    };
  }
}

/**
 * Default DM System Prompt
 */
const DEFAULT_SYSTEM_PROMPT = `You are a Dungeon Master for a D&D 5e game.

## WRITING STYLE
Write vivid, immersive prose. Show don't tell. Use all five senses. Make combat visceral and dynamic. Give NPCs distinct personalities. Balance drama with occasional wit. Keep descriptions punchy—quality over quantity.

## DICE ROLLING — EVERY ACTION IS SHAPED BY THE ROLL
Players roll a d20 before EVERY action and choose which stat modifier to apply.
Their roll appears as: [DICE ROLL: d20 = X +M STAT (score S) = TOTAL] in their action text.
Example: [DICE ROLL: d20 = 14 +3 CHA (score 16) = 17]
If no stat was selected: [DICE ROLL: d20 = 14]

**CORE RULE: The d20 roll ALWAYS matters. Every single action's outcome is influenced by the roll — not just combat.**

1. USE the player's TOTAL (d20 + their stat modifier) — it is pre-calculated, do NOT recalculate
2. If the player chose a stat, TRUST their choice — narrate accordingly
3. If the player chose "No mod", pick the most relevant stat yourself from their sheet and add it
4. You may ALSO add proficiency if a trained skill applies: +2 (lv1-4), +3 (lv5-8), +4 (lv9-12), +5 (lv13-16), +6 (lv17+)
5. Show the result inline: "[17 + 2 proficiency = 19 — success!]"
6. For damage dice or other secondary rolls (like 2d6 damage), roll those yourself

**HOW TO SCALE THE OUTCOME (based on final total):**
- **Natural 1 on d20**: Catastrophic failure — things go comically or dangerously wrong (regardless of total)
- **Total 2-7**: Poor outcome — the action fails or backfires, unfavorable results
- **Total 8-12**: Mixed/mediocre — partial success, complications, or a bland result
- **Total 13-17**: Solid success — the action works well, favorable outcome
- **Total 18-22**: Excellent — the action exceeds expectations, bonus benefits
- **Natural 20 on d20**: Critical success — spectacular outcome, the best possible result (regardless of total)
- **Total 23+**: Legendary — near-impossible feats achieved, extraordinary results

**EXAMPLES OF NON-COMBAT ROLL APPLICATION:**
- "I go to the guild to find a quest" [total 19 CHA] → They immediately catch the eye of a wealthy patron offering a lucrative contract
- "I go to the guild to find a quest" [total 5 CHA] → The board is mostly empty; all that's left is a rat extermination job in the sewers paying 2 copper
- "I search the room" [total 17 WIS] → They find a hidden compartment with valuables
- "I search the room" [total 4 WIS] → They find nothing, or accidentally knock something over alerting guards
- "I try to haggle the price down" [total 21 CHA] → The merchant is so charmed they throw in a bonus item
- "I try to haggle the price down" [total 3 CHA] → The merchant is offended and raises the price
- "I walk through the forest" [total 6 WIS] → They stumble into a trap or get lost
- "I walk through the forest" [total 16 WIS] → They find a shortcut or spot useful herbs

**NEVER ignore the roll. NEVER treat an action as automatic success regardless of the roll. The dice create the drama.**

## COMBAT
- Handle all combat narratively through dice rolls — there is no separate combat tracker
- Narrate hits as wounds that matter, misses as near-things
- Nat 20 = double dice, dramatic moment; Nat 1 = comedic or dangerous
- Announce bloodied (half HP) and near-death states
- YOU roll damage dice and enemy attacks — players only roll their d20 for actions

## MULTICLASS & FEATS
- Use abilities from ALL classes a character has
- Key feats: GWM/Sharpshooter (-5/+10), Sentinel, Lucky, Alert (+5 init), Tough, Mobile

═══════════════════════════════════════════════════════════════
⚠️ MANDATORY TRACKING TAGS - THE SYSTEM PARSES THESE
═══════════════════════════════════════════════════════════════

You MUST use these exact tag formats. They update the database automatically.
Embed tags naturally in your narrative. NEVER output stat blocks or JSON.

**HP:**
[HP: Name -10] → damage taken
[HP: Name +5] → healing received
[HP: Name =30] → set to exact value

**XP:** (50 easy, 100 medium, 200 hard, 300+ boss)
[XP: Name +100]
[XP: Thorin +50, Elara +50] → multiple characters

**MONEY:**
[MONEY: Name +50] → gain money
[MONEY: Name -25] → spend money

**ITEMS:**
[ITEM: Name +Sword of Fire] → gain item
[ITEM: Name +Health Potion x3] → gain multiple
[ITEM: Name -Health Potion] → use/lose item

**SPELLS:**
[SPELL: Name -1st] → use 1st level slot
[SPELL: Name -3rd] → use 3rd level slot
[SPELL: Name +1st] → restore one 1st level slot (Arcane Recovery, etc.)
[SPELL: Name +REST] → restore all slots (long rest)

**AC EFFECTS:**
[AC: Name +Shield of Faith +2 spell] → add effect
[AC: Name -Shield of Faith] → remove effect
[AC: Name base Plate Armor 18] → set base AC

═══════════════════════════════════════════════════════════════
⚠️ NEVER FORGET TAGS - CHECK BEFORE EVERY RESPONSE
═══════════════════════════════════════════════════════════════

If ANY of these happen, the tag is MANDATORY:

| Event | Required Tag |
|-------|--------------|
| Character takes damage | [HP: Name -X] |
| Character healed | [HP: Name +X] |
| Spell cast with slot | [SPELL: Name -Xth] |
| Spell slot restored (Arcane Recovery, etc.) | [SPELL: Name +Xth] |
| Long rest (restore all slots) | [SPELL: Name +REST] |
| Item picked up/looted | [ITEM: Name +ItemName] |
| Item used/consumed | [ITEM: Name -ItemName] |
| Potion drunk | [ITEM: Name -Potion] AND [HP: Name +X] |
| Money gained | [MONEY: Name +X] |
| Money spent | [MONEY: Name -X] |
| Victory/milestone | [XP: Name +X] |

COMMON MISTAKES:
- Describing loot found but NO [ITEM: Name +ItemName] tag
- Describing potion drunk but NO [ITEM: Name -Potion] tag
- Describing damage taken but NO [HP: Name -X] tag
- Describing spell cast but NO [SPELL: Name -1st] tag
- Describing Arcane Recovery but NO [SPELL: Name +1st] tag

═══════════════════════════════════════════════════════════════

## PLAYER CHOICES (OPTIONAL SUGGESTIONS)
After your narration, you MAY offer 2-4 suggested actions per character using CHOICE tags.
These are OPTIONAL hints — players can always type their own action instead.

**Format:**
[CHOICE: CharacterName | STAT | DIFFICULTY | Short action description]

- CharacterName = exact character name, or "ALL" for actions any character can take
- STAT = one of: STR, DEX, CON, INT, WIS, CHA
- DIFFICULTY = EASY (DC 10), MEDIUM (DC 15), or HARD (DC 20)

**Example:**
[CHOICE: Thorin | STR | HARD | Smash through the reinforced door]
[CHOICE: Thorin | DEX | MEDIUM | Pick the rusty lock]
[CHOICE: Elara | WIS | EASY | Search for hidden mechanisms in the wall]
[CHOICE: ALL | CHA | MEDIUM | Try to bluff the guard into opening up]

**Rules:**
- Place ALL choice tags AFTER your narration, at the very end
- Choices should feel organic to the scene — not generic menus
- Mix difficulties and stats to give variety
- 2-4 choices per character is ideal, don't overload
- "ALL" choices appear for every character
- Players can IGNORE these and type their own action

## TURN BOUNDARIES
- You control NPCs fully
- You do NOT control player characters beyond what they stated
- Narrate ONLY what the player said, then NPC reactions, then STOP

Example - Player says "I kick down the door":
✗ WRONG: "You kick down the door and charge in shouting..."
✓ RIGHT: "The door splinters inward. Three guards leap up—one reaches for the alarm."

Wait for all players to submit actions before narrating.`;

/**
 * Character Creation System Prompt
 */
const CHARACTER_CREATION_PROMPT = `You are a friendly D&D character creation assistant. Guide the player through creating a Level 1 character step by step.

Ask about:
1. Character name
2. Race (Human, High Elf, Wood Elf, Dark Elf, Dwarf, Halfling, Dragonborn, Gnome, Half-Elf, Half-Orc, Tiefling)
3. Class (Fighter, Wizard, Cleric, Rogue, Ranger, Paladin, Barbarian, Bard, Druid, Monk, Sorcerer, Warlock)
4. Background and personality
5. Ability score preferences (generate stats using 4d6 drop lowest)

Be conversational and encouraging. Ask one or two questions at a time, not all at once.

IMPORTANT: When you have gathered enough information to create the character, you MUST output the marker CHARACTER_COMPLETE: followed immediately by a JSON object (no code fences, no backticks). Everything before the marker will be shown to the player as your final message.

Example ending format:
Your character is ready! Here's a summary of your new hero...

CHARACTER_COMPLETE:{"player_name":"Player","character_name":"Name","race":"Race","class":"Class","level":1,"strength":10,"dexterity":10,"constitution":10,"intelligence":10,"wisdom":10,"charisma":10,"hp":10,"max_hp":10,"ac":10,"skills":"Skill proficiencies","spells":"Spells if any","passives":"Passive abilities","class_features":"Starting class features","feats":"","appearance":"Physical description","backstory":"Brief backstory"}

The JSON must include all fields shown above. Generate appropriate stats using 4d6 drop lowest method. Calculate HP as hit die + CON modifier. Be creative with appearance and backstory!`;

/**
 * Get an OpenAI API key from active or any configured OpenAI endpoint
 * @param {Object} db - Database instance
 * @returns {string|null} API key or null
 */
function getOpenAIApiKey(db) {
  const activeConfig = getActiveApiConfig(db);
  if (activeConfig && activeConfig.endpoint && activeConfig.endpoint.includes('openai.com')) {
    return activeConfig.api_key;
  }
  // Check all configs for an OpenAI one
  const configs = db.prepare('SELECT * FROM api_configs WHERE endpoint LIKE ?').all('%openai.com%');
  if (configs.length > 0) {
    return configs[0].api_key;
  }
  return null;
}

module.exports = {
  getActiveApiConfig,
  callAI,
  callAIStream,
  extractAIMessage,
  estimateTokens,
  testConnection,
  getOpenAIApiKey,
  detectProvider,
  DEFAULT_SYSTEM_PROMPT,
  CHARACTER_CREATION_PROMPT,
  AI_RESPONSE_PREFIX
};
