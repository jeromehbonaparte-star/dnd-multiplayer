/**
 * Input Validation Utilities
 * Simple validation without external dependencies
 */

const validate = {
  isString: (val, maxLen = 10000) => typeof val === 'string' && val.length <= maxLen,
  isNumber: (val, min = -Infinity, max = Infinity) => typeof val === 'number' && !isNaN(val) && val >= min && val <= max,
  isBoolean: (val) => typeof val === 'boolean',
  isArray: (val, maxLen = 1000) => Array.isArray(val) && val.length <= maxLen,
  isObject: (val) => val && typeof val === 'object' && !Array.isArray(val),
  isUUID: (val) => typeof val === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val),
  isEmail: (val) => typeof val === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val),
  sanitizeString: (val, maxLen = 10000) => {
    if (typeof val !== 'string') return '';
    return val.slice(0, maxLen).trim();
  },
  sanitizeInt: (val, defaultVal = 0, min = -Infinity, max = Infinity) => {
    const num = parseInt(val, 10);
    if (isNaN(num)) return defaultVal;
    return Math.max(min, Math.min(max, num));
  }
};

/**
 * Validation middleware factory
 * @param {Object} schema - Validation schema
 * @returns {Function} Express middleware
 */
function validateBody(schema) {
  return (req, res, next) => {
    const errors = [];
    for (const [field, rules] of Object.entries(schema)) {
      const value = req.body[field];
      if (rules.required && (value === undefined || value === null || value === '')) {
        errors.push(`${field} is required`);
        continue;
      }
      if (value !== undefined && value !== null && value !== '') {
        if (rules.type === 'string' && !validate.isString(value, rules.maxLen || 10000)) {
          errors.push(`${field} must be a string (max ${rules.maxLen || 10000} chars)`);
        }
        if (rules.type === 'number' && !validate.isNumber(value, rules.min, rules.max)) {
          errors.push(`${field} must be a number${rules.min !== undefined ? ` >= ${rules.min}` : ''}${rules.max !== undefined ? ` <= ${rules.max}` : ''}`);
        }
        if (rules.type === 'boolean' && !validate.isBoolean(value)) {
          errors.push(`${field} must be a boolean`);
        }
        if (rules.type === 'uuid' && !validate.isUUID(value)) {
          errors.push(`${field} must be a valid UUID`);
        }
        if (rules.type === 'array' && !validate.isArray(value, rules.maxLen || 1000)) {
          errors.push(`${field} must be an array (max ${rules.maxLen || 1000} items)`);
        }
      }
    }
    if (errors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }
    next();
  };
}

// Validation schemas
const schemas = {
  character: {
    player_name: { required: true, type: 'string', maxLen: 100 },
    character_name: { required: true, type: 'string', maxLen: 100 },
    race: { required: true, type: 'string', maxLen: 100 },
    class: { required: true, type: 'string', maxLen: 100 },
    strength: { required: true, type: 'number', min: 1, max: 30 },
    dexterity: { required: true, type: 'number', min: 1, max: 30 },
    constitution: { required: true, type: 'number', min: 1, max: 30 },
    intelligence: { required: true, type: 'number', min: 1, max: 30 },
    wisdom: { required: true, type: 'number', min: 1, max: 30 },
    charisma: { required: true, type: 'number', min: 1, max: 30 },
    background: { type: 'string', maxLen: 5000 }
  },
  session: {
    name: { required: true, type: 'string', maxLen: 200 },
    scenario: { type: 'string', maxLen: 100 },
    scenarioPrompt: { type: 'string', maxLen: 10000 },
    characterIds: { type: 'array', maxLen: 50 }
  },
  auth: {
    password: { required: true, type: 'string', maxLen: 200 }
  },
  adminAuth: {
    adminPassword: { required: true, type: 'string', maxLen: 200 }
  }
};

module.exports = {
  validate,
  validateBody,
  schemas
};
