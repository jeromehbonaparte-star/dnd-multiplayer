const ROLE_SETTING_KEYS = {
  narrator: 'narrator_api_config_id',
  agent: 'agent_api_config_id'
};

function formatAIConfig(config) {
  if (!config) return null;
  return {
    id: config.id,
    name: config.name,
    endpoint: config.endpoint,
    api_key: config.api_key,
    model: config.model,
    reasoning_effort: config.reasoning_effort || ''
  };
}

function getApiConfigForRole(db, role) {
  const settingKey = ROLE_SETTING_KEYS[role];
  if (!settingKey) throw new Error(`Unknown AI configuration role: ${role}`);

  const assignedId = db.prepare('SELECT value FROM settings WHERE key = ?').get(settingKey)?.value;
  const assignedConfig = assignedId
    ? db.prepare('SELECT * FROM api_configs WHERE id = ?').get(assignedId)
    : null;
  const fallbackConfig = assignedConfig || db.prepare('SELECT * FROM api_configs WHERE is_active = 1').get();
  return formatAIConfig(fallbackConfig);
}

module.exports = {
  ROLE_SETTING_KEYS,
  formatAIConfig,
  getApiConfigForRole
};
