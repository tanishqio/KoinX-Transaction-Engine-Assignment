// src/models/ReconciliationRun.js
//
// WHAT THIS FILE DOES:
// One document per POST /reconcile call
// Tracks status, config used, and summary counts
// Client uses the runId from this to fetch reports

const mongoose = require('mongoose')

const reconciliationRunSchema = new mongoose.Schema({

  runId: {
    type:     String,
    required: true,
    unique:   true,   // one document per run, no duplicates
  },

  // tolerance config used for this specific run
  // stored so you can reproduce the same results later
  config: {
    timestampToleranceSecs: { type: Number },
    quantityTolerancePct:   { type: Number },
  },

  status: {
    type:    String,
    enum:    ['pending', 'running', 'complete', 'failed'],
    default: 'pending',
  },

  // counts filled in after matching engine completes
summary: {
    exactMatch:        { type: Number, default: 0 },
    matched:           { type: Number, default: 0 },
    conflicting:       { type: Number, default: 0 },
    unmatchedUser:     { type: Number, default: 0 },
    unmatchedExchange: { type: Number, default: 0 },
    totalUser:         { type: Number, default: 0 },
    totalExchange:     { type: Number, default: 0 },
    invalidRows:       { type: Number, default: 0 },
},

  // filled if status = 'failed'
  errorMessage: {
    type:    String,
    default: null,
  },

  createdAt: {
    type:    Date,
    default: Date.now,
  },

  // filled when status becomes 'complete' or 'failed'
  completedAt: {
    type:    Date,
    default: null,
  },

})

reconciliationRunSchema.index({ runId: 1 })
reconciliationRunSchema.index({ status: 1 })

module.exports = mongoose.model('ReconciliationRun', reconciliationRunSchema)