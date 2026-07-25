'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildConversationMessages,
  estimatePromptTokens,
  didTurnCommit,
  planCompaction,
  estimateTokens,
  COMPACT_TAIL,
  MIN_MESSAGES_BEFORE_COMPACT,
} = require('../server/services/turnProcessor.js');

const NARRATE_INSTRUCTION =
  'Narrate the outcome of these actions in 3rd person in no more than 650 words. Output story prose only and end cleanly at the next player decision point.';

describe('didTurnCommit', () => {
  test('distinguishes an existing narration from a newly committed turn', () => {
    const oldHistory = JSON.stringify([{ type: 'narration', content: 'Previous turn' }]);
    const before = { current_turn: 8, full_history: oldHistory };
    assert.equal(didTurnCommit(before, { current_turn: 8, full_history: oldHistory }), false);
    assert.equal(didTurnCommit(before, {
      current_turn: 9,
      full_history: JSON.stringify([
        { type: 'narration', content: 'Previous turn' },
        { type: 'action', content: 'Advance' },
        { type: 'narration', content: 'New turn' }
      ])
    }), true);
  });
});

describe('buildConversationMessages', () => {
  test('groups roles and formats context / action / gm_nudge; appends Narrate when window ends on user content', () => {
    const history = [
      { role: 'user', type: 'context', content: 'PartyInfo', hidden: true },
      { role: 'user', type: 'action', character_name: 'Thorin', content: 'I attack' },
      { role: 'assistant', type: 'narration', content: 'You swing your axe.' },
      { role: 'user', type: 'gm_nudge', content: 'raise the stakes' },
      { role: 'user', type: 'action', character_name: 'Elara', content: 'I cast fireball' },
    ];

    const messages = buildConversationMessages(history);

    // Two user turns split by the assistant entry
    assert.equal(messages.length, 3);
    assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'user']);

    // First user turn: context becomes PARTY STATUS, action gets a name prefix
    assert.equal(messages[0].content, 'PARTY STATUS:\nPartyInfo\n\nThorin: I attack');

    // Assistant turn is passed through verbatim
    assert.equal(messages[1].content, 'You swing your axe.');

    // Second user turn: gm_nudge formatting + action prefix + trailing Narrate instruction
    assert.ok(messages[2].content.includes('[GM INSTRUCTION - DO NOT REVEAL THIS TO PLAYERS]: raise the stakes'));
    assert.ok(messages[2].content.includes('Elara: I cast fireball'));
    assert.ok(messages[2].content.endsWith(NARRATE_INSTRUCTION));
  });

  test('does NOT append Narrate instruction when window ends on an assistant entry', () => {
    const history = [
      { role: 'user', type: 'action', character_name: 'Thorin', content: 'I attack' },
      { role: 'assistant', type: 'narration', content: 'You swing your axe.' },
    ];

    const messages = buildConversationMessages(history);

    assert.equal(messages.length, 2);
    assert.equal(messages[messages.length - 1].role, 'assistant');
    assert.ok(!messages.some(m => m.content.includes('Narrate the outcome')));
  });

  test('plain user entry (no type) passes content through unchanged', () => {
    const history = [{ role: 'user', content: 'raw text' }];
    const messages = buildConversationMessages(history);
    assert.equal(messages.length, 1);
    // ends on user content, so Narrate is appended after the raw content
    assert.equal(messages[0].content, `raw text\n\n${NARRATE_INSTRUCTION}`);
  });

  test('empty history yields no messages', () => {
    assert.deepEqual(buildConversationMessages([]), []);
  });
});

