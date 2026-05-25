// work of this file
// Defines default matching tolerances
// Values come from .env file
// If not set in .env, falls back to defaults
// These can be overridden per-run via POST /reconcile request body

module.exports = {

  TIMESTAMP_TOLERANCE_SECONDS:
    parseInt(process.env.TIMESTAMP_TOLERANCE_SECONDS) || 300,

  QUANTITY_TOLERANCE_PCT:
    parseFloat(process.env.QUANTITY_TOLERANCE_PCT) || 0.01,
}