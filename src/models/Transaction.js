// WHAT THIS FILE DOES:
// Defines the MongoDB schema for a single transaction row
// One document = one row from either CSV file
//
// Three main sections per document:
//   raw                  → exact CSV data, never modified
//   normalized           → machine readable version, null if invalid
//   normalizationChanges → audit trail of what changed and why
//
// qualityFlags  → key-value object, key=fieldname, value=problem detail
// flaggedFields → array of field names for fast MongoDB querying

const mongoose = require('mongoose')

// ── QUALITY FLAG DETAIL SCHEMA ────────────────────────────────
// shape of each individual flag inside qualityFlags object
// _id false because these are embedded objects not documents
const qualityFlagDetailSchema = new mongoose.Schema({
  issue:    { type: String },
  rawValue: { type: String },
  message:  { type: String },
}, { _id: false })


// ── NORMALIZED DATA SCHEMA ────────────────────────────────────
// shape of the normalized field
// all fields optional because partial normalization is possible
const normalizedSchema = new mongoose.Schema({
  transaction_id: { type: String,  default: null },
  timestamp:      { type: Date,    default: null },
  type:           { type: String,  default: null },
  asset:          { type: String,  default: null },
  quantity:       { type: Number,  default: null },
  price_usd:      { type: Number,  default: null },
  fee:            { type: Number,  default: null },
}, { _id: false })


// ── NORMALIZATION CHANGE SCHEMA ───────────────────────────────
// shape of each entry inside normalizationChanges object
const normalizationChangeSchema = new mongoose.Schema({
  from:   { type: String },
  to:     { type: String },
  reason: { type: String },
}, { _id: false })


// ── MAIN TRANSACTION SCHEMA ───────────────────────────────────
const transactionSchema = new mongoose.Schema({

  runId: {
    type:     String,
    required: true,
  },

  source: {
    type:     String,
    enum:     ['user', 'exchange'],
    required: true,
  },

  // exact CSV row stored as-is
  // every field is a string because CSV has no types
  // we never modify this after storage
  raw: {
    transaction_id: { type: String, default: null },
    timestamp:      { type: String, default: null },
    type:           { type: String, default: null },
    asset:          { type: String, default: null },
    quantity:       { type: String, default: null },
    price_usd:      { type: String, default: null },
    fee:            { type: String, default: null },
    note:           { type: String, default: null },
  },

  // cleaned machine-readable version
  // null if row failed validation
  normalized: {
    type:    normalizedSchema,
    default: null,
  },

  // key = field name that changed
  // value = { from, to, reason }
  // empty object if nothing changed or row was invalid
  normalizationChanges: {
    type: Map,
    of:   normalizationChangeSchema,
    default: {},
  },

  // false if any field failed validation
  // false if row is a duplicate
  isValid: {
    type:    Boolean,
    default: true,
  },

  // key = field name
  // value = { issue, rawValue, message }
  // empty object if no issues found
  qualityFlags: {
    type: Map,
    of:   qualityFlagDetailSchema,
    default: {},
  },

  // array of field names that have issues
  // same info as qualityFlags keys but as array
  // needed because MongoDB cannot query on dynamic object keys
  // but CAN query on array values efficiently with an index
  flaggedFields: {
    type:    [String],
    default: [],
  },

  createdAt: {
    type:    Date,
    default: Date.now,
  },

})


// ── INDEXES ───────────────────────────────────────────────────
// created once at app startup via Transaction.createIndexes()
// MongoDB skips creation if index already exists

// fetch all transactions for a run
transactionSchema.index({ runId: 1 })

// fetch user or exchange side for a run
transactionSchema.index({ source: 1, runId: 1 })

// matching engine queries by asset + timestamp window
// compound index — order matters, asset first then timestamp
transactionSchema.index({
  'normalized.asset':     1,
  'normalized.timestamp': 1,
})

// fetch only valid rows for matching
transactionSchema.index({ isValid: 1, runId: 1 })

// find all rows with a specific field flagged
transactionSchema.index({ flaggedFields: 1 })


module.exports = mongoose.model('Transaction', transactionSchema)