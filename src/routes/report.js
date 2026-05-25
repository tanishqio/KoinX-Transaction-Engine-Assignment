const express           = require('express')
const router            = express.Router()
const ReportEntry       = require('../models/ReportEntry')
const ReconciliationRun = require('../models/ReconciliationRun')
const { buildReportRow, CSV_COLUMNS } = require('../services/reconciliation/csvReportBuilder')
const logger            = require('../config/logger')


// HELPER used for validate run exists and is complete 
// used by all three routes below
// returns the run document if valid


const validateRun = async (runId, res) => {
  const run = await ReconciliationRun.findOne({ runId }).lean()

  if (!run) {
    res.status(404).json({
      success: false,
      message: `No reconciliation run found for runId: ${runId}`,
    })
    return null
  }

  if (run.status !== 'complete') {
    res.status(400).json({
      success: false,
      message: `Run ${runId} is not yet complete. Current status: ${run.status}`,
    })
    return null
  }

  return run
}


//GET /report/:runId/summary 
//reads counts directly from ReconciliationRun — one document lookup

router.get('/:runId/summary', async (req, res) => {
  const { runId } = req.params

  try {
    const run = await validateRun(runId, res)
    if (!run) return

    return res.status(200).json({
      success: true,
      runId,
      status:      run.status,
      createdAt:   run.createdAt,
      completedAt: run.completedAt,
      summary: {
        exactMatch:        run.summary?.exactMatch        || 0,
        matched:           run.summary?.matched           || 0,
        conflicting:       run.summary?.conflicting       || 0,
        unmatchedUser:     run.summary?.unmatchedUser     || 0,
        unmatchedExchange: run.summary?.unmatchedExchange || 0,
        total:
          (run.summary?.exactMatch        || 0) +
          (run.summary?.matched           || 0) +
          (run.summary?.conflicting       || 0) +
          (run.summary?.unmatchedUser     || 0) +
          (run.summary?.unmatchedExchange || 0),
      },
    })

  } catch (err) {
    logger.error(`GET summary failed | runId=${runId} | ${err.message}`)
    return res.status(500).json({ success: false, message: err.message })
  }
})


//GET /report/:runId/unmatched 
//returns only unmatched entries, paginated


router.get('/:runId/unmatched', async (req, res) => {
  const { runId } = req.params

  try {
    const run = await validateRun(runId, res)
    if (!run) return

    const page  = Math.max(1, parseInt(req.query.page)  || 1)
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50))
    const skip  = (page - 1) * limit

    let categories = ['UNMATCHED_USER', 'UNMATCHED_EXCHANGE']
    if (req.query.source === 'user')     categories = ['UNMATCHED_USER']
    if (req.query.source === 'exchange') categories = ['UNMATCHED_EXCHANGE']

    const [totalCount, entries] = await Promise.all([
      ReportEntry.countDocuments({ runId, category: { $in: categories } }),
      ReportEntry.find({ runId, category: { $in: categories } })
        .lean()
        .skip(skip)
        .limit(limit)
        .sort({ category: 1 }),
    ])

    const rows = entries.map(entry => {
      const tx = entry.userTx || entry.exchangeTx
      const n  = tx?.normalized || {}

      return {
        category:  entry.category,
        reason:    entry.reason,
        source:    entry.category === 'UNMATCHED_USER' ? 'user' : 'exchange',
        txId:      tx?.rawData?.txid || tx?.rawData?.transaction_id || null,
        asset:     n.asset     || null,
        type:      n.type      || null,
        quantity:  n.quantity  || null,
        timestamp: n.timestamp || null,
        price_usd: n.price_usd || null,
        fee:       n.fee       || null,
      }
    })

    return res.status(200).json({
      success: true,
      runId,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages:  Math.ceil(totalCount / limit),
        hasNextPage: page < Math.ceil(totalCount / limit),
      },
      unmatched: rows,
    })

  } catch (err) {
    logger.error(`GET unmatched failed | runId=${runId} | ${err.message}`)
    return res.status(500).json({ success: false, message: err.message })
  }
})


//GET /report/:runId 
//streams full report as CSV download

const rowToCsvLine = (row) => {
  return CSV_COLUMNS
    .map(col => {
      const val     = row[col] !== undefined ? String(row[col]) : ''
      const escaped = val.replace(/"/g, '""')
      return `"${escaped}"`
    })
    .join(',')
}

router.get('/:runId', async (req, res) => {
  const { runId } = req.params

  try {
    const run = await validateRun(runId, res)
    if (!run) return

    const filename = `reconciliation_report_${runId}.csv`
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)

    // write header row
    res.write(CSV_COLUMNS.join(',') + '\n')

    const CATEGORY_ORDER = [
      'EXACT_MATCH',
      'MATCHED',
      'CONFLICTING',
      'UNMATCHED_USER',
      'UNMATCHED_EXCHANGE',
    ]

    for (const category of CATEGORY_ORDER) {
      const BATCH_SIZE = 500
      let skip = 0

      while (true) {
        const entries = await ReportEntry.find({ runId, category })
          .lean()
          .skip(skip)
          .limit(BATCH_SIZE)

        if (entries.length === 0) break

        for (const entry of entries) {
          const row  = buildReportRow(entry)
          const line = rowToCsvLine(row)
          res.write(line + '\n')
        }

        if (entries.length < BATCH_SIZE) break
        skip += BATCH_SIZE
      }
    }

    res.end()
    logger.info(`Report download complete | runId=${runId}`)

  } catch (err) {
    logger.error(`Report download failed | runId=${runId} | ${err.message}`)
    if (res.headersSent) {
      res.end()
    } else {
      res.status(500).json({ success: false, message: err.message })
    }
  }
})


module.exports = router