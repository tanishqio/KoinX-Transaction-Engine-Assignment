// src/models/ReportEntry.js
//
// WHAT THIS FILE DOES:
// One document per result from the matching engine
// Four possible categories:
//
//   MATCHED            → found on both sides, all fields within tolerance
//   CONFLICTING        → found on both sides, but some fields exceed tolerance
//   UNMATCHED_USER     → only in user file, nothing found on exchange side
//   UNMATCHED_EXCHANGE → only in exchange file, nothing found on user side

const mongoose = require('mongoose')

// ── CONFLICT DETAIL SCHEMA ────────────────────────────────────
// one entry per field that failed tolerance check
// only used in CONFLICTING category
const conflictDetailSchema = new mongoose.Schema({
  field: { type: String },

  userValue:     { type: mongoose.Schema.Types.Mixed },
  exchangeValue: { type: mongoose.Schema.Types.Mixed },

  // for quantity field
  difference:        { type: Number,  default: null },
  differencePercent: { type: String,  default: null },
  toleranceAllowed:  { type: String,  default: null },

  // for timestamp field
  differenceSeconds: { type: Number,  default: null },
  toleranceSeconds:  { type: Number,  default: null },

  reason: { type: String },

}, { _id: false })


// ── MAIN REPORT ENTRY SCHEMA ──────────────────────────────────
const reportEntrySchema = new mongoose.Schema({

  runId: {
    type:     String,
    required: true,
  },

category: {
    type:     String,
    enum:     ['EXACT_MATCH', 'MATCHED', 'CONFLICTING', 'UNMATCHED_USER', 'UNMATCHED_EXCHANGE'],
    required: true,
},

  // human readable explanation of why this category
  // examples:
  //   "All fields matched within tolerance"
  //   "Quantity delta 0.033% exceeds tolerance 0.01%"
  //   "No exchange record found within 300 second window for BTC BUY"
  reason: {
    type:     String,
    required: true,
  },

  // full transaction document from user side
  // null for UNMATCHED_EXCHANGE
  userTx: {
    type:    mongoose.Schema.Types.Mixed,
    default: null,
  },

  // full transaction document from exchange side
  // null for UNMATCHED_USER
  exchangeTx: {
    type:    mongoose.Schema.Types.Mixed,
    default: null,
  },

  // only populated for CONFLICTING
  // empty array for all other categories
  conflicts: {
    type:    [conflictDetailSchema],
    default: [],
  },

  createdAt: {
    type:    Date,
    default: Date.now,
  },

})

// fetch full report for a run
reportEntrySchema.index({ runId: 1 })

// fetch only specific category for a run
// used by GET /report/:runId/unmatched
reportEntrySchema.index({ runId: 1, category: 1 })

module.exports = mongoose.model('ReportEntry', reportEntrySchema)