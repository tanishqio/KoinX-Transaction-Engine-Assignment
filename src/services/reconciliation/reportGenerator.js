// Working of this file:
// Takes raw results from matchingEngine
// Saves them as ReportEntry documents in MongoDB
// Updates ReconciliationRun status to 'complete' with summary counts

const ReportEntry       = require('../../models/ReportEntry')
const ReconciliationRun = require('../../models/ReconciliationRun')
const logger            = require('../../config/logger')

const BATCH_SIZE = 500

const generateReport = async (runId, matchingResults) => {
  const { matched, conflicting, unmatchedUser, unmatchedExchange } = matchingResults

  const entries = []

  for (const result of matched) {
    entries.push({
      runId,
      category:   result.category,  
      reason:     result.reason,
      userTx:     result.userTx,
      exchangeTx: result.exchangeTx,
      conflicts:  result.conflicts,
    })
  }

  // conflicting
  for (const result of conflicting) {
    entries.push({
      runId,
      category:   'CONFLICTING',
      reason:     result.reason,
      userTx:     result.userTx,
      exchangeTx: result.exchangeTx,
      conflicts:  result.conflicts,
    })
  }

  // unmatched user
  for (const tx of unmatchedUser) {
    entries.push({
      runId,
      category:   'UNMATCHED_USER',
      reason:     `No matching exchange record found for ${tx.normalized?.asset} ${tx.normalized?.type}`,
      userTx:     tx,
      exchangeTx: null,
      conflicts:  [],
    })
  }

  // unmatched exchange
  for (const tx of unmatchedExchange) {
    entries.push({
      runId,
      category:   'UNMATCHED_EXCHANGE',
      reason:     `No matching user record found for ${tx.normalized?.asset} ${tx.normalized?.type}`,
      userTx:     null,
      exchangeTx: tx,
      conflicts:  [],
    })
  }

  // bulk insert in batches
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE)
    await ReportEntry.insertMany(batch, { ordered: false })
    logger.info(`Report entries inserted | runId=${runId} | batch=${batch.length}`)
  }

  // calculate summary counts
  const summary = {
    exactMatch:        matched.filter(m => m.category === 'EXACT_MATCH').length,
    matched:           matched.filter(m => m.category === 'MATCHED').length,
    conflicting:       conflicting.length,
    unmatchedUser:     unmatchedUser.length,
    unmatchedExchange: unmatchedExchange.length,
  }
//marking status as complete for reference
  await ReconciliationRun.findOneAndUpdate(
    { runId },
    {
      status:      'complete',
      completedAt: new Date(),
      'summary.exactMatch':        summary.exactMatch,
      'summary.matched':           summary.matched,
      'summary.conflicting':       summary.conflicting,
      'summary.unmatchedUser':     summary.unmatchedUser,
      'summary.unmatchedExchange': summary.unmatchedExchange,
    }
  )

  logger.info(`Run marked complete | runId=${runId} | ${JSON.stringify(summary)}`)

  return summary
}

module.exports = { generateReport }