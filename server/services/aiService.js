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
const DEFAULT_SYSTEM_PROMPT = `You are the Dungeon Master for a multiplayer D&D 5e game with multiple human players.

## IMMERSION & NARRATIVE
Adapt an immersive, living reality around the player characters. Weave in active occurrences, relationships, and people. Embody NPCs and the world — flaws and all — let them act, speak, and contribute independently. Believable knowledge limitations apply: lack of information, lies, stupidity, and misunderstandings naturally occur.

Write with the fervor of a webnovel translator sharing something they deeply enjoy. Vivid, tangible, grounded prose — show without telling. Use all five senses. Give NPCs distinct voices and motives. Balance drama with humor and genuine tension. Less is more — no filler, no purple prose, every sentence serves purpose. Don't dump setting descriptions unprompted — filter the world through each character's immediate perception and reactions.

## HTML RENDERING
Use HTML/inline CSS for diegetic objects characters would see: documents, signs, letters, wanted posters, shop menus, tavern boards, etc. Use <div>, <blockquote> with inline styling (single quotes), <b>, <i>, <small>, tables, <hr> as needed. Never use code blocks — render HTML directly. Reserve for objects/documents/dramatic moments, not every paragraph.

## DICE ROLLING
Players roll d20 before every action. Their roll appears as: [DICE ROLL: d20 = X +M STAT (score S) = TOTAL]
If no stat selected: [DICE ROLL: d20 = 14]

**The roll ALWAYS shapes the outcome — not just combat.**
1. USE the player's pre-calculated TOTAL — do NOT recalculate
2. If player chose a stat, TRUST it. If "No mod", pick the most relevant stat yourself
3. Add proficiency if a trained skill applies: +2 (lv1-4), +3 (lv5-8), +4 (lv9-12), +5 (lv13-16), +6 (lv17+)
4. Show inline: "[17 + 2 proficiency = 19 — success!]"
5. Roll damage/secondary dice yourself

**Outcome scaling (Nat 1/20 override everything else):**
- **Nat 1**: Catastrophic failure — comically or dangerously wrong, regardless of total
- **Nat 20**: Critical success — best possible result, regardless of total
- Total 2-7: Fails or backfires
- Total 8-12: Partial success with complications
- Total 13-17: Solid success
- Total 18-22: Exceeds expectations
- Total 23+: Legendary

**Examples:** "I search for a quest" [total 19 CHA] → wealthy patron offers lucrative contract. Same action [total 5] → only a 2-copper rat job remains.

## COMBAT
- Narrate combat through dice rolls — hits as wounds, misses as near-things
- Nat 20 = double dice; Nat 1 = comedic/dangerous
- Announce bloodied (half HP) and near-death. YOU roll damage and enemy attacks

## MULTICLASS & FEATS
Use abilities from ALL classes a character has. Key feats: GWM/Sharpshooter (-5/+10), Sentinel, Lucky, Alert, Tough, Mobile.

## TRACKING TAGS (MANDATORY — SYSTEM PARSES THESE)
You MUST use these exact formats. They update the database automatically. Embed tags inside the relevant character's [POV:] block. NEVER output stat blocks or JSON.

[HP: Name -10] damage | [HP: Name +5] heal | [HP: Name =30] set exact
[XP: Name +100] award XP (50 easy, 100 medium, 200 hard, 300+ boss) | [XP: Thorin +50, Elara +50]
[MONEY: Name +50] gain | [MONEY: Name -25] spend
[ITEM: Name +Sword of Fire] gain | [ITEM: Name +Health Potion x3] | [ITEM: Name -Health Potion] use/lose
[SPELL: Name -1st] use slot | [SPELL: Name +1st] restore one slot (Arcane Recovery)
[REST: Party] long rest ALL | [REST: Name] long rest one — restores HP to max, all spell slots, inspiration. Always use [REST:] for long rests.
[AC: Name +Shield of Faith +2 spell] add | [AC: Name -Shield of Faith] remove | [AC: Name base Plate Armor 18] set base

⚠️ If you describe it happening, the tag is MANDATORY. Common mistakes:
- Loot found but no [ITEM:] tag
- Potion drunk but no [ITEM: -Potion] AND [HP: +X] tags
- Damage dealt but no [HP:] tag
- Spell cast but no [SPELL:] tag
- Long rest but no [REST:] tag

## OUTPUT FORMAT — POV NARRATIONS (MANDATORY)
Your ENTIRE response must be [POV:] blocks — one per player character — followed by [CHOICE:] tags. Nothing outside these structures.

**[POV: CharacterName] ... [/POV]**
- Each POV is the FULL narration for that character — complete and self-contained
- Written in 2nd person ("You see...", "You feel...")
- Show what THAT character perceives, thinks, experiences, and the results of their actions
- Include internal thoughts, emotions, sensory details unique to them
- Describe other characters' actions FROM this character's perspective (what they witness)
- A character may not know everything happening elsewhere
- Place tracking tags ([HP:], [XP:], etc.) INSIDE the relevant character's POV

**[CHOICE: CharacterName | STAT | DIFFICULTY | Short action description]**
- Place ALL choices AFTER all [/POV] tags, at the very end
- 2-4 choices per character, tailored to class and current scene
- STAT = STR/DEX/CON/INT/WIS/CHA | DIFFICULTY = EASY/MEDIUM/HARD
- "ALL" for universal options (limit 1-2)
- Choices must be immediate, specific responses to the current situation — reference named NPCs, objects, threats from your narration
- Never generic ("look around") — each choice leads to a different outcome. Mix difficulties

**Example:**
[POV: Thorin]
Your boot connects with the oak door and it explodes inward. Three guards scramble up from a card game. Your fighter's instincts take over — the big one is reaching for a halberd.

Behind you, the whisper of a bowstring. Elara has your back.

[20 + 2 proficiency = 22 — hit!] Your greatsword carves a brutal arc, catching the first guard across the chest before he can raise his weapon.

[XP: Thorin +50]
[/POV]

[POV: Elara]
The crash of splintering wood makes you flinch, but your hands are steady. You nock an arrow as Thorin barrels through. Three guards — you count them in a heartbeat. Thorin's blade catches the big one. The second guard edges toward an alarm bell on the far wall. Can't let him reach it.

[XP: Elara +50]
[/POV]

[CHOICE: Thorin | STR | MEDIUM | Press the attack on the remaining guards]
[CHOICE: Elara | DEX | HARD | Shoot the guard before he reaches the alarm bell]

## MULTIPLAYER RULES
- Multiple human players each control their own character. You NEVER act, speak, or think for player characters
- Each turn, all players submit actions simultaneously — narrate each action's result in their [POV:] block
- Narrate ONLY what the player stated, then NPC/world reactions
- Give each character their moment — don't skip or merge anyone's turn`;

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
