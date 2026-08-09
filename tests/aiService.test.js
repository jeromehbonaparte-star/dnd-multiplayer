'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractFinishReason,
  isLengthFinish,
  buildContinuationMessages,
  DEFAULT_SYSTEM_PROMPT,
  POV_CONVERSION_PROMPT,
  buildPOVPartyRoster,
  buildPOVCampaignContext,
  buildPOVIdentityNotes,
  NARRATION_WORD_LIMIT,
  POV_WORD_LIMIT,
  NARRATION_MAX_TOKENS,
  POV_MAX_TOKENS,
  POV_IMAGE_DIRECTOR_PROMPT,
  POV_IMAGE_PROMPT_MAX_WORDS,
  buildRequestBody,
  buildCombatTurnContext,
  adjudicateCombatAction,
  generateEnemyCombatTurn,
  COMBAT_ADJUDICATOR_PROMPT,
  COMBAT_ENEMY_TURN_PROMPT,
} = require('../server/services/aiService.js');
const {
  createCombat,
  rollInitiative,
  buildEnemyPreRolls,
} = require('../server/services/combatService.js');

describe('extractFinishReason', () => {
  test('reads OpenAI finish_reason from choices[0]', () => {
    const data = { choices: [{ finish_reason: 'length' }] };
    assert.equal(extractFinishReason(data), 'length');
  });

  test('reads Anthropic stop_reason', () => {
    const data = { stop_reason: 'max_tokens' };
    assert.equal(extractFinishReason(data), 'max_tokens');
  });

  test('returns null when finish reason is omitted', () => {
    assert.equal(extractFinishReason({ choices: [{ message: { content: 'ok' } }] }), null);
    assert.equal(extractFinishReason(null), null);
  });
});

describe('POV campaign context', () => {
  test('prompt locks aliases and disguises to the target identity', () => {
    assert.match(POV_CONVERSION_PROMPT, /masquerading as/);
    assert.match(POV_CONVERSION_PROMPT, /same "you"/);
    assert.match(POV_CONVERSION_PROMPT, /alias\/disguise\/public identity/);
    assert.match(POV_CONVERSION_PROMPT, /repair the POV/);
  });

  test('party roster gives the target full private context without exposing other backstories', () => {
    const roster = buildPOVPartyRoster([
      {
        id: 'violeta',
        character_name: 'Violeta',
        race: 'Changeling',
        class: 'Rogue',
        background: 'Charlatan',
        appearance: 'Often wears Julius as a public face.',
        backstory: 'Violeta maintains the Julius persona to move unseen.'
      },
      {
        id: 'achilles',
        character_name: 'Achilles',
        race: 'Human',
        class: 'Fighter',
        appearance: 'Broad-shouldered veteran.',
        backstory: 'Secret oath no other player should receive in their prompt roster.'
      }
    ], { id: 'violeta', character_name: 'Violeta' });

    assert.match(roster, /Violeta, Changeling Rogue/);
    assert.match(roster, /Background: Charlatan/);
    assert.match(roster, /Julius persona/);
    assert.match(roster, /Achilles, Human Fighter/);
    assert.doesNotMatch(roster, /Secret oath/);
  });

  test('recent POV context includes visible actions but strips hidden context, GM notes, and stored POV blobs', () => {
    const context = buildPOVCampaignContext([
      { role: 'user', type: 'context', hidden: true, content: 'private party sheet' },
      { role: 'user', type: 'action', character_name: 'Violeta', content: 'I keep masquerading as Julius while questioning the guard.' },
      {
        role: 'assistant',
        type: 'narration',
        content: 'Julius keeps the guard talking by the door.',
        povs: { Violeta: 'private generated POV should not be recycled' }
      },
      { role: 'user', type: 'gm_nudge', content: 'secret GM-only instruction' }
    ]);

    assert.match(context, /\[Violeta\]: I keep masquerading as Julius/);
    assert.match(context, /\[DM\]: Julius keeps the guard talking/);
    assert.doesNotMatch(context, /private party sheet/);
    assert.doesNotMatch(context, /secret GM-only instruction/);
    assert.doesNotMatch(context, /private generated POV/);
  });

  test('identity notes pin masquerade aliases as the same embodied POV', () => {
    const notes = buildPOVIdentityNotes(
      { character_name: 'Violeta', race: 'Changeling', class: 'Rogue' },
      '',
      '[Violeta]: I keep masquerading as Julius while questioning the guard.\n\n[DM]: Julius keeps the guard talking by the door.',
      ''
    );

    assert.match(notes, /Julius/);
    assert.match(notes, /current public face/);
    assert.match(notes, /do not leave Violeta asleep/);
  });

  test('manual reroll correction notes are included as identity context', () => {
    const notes = buildPOVIdentityNotes(
      { character_name: 'Violeta', race: 'Changeling', class: 'Rogue' },
      '',
      '',
      'Violeta is currently disguised as Julius; Julius is not a separate person.'
    );

    assert.match(notes, /Player\/GM correction/);
    assert.match(notes, /Julius/);
    assert.match(notes, /same embodied POV|current public face/);
  });
});

