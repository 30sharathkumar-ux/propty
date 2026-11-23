/**
 * src/validation/index.js
 * Hand-written schema validator. No external libraries.
 * Rejects unknown fields and validates types, lengths, enums, date ranges.
 */

/** @typedef {{ error: string } | { value: any }} ValidationResult */

const MAX_STRING = 2000;
const MAX_ABSTRACT = 5000;

/**
 * Validate a value against a simple schema descriptor.
 * @param {unknown} value
 * @param {object} schema
 * @param {string} [path]
 * @returns {string|null} error message or null
 */
function validateField(value, schema, path = 'field') {
  if (schema.required !== false && (value === undefined || value === null || value === '')) {
    return `${path} is required`;
  }
  if ((value === undefined || value === null) && schema.required === false) {
    return null;
  }

  if (schema.type === 'string') {
    if (typeof value !== 'string') { return `${path} must be a string`; }
    if (schema.minLength && value.trim().length < schema.minLength) {
      return `${path} must be at least ${schema.minLength} characters`;
    }
    const maxLen = schema.maxLength ?? MAX_STRING;
    if (value.length > maxLen) { return `${path} must be at most ${maxLen} characters`; }
    if (schema.enum && !schema.enum.includes(value)) {
      return `${path} must be one of: ${schema.enum.join(', ')}`;
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      return `${path} has invalid format`;
    }
  }

  if (schema.type === 'number') {
    if (typeof value !== 'number' || isNaN(value)) { return `${path} must be a number`; }
    if (schema.min !== undefined && value < schema.min) { return `${path} must be >= ${schema.min}`; }
    if (schema.max !== undefined && value > schema.max) { return `${path} must be <= ${schema.max}`; }
  }

  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') { return `${path} must be a boolean`; }
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) { return `${path} must be an array`; }
    if (schema.minItems && value.length < schema.minItems) {
      return `${path} must have at least ${schema.minItems} items`;
    }
    if (schema.maxItems && value.length > schema.maxItems) {
      return `${path} must have at most ${schema.maxItems} items`;
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const err = validateField(value[i], schema.items, `${path}[${i}]`);
        if (err) { return err; }
      }
    }
  }

  if (schema.type === 'isodate') {
    if (typeof value !== 'string') { return `${path} must be a date string`; }
    const d = new Date(value);
    if (isNaN(d.getTime())) { return `${path} must be a valid ISO date`; }
    if (schema.future && d <= new Date()) { return `${path} must be in the future`; }
  }

  return null;
}

/**
 * Validate an object against an object schema (map of field -> descriptor).
 * Unknown fields cause an error.
 * @param {unknown} body
 * @param {Record<string, object>} schema
 * @returns {{ error: string }|{ value: object }}
 */
function validateObject(body, schema) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object' };
  }

  // Reject unknown fields
  for (const key of Object.keys(body)) {
    if (!(key in schema)) {
      return { error: `Unknown field: ${key}` };
    }
  }

  const result = {};
  for (const [key, fieldSchema] of Object.entries(schema)) {
    const err = validateField(body[key], fieldSchema, key);
    if (err) { return { error: err }; }
    if (body[key] !== undefined) { result[key] = body[key]; }
  }
  return { value: result };
}

// ── Project schema ────────────────────────────────────────────────────────────
export function validateProject(body) {
  return validateObject(body, {
    title:       { type: 'string', minLength: 3, maxLength: 200 },
    abstract:    { type: 'string', minLength: 10, maxLength: MAX_ABSTRACT },
    teamMembers: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 100 } },
    courseCode:  { type: 'string', minLength: 2, maxLength: 20 },
    hardDeadline:{ type: 'isodate', future: true },
    hoursNeeded: { type: 'number', min: 1, max: 500 },
  });
}

// ── Booking schema ────────────────────────────────────────────────────────────
export function validateBookingRequest(body) {
  return validateObject(body, {
    projectId: { type: 'string', minLength: 1, maxLength: 100 },
    itemId:    { type: 'string', minLength: 1, maxLength: 100 },
    start:     { type: 'isodate', future: true },
    end:       { type: 'isodate', future: true },
  });
}

// ── Approval action schema ────────────────────────────────────────────────────
export function validateApprovalAction(body) {
  return validateObject(body, {
    action:  { type: 'string', enum: ['approve', 'reject', 'request_changes'] },
    comment: { type: 'string', required: false, maxLength: 2000 },
  });
}

// ── Conflict demo schema ──────────────────────────────────────────────────────
export function validateConflictDemo(body) {
  return validateObject(body, {
    itemId: { type: 'string', minLength: 1, maxLength: 100 },
  });
}

// ── Search schema ─────────────────────────────────────────────────────────────
export function validateSearchQuery(query) {
  const errors = [];
  if (query.q !== undefined && typeof query.q !== 'string') { errors.push('q must be a string'); }
  if (query.q && query.q.length > 500) { errors.push('q too long'); }
  if (query.department && typeof query.department !== 'string') { errors.push('department must be a string'); }
  if (query.category && typeof query.category !== 'string') { errors.push('category must be a string'); }
  if (query.status && !['available', 'in_use', 'maintenance', 'approval_required'].includes(query.status)) {
    errors.push('invalid status filter');
  }
  if (query.tier && !['1', '2', '3'].includes(query.tier)) { errors.push('tier must be 1, 2, or 3'); }
  if (query.page && isNaN(parseInt(query.page, 10))) { errors.push('page must be a number'); }
  if (query.pageSize && isNaN(parseInt(query.pageSize, 10))) { errors.push('pageSize must be a number'); }
  return errors.length ? { error: errors.join('; ') } : { value: query };
}

// ── Clock override schema (admin/demo) ────────────────────────────────────────
export function validateClockSet(body) {
  return validateObject(body, {
    isoDate: { type: 'isodate' },
  });
}

// ── Checkin schema ────────────────────────────────────────────────────────────
export function validateCheckin(body) {
  return validateObject(body, {
    token: { type: 'string', minLength: 10, maxLength: 500 },
  });
}

// ── Waitlist action ───────────────────────────────────────────────────────────
export function validateWaitlistAction(body) {
  return validateObject(body, {
    bookingId: { type: 'string', minLength: 1, maxLength: 100 },
    action:    { type: 'string', enum: ['accept', 'decline'] },
  });
}
