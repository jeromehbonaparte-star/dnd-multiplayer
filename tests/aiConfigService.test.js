const test = require('node:test');
const assert = require('node:assert/strict');
const { getApiConfigForRole } = require('../server/services/aiConfigService');

function createDb({ settings = {}, configs = [] } = {}) {
  return {
    prepare(sql) {
      if (sql.includes('FROM settings')) {
        return { get: key => settings[key] === undefined ? undefined : { value: settings[key] } };
      }
      if (sql.includes('WHERE id = ?')) {
        return { get: id => configs.find(config => config.id === id) };
      }
      if (sql.includes('is_active = 1')) {
        return { get: () => configs.find(config => config.is_active) };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
}

const narrator = {
  id: 'narrator', name: 'Opus', endpoint: 'https://anthropic.example/messages',
  api_key: 'narrator-key', model: 'claude-opus', reasoning_effort: '', is_active: 0
};
const fallback = {
  id: 'fallback', name: 'Default', endpoint: 'https://openai.example/chat/completions',
  api_key: 'fallback-key', model: 'gpt-agent', reasoning_effort: 'low', is_active: 1
};

test('resolves an explicitly assigned narrator configuration', () => {
  const db = createDb({ settings: { narrator_api_config_id: 'narrator' }, configs: [narrator, fallback] });
  assert.deepEqual(getApiConfigForRole(db, 'narrator'), {
    id: 'narrator', name: 'Opus', endpoint: narrator.endpoint,
    api_key: 'narrator-key', model: 'claude-opus', reasoning_effort: ''
  });
});

test('falls back to the active configuration for unassigned or stale roles', () => {
  const unassigned = createDb({ settings: { agent_api_config_id: '' }, configs: [narrator, fallback] });
  const stale = createDb({ settings: { agent_api_config_id: 'deleted' }, configs: [narrator, fallback] });
  assert.equal(getApiConfigForRole(unassigned, 'agent').id, 'fallback');
  assert.equal(getApiConfigForRole(stale, 'agent').id, 'fallback');
  assert.equal(getApiConfigForRole(stale, 'agent').reasoning_effort, 'low');
});

test('rejects unknown AI roles', () => {
  assert.throws(() => getApiConfigForRole(createDb(), 'illustrator'), /Unknown AI configuration role/);
});
