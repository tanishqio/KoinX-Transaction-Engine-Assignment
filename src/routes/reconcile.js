//working:
// POST /reconcile
//   reads both CSV files from /uploads folder
//   runs ingestion pipeline on both files in parallel
//   stores all rows in MongoDB with validation + normalization
//   returns runId for fetching report later

const express = require('express')
const path = require('path')
const { v4: uuidv4 } = require('uuid')
const router = express.Router()
const { parseAndIngest } = require('../services/ingestion/csvParser')
const ReconciliationRun = require('../models/ReconciliationRun')
const tolerances = require('../config/tolerances')
const logger = require('../config/logger')
const { runMatchingEngine } = require('../services/reconciliation/matchingEngine')
const { generateReport }    = require('../services/reconciliation/reportGenerator')


const USER_FILE_PATH = path.join(__dirname, '../../uploads/user_transactions.csv')
const EXCHANGE_FILE_PATH = path.join(__dirname, '../../uploads/exchange_transactions.csv')


router.post('/', async (req, res) => {
    const runId = uuidv4()

    try {

        // request body overrides .env defaults
        const config = {
            timestampToleranceSecs:
                req.body?.timestampToleranceSecs
                    ? parseInt(req.body.timestampToleranceSecs)
                    : tolerances.TIMESTAMP_TOLERANCE_SECONDS,

            quantityTolerancePct:
                req.body?.quantityTolerancePct
                    ? parseFloat(req.body.quantityTolerancePct)
                    : tolerances.QUANTITY_TOLERANCE_PCT,
        }

        logger.info(
            `Reconciliation started | runId=${runId} | config=${JSON.stringify(config)}`
        )

        //run id creaion
        // created before ingestion starts
        // status = running so we know it is in progress
        await ReconciliationRun.create({
            runId,
            config,
            status: 'running',
        })

    
        // Promise.all runs both ingestions at the same time

        const [userStats, exchangeStats] = await Promise.all([
            parseAndIngest(USER_FILE_PATH, 'user', runId),
            parseAndIngest(EXCHANGE_FILE_PATH, 'exchange', runId),
        ])

        await ReconciliationRun.findOneAndUpdate(
            { runId },
            {
                'summary.totalUser': userStats.total,
                'summary.totalExchange': exchangeStats.total,
                'summary.invalidRows': userStats.invalid + exchangeStats.invalid,
            }
        )

        logger.info(
            `Ingestion complete | runId=${runId} | user=${userStats.total} | exchange=${exchangeStats.total}`
        )

        

        const matchingResults = await runMatchingEngine(runId, config)
const summary         = await generateReport(runId, matchingResults)

return res.status(200).json({
            success: true,
            runId,
            message: 'Reconciliation completed!',
            ingestionSummary: {
                user: {
                    total: userStats.total,
                    valid: userStats.valid,
                    invalid: userStats.invalid,
                },
                exchange: {
                    total: exchangeStats.total,
                    valid: exchangeStats.valid,
                    invalid: exchangeStats.invalid,
                },
            },
        })

    } catch (err) {
        logger.error(`Reconciliation failed | runId=${runId} | error=${err.message}`)

        await ReconciliationRun.findOneAndUpdate(
            { runId },
            { status: 'failed', errorMessage: err.message, completedAt: new Date() }
        ).catch(() => { })
        
        return res.status(500).json({
            success: false,
            message: err.message,
        })
    }

})


module.exports = router