// working:
// Reads a CSV file row by row — streaming, never loads whole file into memory
// For each row:
//  1 checks for duplicate transaction IDs within this file
//  2 runs validator- finds quality issues, marks row valid/invalid
//  3 runs normalizer- cleans data (only if row is valid and not duplicate)
//  4 builds a MongoDB document
//  5 collects into batches of 500
//   bulk inserts batch into MongoDB
//  7 continues to next row
// At the end flushes any remaining rows that did not fill a complete batch

const fs               = require('fs')
const { parse }        = require('csv-parse')
const { validateRow }  = require('./validator')
const { normalizeRow } = require('./normalizer')
const Transaction      = require('../../models/Transaction')
const logger           = require('../../config/logger')

const BATCH_SIZE = 500


// ── FLUSH BATCH TO MONGODB ──────────────────────────────────────
// called when batch hits BATCH_SIZE or when file ends
//
// WHY batch is cleared BEFORE insertMany:
//   double inserts corrupt reconciliation results permanently
//   a lost batch is recoverable — human can re-run ingestion
//   duplicate data in DB is not recoverable without manual cleanup
//
// IF insert fails:
//   we log every document ID that was lost
//   human can identify exactly which rows need re-ingestion
//
// ordered:false means if one doc fails MongoDB continues the rest
// without it one bad doc stops the entire 500-row batch

const flushBatch = async (batch, source, runId) => {
  if (batch.length === 0) return

  // capture IDs before clearing — needed for error logging
  const docIds    = batch.map(d => d.raw?.transaction_id ?? 'UNKNOWN')
  const toInsert  = [...batch]

  // clear BEFORE insert — prevents double inserts if called twice
  batch.length = 0

  try {
    await Transaction.insertMany(toInsert, { ordered: false })
    logger.info(
      `Batch inserted | source=${source} | runId=${runId} | count=${toInsert.length}`
    )
  } catch (err) {
    logger.error(
      `Batch insert failure | source=${source} | runId=${runId} | error=${err.message} | lost_ids=${docIds.join(', ')}`
    )
  }
}


// mkaing the document for collection
// assembles all computed pieces into one MongoDB document
// separated from main flow for readability

const buildDocument = ({
  row,
  isDuplicate,
  isValid,
  qualityFlags,
  flaggedFields,
  normalized,
  normalizationChanges,
  runId,
  source,
}) => {
  return {
    runId,
    source,

    raw: row,            

    normalized:           isValid && !isDuplicate ? normalized           : null,
    normalizationChanges: isValid && !isDuplicate ? normalizationChanges : {},

    isValid:       isValid && !isDuplicate,
    qualityFlags,
    flaggedFields,
  }
}


//one row processed at a time
// all per-row logic extracted here
// keeps the main for await loop clean and readable

const processRow = ({ row, seenIds, stats, source, runId }) => {

  stats.total++

  //duplicate check

  const txId = row.transaction_id
    ? String(row.transaction_id).trim()
    : null

  let isDuplicate = false

  if (txId && seenIds.has(txId)) {
    isDuplicate = true
    logger.warn(
      `Duplicate ID | source=${source} | id=${txId} | runId=${runId}`
    )
  } else if (txId) {
    seenIds.add(txId)
  }

  //final validatoin
  // checks every field for format and value problems
  // returns isValid, qualityFlags (key-value), flaggedFields (array)

  const { isValid, qualityFlags, flaggedFields } = validateRow(row)

//merginf quality flags accordingly

  if (isDuplicate) {
    qualityFlags['transaction_id'] = {
      issue:    'DUPLICATE_ID',
      rawValue: txId ?? '',
      message:  `Transaction ID "${txId}" already seen in this file`,
    }
    if (!flaggedFields.includes('transaction_id')) {
      flaggedFields.push('transaction_id')
    }
  }

  // normalizer
  // only runs if row passed validation AND is not a duplicate
  // no point cleaning data the matching engine will skip
  // normalizer trusts validator completely — no re-checking

  let normalized           = null
  let normalizationChanges = {}

  if (isValid && !isDuplicate) {
    try {
      const result         = normalizeRow(row)
      normalized           = result.normalized
      normalizationChanges = result.normalizationChanges
    } catch (err) {
      logger.error(
        `Normalizer threw unexpectedly | source=${source} | id=${txId} | error=${err.message}`
      )
      normalized           = null
      normalizationChanges = {}
    }
  }


  const rowIsValid = isValid && !isDuplicate

  if (rowIsValid) {
    stats.valid++
  } else {
    stats.invalid++


    const reasons = Object.entries(qualityFlags)
      .map(([field, flag]) => `${field}:${flag.issue}`)
      .join(', ')

    logger.warn(
      `Invalid row | source=${source} | id=${txId ?? 'MISSING'} | runId=${runId} | reasons=${reasons}`
    )
  }

  return buildDocument({
    row,
    isDuplicate,
    isValid,
    qualityFlags,
    flaggedFields,
    normalized,
    normalizationChanges,
    runId,
    source,
  })
}


const parseAndIngest = async (filePath, source, runId) => {

  const stats = {
    total:   0,
    valid:   0,
    invalid: 0,
  }

  const seenIds = new Set()
  let   batch   = []

  // creating the CSV parser stream
  const parser = fs
    .createReadStream(filePath)
    .pipe(
      parse({
        columns:          true,   
        skip_empty_lines: true,   
        trim:             true,   
        relax_quotes:     true,   
      })
    )

  // for await waits for each row to fully process

  for await (const row of parser) {

    const doc = processRow({ row, seenIds, stats, source, runId })
    batch.push(doc)

    if (batch.length >= BATCH_SIZE) {
      await flushBatch(batch, source, runId)
      batch = []
    }
  }

  // flush remaining rows that never filled a complete batch
  if (batch.length > 0) {
    await flushBatch(batch, source, runId)
    batch = []
  }

  logger.info(
    `Ingestion complete | source=${source} | runId=${runId} | total=${stats.total} | valid=${stats.valid} | invalid=${stats.invalid}`
  )

  return stats
}


module.exports = { parseAndIngest }