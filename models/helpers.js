// models/helpers.js
// Shared row-shaping helpers, applied at each model's boundary so callers only
// ever see real values.

/** Anything date-ish in, a Date or null out. Never an Invalid Date. */
function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

module.exports = { toDate };
