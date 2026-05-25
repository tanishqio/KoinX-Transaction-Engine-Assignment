const Transaction = require('../../models/Transaction')
const logger = require('../../config/logger')

const BUCKET_MINUTES = 10
const BUCKET_MS = BUCKET_MINUTES * 60 * 1000


//bukcet key making
// each transaction goes into TWO buckets — its own and the next one
// ensures transactions near 10-minute boundaries are never missed

const getBucketKeys = (timestamp, asset) => {
    const ms = timestamp.getTime()
    const bucketStart = Math.floor(ms / BUCKET_MS) * BUCKET_MS
    const bucketNext = bucketStart + BUCKET_MS

    const fmt = (t) => {
        const d = new Date(t)
        return `${asset}_${d.toISOString().slice(0, 15)}`
    }

    return [fmt(bucketStart), fmt(bucketNext)]
}


// type check conditions
// BUY-> BUY exact same label
// SELL -> SELL exact same label
// TRANSFER_OUT-> TRANSFER_IN  same event, opposite perspectives
// TRANSFER_IN-> TRANSFER_OUT same event, opposite perspectives
// anything else-> incompatible, skip immediately

const areTypesCompatible = (userType, exchangeType) => {
    if (!userType || !exchangeType) return false
    if (userType === exchangeType) return true

    const flipPairs = [
        ['TRANSFER_OUT', 'TRANSFER_IN'],
        ['TRANSFER_IN', 'TRANSFER_OUT'],
    ]

    return flipPairs.some(([u, e]) => userType === u && exchangeType === e)
}


// quantitie diff
// percentage difference between two quantities

const checkQuantity = (userQty, exchangeQty, tolerancePct) => {
    if (userQty === null || exchangeQty === null) {
        return {
            passes: false,
            difference: null,
            differencePercent: null,
            rawPercent: Infinity,
            reason: 'One or both quantities are null',
        }
    }

    const difference = Math.abs(userQty - exchangeQty)
    const base = Math.max(Math.abs(userQty), Math.abs(exchangeQty))
    const differencePercent = base > 0 ? (difference / base) * 100 : 0

    return {
        passes: differencePercent <= tolerancePct,
        difference,
        differencePercent: differencePercent.toFixed(6) + '%',
        toleranceAllowed: tolerancePct + '%',
        rawPercent: differencePercent,
    }
}


//timestamps
//difference in seconds between two timestamps
//differenceSeconds kept as a number for sorting comparisons

const checkTimestamp = (userTs, exchangeTs, toleranceSecs) => {
    if (!userTs || !exchangeTs) {
        return {
            passes: false,
            differenceSeconds: Infinity,
            reason: 'One or both timestamps are null',
        }
    }

    const differenceSeconds = Math.abs(
        userTs.getTime() - exchangeTs.getTime()
    ) / 1000

    return {
        passes: differenceSeconds <= toleranceSecs,
        differenceSeconds: Math.round(differenceSeconds),
        toleranceSeconds: toleranceSecs,
    }
}


// scoring candidate pairs
// pre-computed before sorting — called ONCE per candidate, not inside sort

const scoreCandidatePair = (userTx, exchangeTx, config) => {
    const userN = userTx.normalized
    const exchangeN = exchangeTx.normalized

    const tsCheck = checkTimestamp(userN.timestamp, exchangeN.timestamp, config.timestampToleranceSecs)
    const qtyCheck = checkQuantity(userN.quantity, exchangeN.quantity, config.quantityTolerancePct)

    return {
        timestampDiff: tsCheck.differenceSeconds,
        quantityDiff: qtyCheck.rawPercent,
    }
}


// final matching pair
// called ONLY on confirmed winner transactions that passed
// type + timestamp + quantity check
//  final category:
//   EXACT_MATCH— quantity, price, AND fee all within tolerance
//   MATCHED— quantity passes but price or fee differs