describe('isLengthFinish', () => {
  test('detects token-cap finish reasons', () => {
    assert.equal(isLengthFinish('length'), true);
    assert.equal(isLengthFinish('max_tokens'), true);
    assert.equal(isLengthFinish('LENGTH'), true);
    assert.equal(isLengthFinish('MAX_TOKENS'), true);
  });

  test('rejects non-length finish reasons', () => {
    assert.equal(isLengthFinish('stop'), false);
    assert.equal(isLengthFinish(null), false);
  });
});

describe('buildContinuationMessages', () => {
  const baseMessages = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'write the scene' },
  ];

  test('OpenAI-compatible continuation appends assistant partial then user nudge', () => {
    const messages = buildContinuationMessages(baseMessages, 'partial scene', 'openai');

    assert.equal(messages.length, 4);
    assert.deepEqual(messages.slice(0, 2), baseMessages);
    assert.deepEqual(messages[2], { role: 'assistant', content: 'partial scene' });
    assert.equal(messages[3].role, 'user');
    assert.match(messages[3].content, /Continue seamlessly/);
    assert.match(messages[3].content, /Do NOT repeat/);
  });

  test('Anthropic continuation ends on assistant partial with no trailing user turn', () => {
    const messages = buildContinuationMessages(baseMessages, 'partial scene', 'anthropic');

    assert.equal(messages.length, 3);
    assert.deepEqual(messages.slice(0, 2), baseMessages);
    assert.deepEqual(messages[2], { role: 'assistant', content: 'partial scene' });
  });
});

describe('reasoning effort request option', () => {
  test('omits reasoning_effort when provider default is selected', () => {
    const body = buildRequestBody(
      { model: 'gpt-5', reasoning_effort: '' },
      [{ role: 'user', content: 'hello' }],
      { maxTokens: 100, temperature: 0.7, stream: false },
      'openai'
    );

    assert.equal(Object.hasOwn(body, 'reasoning_effort'), false);
  });

  test('forwards a supported reasoning effort to OpenAI-compatible requests', () => {
    const body = buildRequestBody(
      { model: 'gpt-5', reasoning_effort: 'high' },
      [{ role: 'user', content: 'hello' }],
      { maxTokens: 100, temperature: 0.7, stream: false },
      'openai'
    );

    assert.equal(body.reasoning_effort, 'high');
  });

  test('does not send OpenAI reasoning_effort to Anthropic requests', () => {
    const body = buildRequestBody(
      { model: 'claude-sonnet', reasoning_effort: 'high' },
      [{ role: 'user', content: 'hello' }],
      { maxTokens: 100, temperature: 0.7, stream: false },
      'anthropic'
    );

    assert.equal(Object.hasOwn(body, 'reasoning_effort'), false);
  });
});

