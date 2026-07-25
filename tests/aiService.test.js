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
} = require('../server/services/aiService.js');

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