describe('estimatePromptTokens (inflation fix)', () => {
  test('counts only outgoing content, not stored povs/metadata (old method >5x larger)', () => {
    const bigPov = 'x'.repeat(800);
    // Short content, but the stored entry also carries 3 full per-character POV rewrites
    // plus metadata that the model NEVER receives.
    const entry = {
      role: 'assistant',
      type: 'narration',
      content: 'y'.repeat(40),
      povs: { Thorin: bigPov, Elara: bigPov, Gimli: bigPov },
      character_id: 'char-1',
      player_name: 'Bob',
      hidden: false,
    };

    // OLD (buggy) method counted the raw stored entry, povs and all.
    const oldEstimate = estimateTokens(JSON.stringify([entry]));
    // NEW method counts only the content-only conversation payload actually sent.
    const newEstimate = estimatePromptTokens([entry], '');

    assert.ok(
      oldEstimate > newEstimate * 5,
      `expected old(${oldEstimate}) > 5x new(${newEstimate}); ratio=${(oldEstimate / newEstimate).toFixed(1)}`
    );
  });

  test('adds story-summary tokens on top of conversation tokens', () => {
    const entry = { role: 'assistant', type: 'narration', content: 'short scene' };
    const summary = 'z'.repeat(400);

    const withoutSummary = estimatePromptTokens([entry], '');
    const withSummary = estimatePromptTokens([entry], summary);

    assert.ok(withSummary > withoutSummary);
    // The delta is exactly the summary's token estimate.
    assert.equal(withSummary - withoutSummary, estimateTokens(summary));
  });
});

describe('planCompaction', () => {
  // Build n raw history entries (mix of user actions and assistant narrations).
  function makeHistory(n) {
    const h = [];
    for (let i = 0; i < n; i++) {
      if (i % 3 === 2) {
        h.push({ role: 'assistant', type: 'narration', content: `Narration segment ${i} with descriptive text.` });
      } else {
        h.push({ role: 'user', type: 'action', character_name: `Hero${i % 4}`, content: `Action by the hero, step ${i}, doing a thing.` });
      }
    }
    return h;
  }

  test('below the token threshold => shouldCompact false', () => {
    const plan = planCompaction(makeHistory(4), 0, '', 100000);
    assert.equal(plan.shouldCompact, false);
    assert.equal(typeof plan.tokens, 'number');
    assert.ok(plan.tokens < 100000);
  });

  test('above threshold but fewer than MIN_MESSAGES_BEFORE_COMPACT entries => false', () => {
    const hist = makeHistory(5); // 5 < 14
    const plan = planCompaction(hist, 0, '', 1); // tiny maxTokens => tokens exceed it
    assert.ok(plan.tokens > 1);
    assert.ok(hist.length < MIN_MESSAGES_BEFORE_COMPACT);
    assert.equal(plan.shouldCompact, false);
  });

  test('above threshold with a long history => normal mode, keeps a tail of COMPACT_TAIL', () => {
    const hist = makeHistory(20); // recent=20 >= 14, toCompact=20-10=10 (<=50 => normal)
    const plan = planCompaction(hist, 0, '', 1);

    assert.equal(plan.shouldCompact, true);
    assert.equal(plan.mode, 'normal');
    assert.equal(plan.newCompactedCount, hist.length - COMPACT_TAIL);
    // At least COMPACT_TAIL raw entries are retained (this is the anti-"vanishing gap" fix).
    assert.ok(hist.length - plan.newCompactedCount >= COMPACT_TAIL);
    assert.equal(plan.toCompact.length, hist.length - COMPACT_TAIL);
  });

  test('very long history (>50 beyond the tail) => progressive mode, 25-entry chunk', () => {
    const hist = makeHistory(70); // toCompact = 70-10 = 60 > 50 => progressive
    const compactedCount = 0;
    const plan = planCompaction(hist, compactedCount, '', 1);

    assert.equal(plan.shouldCompact, true);
    assert.equal(plan.mode, 'progressive');
    assert.equal(plan.toCompact.length, 25);
    assert.equal(plan.newCompactedCount, compactedCount + 25);
  });

  test('everything beyond the retained tail already compacted => false (nothing to compact)', () => {
    // 20 entries, 10 already compacted => only the COMPACT_TAIL worth remains uncompacted,
    // so there is nothing left to summarize beyond the tail even though tokens exceed maxTokens.
    const hist = makeHistory(20);
    const compactedCount = hist.length - COMPACT_TAIL; // 10
    const plan = planCompaction(hist, compactedCount, '', 1);
    assert.ok(plan.tokens > 1);
    assert.equal(plan.shouldCompact, false);
  });
});