const analyseWinningPair = (userTx, exchangeTx, config) => {
    const userN = userTx.normalized
    const exchangeN = exchangeTx.normalized
    const conflicts = []

    let priceExact = true
    if (userN.price_usd !== null && exchangeN.price_usd !== null) {
        const priceCheck = checkQuantity(userN.price_usd, exchangeN.price_usd, 1.0)
        if (!priceCheck.passes) {
            priceExact = false
            conflicts.push({
                field: 'price_usd',
                userValue: userN.price_usd,
                exchangeValue: exchangeN.price_usd,
                difference: priceCheck.difference,
                differencePercent: priceCheck.differencePercent,
                toleranceAllowed: '1%',
                reason: `Price differs by ${priceCheck.differencePercent}`,
            })
        }
    }

    // fee check — informational only, 1% tolerance
    // fee calculations vary by system and tier
    let feeExact = true
    if (userN.fee !== null && exchangeN.fee !== null) {
        const feeCheck = checkQuantity(userN.fee, exchangeN.fee, 1.0)
        if (!feeCheck.passes) {
            feeExact = false
            conflicts.push({
                field: 'fee',
                userValue: userN.fee,
                exchangeValue: exchangeN.fee,
                difference: feeCheck.difference,
                differencePercent: feeCheck.differencePercent,
                toleranceAllowed: '1%',
                reason: `Fee differs by ${feeCheck.differencePercent}`,
            })
        }
    }

    const isExact = priceExact && feeExact

    return {
        category: isExact ? 'EXACT_MATCH' : 'MATCHED',
        conflicts,
        reason: isExact
            ? 'All fields matched within tolerance including price and fee'
            : 'Quantity and timestamp matched. Minor price/fee differences noted.',
    }
}



const buildConflictEntry = (userTx, conflictCandidate, config) => {
    const userN = userTx.normalized
    const candN = conflictCandidate.normalized

    const qtyCheck = checkQuantity(
        userN.quantity,
        candN.quantity,
        config.quantityTolerancePct
    )

    return {
        userTx,
        exchangeTx: conflictCandidate,
        category: 'CONFLICTING',
        conflicts: [{
            field: 'quantity',
            userValue: userN.quantity,
            exchangeValue: candN.quantity,
            difference: qtyCheck.difference,
            differencePercent: qtyCheck.differencePercent,
            toleranceAllowed: qtyCheck.toleranceAllowed,
            reason: `Quantity delta ${qtyCheck.differencePercent} exceeds tolerance ${qtyCheck.toleranceAllowed}`,
        }],
        reason: `Probable match: type and timestamp align but quantity exceeds tolerance`,
    }
}


// finding the best candidate
// given one user transaction and all exchange candidates in the bucket
// returns the single best match or the best conflict candidate

const findBestCandidate = (userTx, exchangeSide, matchedExchangeIds, conflictingExchangeIds, config) => {
    const userN = userTx.normalized

    // step 1 — type filter

    const typeCompatible = exchangeSide.filter(exTx => {
        const id = exTx._id.toString()
        if (matchedExchangeIds.has(id)) return false
        if (conflictingExchangeIds.has(id)) return false
        return areTypesCompatible(userN.type, exTx.normalized.type)
    })

    if (typeCompatible.length === 0) {
        return { winner: null, conflictCandidate: null }
    }

    // step 2 — timestamp filter
    const timestampCompatible = typeCompatible.filter(exTx => {
        const tsCheck = checkTimestamp(
            userN.timestamp,
            exTx.normalized.timestamp,
            config.timestampToleranceSecs
        )
        return tsCheck.passes
    })

    if (timestampCompatible.length === 0) {
        return { winner: null, conflictCandidate: null }
    }

    // step 3 — quantity filter
    const fullyCompatible = timestampCompatible.filter(exTx => {
        const qtyCheck = checkQuantity(
            userN.quantity,
            exTx.normalized.quantity,
            config.quantityTolerancePct
        )
        return qtyCheck.passes
    })


    if (fullyCompatible.length === 0) {
        const conflictCandidate = [...timestampCompatible].sort((a, b) => {
            const aDiff = Math.abs(userN.timestamp.getTime() - a.normalized.timestamp.getTime())
            const bDiff = Math.abs(userN.timestamp.getTime() - b.normalized.timestamp.getTime())
            return aDiff - bDiff
        })[0]

        return { winner: null, conflictCandidate }
    }

    if (fullyCompatible.length === 1) {
        return { winner: fullyCompatible[0], conflictCandidate: null }
    }

    const scored = fullyCompatible.map(exTx => ({
        exTx,
        score: scoreCandidatePair(userTx, exTx, config),
    }))

    const winner = [...scored].sort((a, b) => {
        if (a.score.timestampDiff !== b.score.timestampDiff) {
            return a.score.timestampDiff - b.score.timestampDiff
        }
        return a.score.quantityDiff - b.score.quantityDiff
    })[0].exTx

    return { winner, conflictCandidate: null }
}


