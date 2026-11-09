// Search radius in metres from ?radius= / body.radius.
// Missing or invalid values fall back to the default; anything else is kept
// between 100 m and 50 km so one request cannot pull the whole database.
const DEFAULT_RADIUS_M = 5000;
const MIN_RADIUS_M = 100;
const MAX_RADIUS_M = 50000;

function parseRadius(value) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return DEFAULT_RADIUS_M;
  return Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, n));
}

module.exports = { parseRadius, DEFAULT_RADIUS_M, MIN_RADIUS_M, MAX_RADIUS_M };