describe('generation length budgets', () => {
  test('DM and POV prompts include explicit word limits', () => {
    assert.equal(NARRATION_WORD_LIMIT, 650);
    assert.equal(POV_WORD_LIMIT, 450);
    assert.match(DEFAULT_SYSTEM_PROMPT, /650 words or fewer/);
    assert.match(DEFAULT_SYSTEM_PROMPT, /do not list, suggest, or format possible actions/);
    assert.match(POV_CONVERSION_PROMPT, /450 words/);
  });

  test('output token caps are bounded enough to avoid runaway generations', () => {
    assert.ok(NARRATION_MAX_TOKENS <= 3500);
    assert.ok(POV_MAX_TOKENS <= 2400);
  });
});

describe('narrative combat AI', () => {
  const party = [
    {
      id: 'fighter',
      character_name: 'Mara',
      class: 'Fighter',
      level: 3,
      hp: 28,
      max_hp: 28,
      ac: 16,
      strength: 16,
      dexterity: 12,
      inventory: JSON.stringify([{ name: 'Potion of Healing', quantity: 2 }, { name: 'Rope', quantity: 1 }]),
      class_features: 'Second Wind, Action Surge',
      class_resources: '{"secondWind":{"max":1}}'
    },
    {
      id: 'wizard',
      character_name: 'Orrin',
      class: 'Wizard',
      level: 3,
      hp: 18,
      max_hp: 18,
      ac: 12,
      dexterity: 14,
      intelligence: 16,
      spells: 'Fire Bolt, Magic Missile',
      spell_slots: JSON.stringify({ 1: { current: 2, max: 2 } }),
      inventory: '[]'
    }
  ];
  const enemies = [{ id: 'goblin', name: 'Goblin', hp: 14, ac: 12, attackBonus: 4, damageDie: 6, damageBonus: 2 }];
  const aiConfig = { endpoint: 'https://example.com/v1/chat/completions', api_key: 'k', model: 'test-model' };

  function startCombat() {
    const state = createCombat({ name: 'Ambush', environment: 'forest', characters: party, enemies, seed: 77 });
    rollInitiative(state, 'pc:fighter', 20);
    rollInitiative(state, 'pc:wizard', 3);
    return state;
  }

  /** Records the call and replays a canned assistant message. */
  function stubCall(content, extra = {}) {
    const calls = [];
    const callFn = async (config, messages, options) => {
      calls.push({ config, messages, options });
      return { choices: [{ message: { content }, finish_reason: 'stop', ...extra }] };
    };
    return { calls, callFn };
  }

  const CLEAN_ADJUDICATION = JSON.stringify({
    narration: 'Mara drives her shoulder into the goblin and follows it with the axe.',
    costs: { ap: 1, bp: 0 },
    effects: [{ type: 'damage', target: 'Goblin', amount: 9 }],
    turnEnds: true
  });

  test('prompts pin the cost economy, slot rules, and dice authority', () => {
    assert.match(COMBAT_ADJUDICATOR_PROMPT, /"ap":1,"bp":0/);
    assert.match(COMBAT_ADJUDICATOR_PROMPT, /Nothing mechanically meaningful is ever \{"ap":0,"bp":0\}/);
    assert.match(COMBAT_ADJUDICATOR_PROMPT, /A leveled spell REQUIRES a matching \{"type":"spendSlot"/);
    assert.match(COMBAT_ADJUDICATOR_PROMPT, /Cantrips NEVER spend a slot/);
    assert.match(COMBAT_ADJUDICATOR_PROMPT, /PLAYER'S DICE ROLL block/);
    assert.match(COMBAT_ADJUDICATOR_PROMPT, /never re-roll, never invent a second roll/);
    assert.match(COMBAT_ADJUDICATOR_PROMPT, /ONLY when the player applied no stat modifier of their own/);
    assert.match(COMBAT_ADJUDICATOR_PROMPT, /Total >= AC and the attack HITS/);
    assert.match(COMBAT_ADJUDICATOR_PROMPT, /Total < AC and it MISSES: emit NO damage effect/);
    assert.match(COMBAT_ADJUDICATOR_PROMPT, /natural 1 always misses/);
    assert.match(COMBAT_ADJUDICATOR_PROMPT, /natural 20 always hits and doubles the damage dice/);
    assert.match(COMBAT_ADJUDICATOR_PROMPT, /A miss reads like a miss/);
    assert.match(COMBAT_ADJUDICATOR_PROMPT, /Total 13-17: solid success/);
    assert.match(COMBAT_ADJUDICATOR_PROMPT, /Total 23\+: extraordinary/);
    assert.match(COMBAT_ADJUDICATOR_PROMPT, /UNCONSCIOUS and dying, never killed outright/);
    assert.match(COMBAT_ENEMY_TURN_PROMPT, /attackRoll\.total is compared against the AC/);
    assert.match(COMBAT_ENEMY_TURN_PROMPT, /damageRoll\.total is the damage dealt on a hit/);
    assert.match(COMBAT_ENEMY_TURN_PROMPT, /NEVER invent new combatants/);
  });

  test('turn context carries the full sheet: points, slots, inventory, resources', () => {
    const state = startCombat();

    const maraContext = buildCombatTurnContext(state, 'pc:fighter');
    assert.equal(maraContext.encounter.name, 'Ambush');
    assert.equal(maraContext.encounter.round, 1);
    assert.equal(maraContext.actor.name, 'Mara');
    assert.equal(maraContext.actor.ap, 1);
    assert.equal(maraContext.actor.bp, 1);
    assert.equal(maraContext.actor.hp, 28);
    assert.equal(maraContext.actor.ac, 16);
    assert.deepEqual(maraContext.actor.inventory, [
      { name: 'Potion of Healing', quantity: 2 },
      { name: 'Rope', quantity: 1 }
    ]);
    assert.match(maraContext.actor.classFeatures, /Second Wind/);
    assert.match(maraContext.actor.classResources, /secondWind/);
    assert.ok(maraContext.actor.powers.some(power => power.name === 'Second Wind' && power.usesLeft === 1));
    assert.deepEqual(maraContext.allies.map(ally => ally.name), ['Orrin']);
    assert.deepEqual(maraContext.enemies.map(foe => foe.name), ['Goblin']);
    assert.equal(maraContext.enemies[0].hp, 14);
    assert.ok(maraContext.recentLog.length > 0);

    const orrinContext = buildCombatTurnContext(state, 'pc:wizard');
    assert.deepEqual(orrinContext.actor.spellSlots, { 1: { current: 2, max: 2 } });
    assert.match(orrinContext.actor.knownSpells, /Magic Missile/);
  });

  test('turn context omits sheet fields a migrated unit never carried', () => {
    const state = startCombat();
    // Mara has no spell list and no slot table; Orrin's inventory is empty.
    const maraContext = buildCombatTurnContext(state, 'pc:fighter');
    assert.equal(Object.hasOwn(maraContext.actor, 'spellSlots'), false);
    assert.equal(Object.hasOwn(maraContext.actor, 'knownSpells'), false);

    const orrinContext = buildCombatTurnContext(state, 'pc:wizard');
    assert.equal(Object.hasOwn(orrinContext.actor, 'inventory'), false);
    assert.equal(Object.hasOwn(orrinContext.actor, 'classFeatures'), false);
    assert.equal(Object.hasOwn(orrinContext.actor, 'classResources'), false);

    // A fully stripped (schema-1 migrated) unit still produces a usable context.
    const stripped = state.units.find(unit => unit.id === 'pc:wizard');
    stripped.spellSlots = null;
    stripped.spellsText = null;
    stripped.inventory = null;
    stripped.powers = null;
    const bare = buildCombatTurnContext(state, 'pc:wizard');
    assert.equal(bare.actor.name, 'Orrin');
    assert.equal(Object.hasOwn(bare.actor, 'spellSlots'), false);
    assert.equal(Object.hasOwn(bare.actor, 'powers'), false);
  });

  test('turn context reports an unknown combatant instead of throwing', () => {
    assert.match(buildCombatTurnContext(startCombat(), 'pc:nobody').error, /not in this fight/);
    assert.ok(buildCombatTurnContext(null, 'pc:fighter').error);
  });

  test('adjudicateCombatAction returns the parsed adjudication and sends the roll verbatim', async () => {
    const state = startCombat();
    const { calls, callFn } = stubCall(CLEAN_ADJUDICATION);

    const result = await adjudicateCombatAction({
      state,
      actingUnitId: 'pc:fighter',
      actionText: 'I charge the goblin and swing my axe. [DICE ROLL: d20 = 18 +3 STR (score 16) = 21]',
      config: aiConfig,
      callFn
    });

    assert.equal(result.narration.startsWith('Mara drives her shoulder'), true);
    assert.deepEqual(result.costs, { ap: 1, bp: 0 });
    assert.deepEqual(result.effects, [{ type: 'damage', target: 'Goblin', amount: 9 }]);
    assert.equal(result.turnEnds, true);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].messages[0].role, 'system');
    assert.equal(calls[0].messages[0].content, COMBAT_ADJUDICATOR_PROMPT);
    const userMessage = calls[0].messages[1].content;
    assert.match(userMessage, /\[DICE ROLL: d20 = 18 \+3 STR \(score 16\) = 21\]/);
    assert.match(userMessage, /"name": "Goblin"/);
    assert.match(userMessage, /Potion of Healing/);
    assert.match(userMessage, /ACTING COMBATANT: Mara — 1 AP and 1 BP remaining/);
    assert.equal(calls[0].options.temperature, 0.4);
    assert.equal(calls[0].options.maxTokens, 3000);
  });

  test('adjudicateCombatAction gives the structured roll its own authoritative block', async () => {
    const { calls, callFn } = stubCall(CLEAN_ADJUDICATION);

    await adjudicateCombatAction({
      state: startCombat(),
      actingUnitId: 'pc:fighter',
      actionText: 'I charge the goblin and swing my axe.',
      roll: { natural: 14, modifier: 3, stat: 'DEX', score: 16, total: 17 },
      config: aiConfig,
      callFn
    });

    const userMessage = calls[0].messages[1].content;
    assert.match(
      userMessage,
      /PLAYER'S DICE ROLL \(AUTHORITATIVE\): natural d20 = 14; modifier \+3 DEX \(score 16\); TOTAL = 17; outcome band: solid success\./
    );
    // The block sits after the declared action and before the closing instruction.
    assert.ok(userMessage.indexOf('DECLARED ACTION') < userMessage.indexOf("PLAYER'S DICE ROLL"));
    assert.ok(userMessage.indexOf("PLAYER'S DICE ROLL") < userMessage.indexOf('Adjudicate this action now'));
  });

  test('adjudicateCombatAction reports a natural 1 and a natural 20 by their band', async () => {
    const fumble = stubCall(CLEAN_ADJUDICATION);
    await adjudicateCombatAction({
      state: startCombat(),
      actingUnitId: 'pc:fighter',
      actionText: 'I swing.',
      roll: { natural: 1, modifier: 3, stat: 'STR', score: 16, total: 4 },
      config: aiConfig,
      callFn: fumble.callFn
    });
    assert.match(fumble.calls[0].messages[1].content, /TOTAL = 4; outcome band: critical failure\./);

    const crit = stubCall(CLEAN_ADJUDICATION);
    await adjudicateCombatAction({
      state: startCombat(),
      actingUnitId: 'pc:fighter',
      actionText: 'I swing.',
      roll: { natural: 20, modifier: 3, stat: 'STR', score: 16, total: 23 },
      config: aiConfig,
      callFn: crit.callFn
    });
    assert.match(crit.calls[0].messages[1].content, /TOTAL = 23; outcome band: critical success\./);
  });

  test('adjudicateCombatAction flags a roll with no stat modifier so attackBonus may apply', async () => {
    const { calls, callFn } = stubCall(CLEAN_ADJUDICATION);
    await adjudicateCombatAction({
      state: startCombat(),
      actingUnitId: 'pc:fighter',
      actionText: 'I swing.',
      roll: { natural: 12, modifier: 0, stat: null, score: null, total: 12 },
      config: aiConfig,
      callFn
    });
    assert.match(
      calls[0].messages[1].content,
      /PLAYER'S DICE ROLL \(AUTHORITATIVE\): natural d20 = 12; no stat modifier was chosen by the player; TOTAL = 12; outcome band: partial success\./
    );
  });

  test('adjudicateCombatAction says plainly when no roll was submitted', async () => {
    const { calls, callFn } = stubCall(CLEAN_ADJUDICATION);
    await adjudicateCombatAction({
      state: startCombat(),
      actingUnitId: 'pc:fighter',
      actionText: 'I look for a way around the goblin.',
      config: aiConfig,
      callFn
    });
    assert.match(calls[0].messages[1].content, /PLAYER'S DICE ROLL: none was submitted\./);
  });

  test('adjudicateCombatAction still reads a tag the caller failed to strip', async () => {
    const { calls, callFn } = stubCall(CLEAN_ADJUDICATION);
    await adjudicateCombatAction({
      state: startCombat(),
      actingUnitId: 'pc:fighter',
      actionText: 'I charge. [DICE ROLL: d20 = 18 +3 STR (score 16) = 21]',
      config: aiConfig,
      callFn
    });
    const userMessage = calls[0].messages[1].content;
    assert.match(userMessage, /natural d20 = 18; modifier \+3 STR \(score 16\); TOTAL = 21; outcome band: better than hoped\./);
    assert.match(userMessage, /\[DICE ROLL: d20 = 18 \+3 STR \(score 16\) = 21\]/, 'the untouched action text still goes through verbatim');
  });

  test('adjudicateCombatAction unwraps a fenced JSON response', async () => {
    const { callFn } = stubCall('Here you go:\n```json\n' + CLEAN_ADJUDICATION + '\n```\nHope that works.');
    const result = await adjudicateCombatAction({
      state: startCombat(),
      actingUnitId: 'pc:fighter',
      actionText: 'I swing.',
      config: aiConfig,
      callFn
    });
    assert.equal(result.error, undefined);
    assert.match(result.narration, /Mara drives her shoulder/);
    assert.equal(result.effects[0].amount, 9);
  });

  test('adjudicateCombatAction recovers a bare JSON object wrapped in chatter', async () => {
    const { callFn } = stubCall(`Sure thing. ${CLEAN_ADJUDICATION} Let me know if you want a reroll.`);
    const result = await adjudicateCombatAction({
      state: startCombat(),
      actingUnitId: 'pc:fighter',
      actionText: 'I swing.',
      config: aiConfig,
      callFn
    });
    assert.match(result.narration, /Mara drives her shoulder/);
  });

  test('adjudicateCombatAction reports unparseable output instead of guessing', async () => {
    const { callFn } = stubCall('I am afraid I cannot resolve that action right now.');
    const result = await adjudicateCombatAction({
      state: startCombat(),
      actingUnitId: 'pc:fighter',
      actionText: 'I swing.',
      config: aiConfig,
      callFn
    });
    assert.equal(result.error, 'unparseable');
    assert.match(result.raw, /cannot resolve that action/);
  });

  test('adjudicateCombatAction rejects JSON without narration', async () => {
    const { callFn } = stubCall(JSON.stringify({ costs: { ap: 1, bp: 0 }, effects: [], turnEnds: true }));
    const result = await adjudicateCombatAction({
      state: startCombat(),
      actingUnitId: 'pc:fighter',
      actionText: 'I swing.',
      config: aiConfig,
      callFn
    });
    assert.equal(result.error, 'unparseable');
  });

  test('adjudicateCombatAction refuses to call the AI for an unknown unit', async () => {
    const { calls, callFn } = stubCall(CLEAN_ADJUDICATION);
    const result = await adjudicateCombatAction({
      state: startCombat(),
      actingUnitId: 'pc:ghost',
      actionText: 'I swing.',
      config: aiConfig,
      callFn
    });
    assert.equal(result.error, 'unknown-unit');
    assert.equal(calls.length, 0);
  });

  test('adjudicateCombatAction surfaces a failed API call', async () => {
    const callFn = async () => { throw new Error('AI API error: 500'); };
    const result = await adjudicateCombatAction({
      state: startCombat(),
      actingUnitId: 'pc:fighter',
      actionText: 'I swing.',
      config: aiConfig,
      callFn
    });
    assert.equal(result.error, 'request-failed');
    assert.match(result.message, /500/);
  });

  test('generateEnemyCombatTurn hands the pre-rolled dice to the prompt and parses the reply', async () => {
    const state = startCombat();
    // Same rngState, so the preview rolls match what the real call will consume.
    const expected = buildEnemyPreRolls(JSON.parse(JSON.stringify(state)), 'npc:goblin');

    const enemyAdjudication = JSON.stringify({
      narration: 'The goblin darts under Mara guard and buries its blade in her thigh.',
      costs: { ap: 1, bp: 0 },
      effects: [{ type: 'damage', target: 'Mara', amount: expected.damageRoll.total }],
      turnEnds: true
    });
    const { calls, callFn } = stubCall(enemyAdjudication);

    const result = await generateEnemyCombatTurn({ state, enemyUnitId: 'npc:goblin', config: aiConfig, callFn });

    assert.equal(result.error, undefined);
    assert.match(result.narration, /The goblin darts/);
    assert.equal(result.effects[0].amount, expected.damageRoll.total);
    assert.equal(result.turnEnds, true);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].messages[0].content, COMBAT_ENEMY_TURN_PROMPT);
    const userMessage = calls[0].messages[1].content;
    assert.match(userMessage, new RegExp(`Attack roll: d20 ${expected.attackRoll.d20} \\+ ${expected.attackRoll.bonus} = TOTAL ${expected.attackRoll.total}`));
    assert.match(userMessage, new RegExp(`Damage on a hit: .* = TOTAL ${expected.damageRoll.total}`));
    assert.match(userMessage, /ACTING ENEMY: Goblin — 14\/14 HP, AC 12/);
    assert.match(userMessage, /targetSuggestion \(a hint only\)/);
    assert.equal(calls[0].options.temperature, 0.4);
  });

  test('generateEnemyCombatTurn refuses a party unit', async () => {
    const { calls, callFn } = stubCall(CLEAN_ADJUDICATION);
    const result = await generateEnemyCombatTurn({
      state: startCombat(),
      enemyUnitId: 'pc:fighter',
      config: aiConfig,
      callFn
    });
    assert.equal(result.error, 'unknown-unit');
    assert.equal(calls.length, 0);
  });
});

describe('POV image direction', () => {
  test('uses the avatar as likeness reference without splitting aliases', () => {
    assert.equal(POV_IMAGE_PROMPT_MAX_WORDS, 180);
    assert.match(POV_IMAGE_DIRECTOR_PROMPT, /avatar as a reference/);
    assert.match(POV_IMAGE_DIRECTOR_PROMPT, /alias, disguise, masquerade/);
    assert.match(POV_IMAGE_DIRECTOR_PROMPT, /never a second copy/);
    assert.match(POV_IMAGE_DIRECTOR_PROMPT, /16:9/);
    assert.match(POV_IMAGE_DIRECTOR_PROMPT, /under 180 words/);
  });
});
