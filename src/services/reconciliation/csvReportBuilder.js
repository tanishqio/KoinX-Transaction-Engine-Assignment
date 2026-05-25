
// overview of this file:
// Takes a ReportEntry document from MongoDB
// Returns a flat row object ready for CSV serialisation

const formatTimestamp = (ts) => {
  if (!ts) return ''
  return new Date(ts).toISOString()
}

const formatNumber = (n) => {
  if (n === null || n === undefined) return ''
  return n.toString()
}


const extractUserFields = (tx) => {
  if (!tx) {
    return {
      user_txId:        '',
      user_asset:       '',
      user_type:        '',
      user_quantity:    '',
      user_timestamp:   '',
      user_price_usd:   '',
      user_fee:         '',
    }
  }

  const n = tx.normalized || {}
  return {
    user_txId:        tx.raw?.transaction_id ,
    user_asset:       n.asset                 || '',
    user_type:        n.type                  || '',
    user_quantity:    formatNumber(n.quantity),
    user_timestamp:   formatTimestamp(n.timestamp),
    user_price_usd:   formatNumber(n.price_usd),
    user_fee:         formatNumber(n.fee),
  }
}

const extractExchangeFields = (tx) => {
  if (!tx) {
    return {
      exchange_txId:        '',
      exchange_asset:       '',
      exchange_type:        '',
      exchange_quantity:    '',
      exchange_timestamp:   '',
      exchange_price_usd:   '',
      exchange_fee:         '',
    }
  }

  const n = tx.normalized || {}
  return {
    exchange_txId:        tx.raw?.transaction_id ,
    exchange_asset:       n.asset                 || '',
    exchange_type:        n.type                  || '',
    exchange_quantity:    formatNumber(n.quantity),
    exchange_timestamp:   formatTimestamp(n.timestamp),
    exchange_price_usd:   formatNumber(n.price_usd),
    exchange_fee:         formatNumber(n.fee),
  }
}

const formatConflicts = (conflicts) => {
  if (!conflicts || conflicts.length === 0) return ''

  return conflicts
    .map(c => `${c.field}: user=${c.userValue} exchange=${c.exchangeValue} diff=${c.differencePercent}`)
    .join(' | ')
}


//main build

const buildReportRow = (entry) => {
  const userFields     = extractUserFields(entry.userTx)
  const exchangeFields = extractExchangeFields(entry.exchangeTx)

  return {
    category:         entry.category,
    reason:           entry.reason || '',
    ...userFields,
    ...exchangeFields,
    conflict_fields:  entry.conflicts?.map(c => c.field).join(', ') || '',
    conflict_details: formatConflicts(entry.conflicts),
  }
}

//csv column order 
const CSV_COLUMNS = [
  'category',
  'reason',
  'user_txId',
  'user_asset',
  'user_type',
  'user_quantity',
  'user_timestamp',
  'user_price_usd',
  'user_fee',
  'exchange_txId',
  'exchange_asset',
  'exchange_type',
  'exchange_quantity',
  'exchange_timestamp',
  'exchange_price_usd',
  'exchange_fee',
  'conflict_fields',
  'conflict_details',
]

module.exports = { buildReportRow, CSV_COLUMNS }