// Building bukcetes
// groups all transactions into time buckets
// each transaction appears in 2 buckets adjacent window check


const buildBucketMap = (transactions) => {
    const buckets = new Map()

    const getOrCreate = (key) => {
        if (!buckets.has(key)) {
            buckets.set(key, { user: [], exchange: [] })
        }
        return buckets.get(key)
    }

    for (const tx of transactions) {
        const n = tx.normalized
        if (!n || !n.timestamp || !n.asset) continue

        const keys = getBucketKeys(n.timestamp, n.asset)

        for (const key of keys) {
            const bucket = getOrCreate(key)
            if (tx.source === 'user') {
                bucket.user.push(tx)
            } else {
                bucket.exchange.push(tx)
            }
        }
    }

    return buckets
}


// Core matching engine code

const runMatchingEngine = async (runId, config) => {
    logger.info(`Matching engine started | runId=${runId}`)

    const transactions = await Transaction.find({
        runId,
        isValid: true,
    }).lean()

    logger.info(`Loaded ${transactions.length} valid transactions | runId=${runId}`)

    const buckets = buildBucketMap(transactions)

    logger.info(`Built ${buckets.size} buckets | runId=${runId}`)


    const matchedUserIds = new Set()
    const matchedExchangeIds = new Set()
    const conflictingExchangeIds = new Set()
    const conflictingUserIds = new Set()

    const matched = []
    const conflicting = []

    // loop for buckets
    for (const [, bucket] of buckets) {
        const { user: userSide, exchange: exchangeSide } = bucket

        if (userSide.length === 0 || exchangeSide.length === 0) continue

        for (const userTx of userSide) {
            if (matchedUserIds.has(userTx._id.toString())) continue

            const { winner, conflictCandidate } = findBestCandidate(
                userTx,
                exchangeSide,
                matchedExchangeIds,
                conflictingExchangeIds,
                config
            )

            if (winner) {
                const analysis = analyseWinningPair(userTx, winner, config)

                matched.push({
                    userTx,
                    exchangeTx: winner,
                    category: analysis.category,
                    conflicts: analysis.conflicts,
                    reason: analysis.reason,
                })

                matchedUserIds.add(userTx._id.toString())
                matchedExchangeIds.add(winner._id.toString())

            } else if (conflictCandidate) {
                const candId = conflictCandidate._id.toString()

                if (!conflictingExchangeIds.has(candId)) {
                    conflicting.push(buildConflictEntry(userTx, conflictCandidate, config))
                    conflictingExchangeIds.add(candId)
                    conflictingUserIds.add(userTx._id.toString())
                }
            }
        }
    }

    // condition for conflicts two bucket A and B if they get exactly matched afterwards
    // a tx might have been pushed to conflicting in bucket A
    // then matched cleanly in bucket B
    // remove any conflicting entry where EITHER side was ultimately matched

    const cleanConflicting = conflicting.filter(c =>
        !matchedUserIds.has(c.userTx._id.toString()) &&
        !matchedExchangeIds.has(c.exchangeTx._id.toString())
    )

    // conition for unmathced
    // calculated in last after all buckets processed
    // a tx might find a match in a later bucket
    // never classify unmatched mid-process

    const allUserTxs = transactions.filter(t => t.source === 'user')
    const allExchangeTxs = transactions.filter(t => t.source === 'exchange')

    const unmatchedUser = allUserTxs.filter(
        t => !matchedUserIds.has(t._id.toString()) &&
            !conflictingUserIds.has(t._id.toString())
    )
    const unmatchedExchange = allExchangeTxs.filter(
        t => !matchedExchangeIds.has(t._id.toString()) &&
            !conflictingExchangeIds.has(t._id.toString())
    )

    const exactMatchCount = matched.filter(m => m.category === 'EXACT_MATCH').length
    const matchedCount = matched.filter(m => m.category === 'MATCHED').length

    logger.info(
        `Matching complete | runId=${runId} | exactMatch=${exactMatchCount} | matched=${matchedCount} | conflicting=${cleanConflicting.length} | unmatchedUser=${unmatchedUser.length} | unmatchedExchange=${unmatchedExchange.length}`
    )

    return {
        matched,
        conflicting: cleanConflicting,
        unmatchedUser,
        unmatchedExchange,
    }
}


module.exports = { runMatchingEngine }