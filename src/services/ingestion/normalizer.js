// src/services/ingestion/normalizer.js

// WHAT THIS FILE DOES:
// Takes one raw CSV row as input
// Converts every field to clean machine readable format
//
// NORMALIZATION IS NOT CHANGING DATA
// it is converting formats so the machine can work with them
//
// "bitcoin"  → "BTC"           same asset, canonical symbol
// "DEPOSIT"  → "TRANSFER_IN"   same type, canonical name
// "0.50"     → 0.50            same number, proper type
// "2024-.."  → ISODate(..)     same time, proper date object
//
// Returns:
//   normalized           → cleaned version of row
//   normalizationChanges → exactly what changed and why

const {
  VALID_TYPES,
  TYPE_ALIASES,
  ASSET_ALIASES,
} = require('../../config/constants')


// ── BUILD ASSET LOOKUP MAP ────────────────────────────────────
// built ONCE when file loads, reused for every row
// converts { BTC: ['bitcoin', 'btc'] }
// into     { 'bitcoin': 'BTC', 'btc': 'BTC', 'btc': 'BTC' }

const buildAssetLookup = () => {
  const lookup = {}

  for (const [canonical, aliases] of Object.entries(ASSET_ALIASES)) {
    lookup[canonical.toLowerCase()] = canonical

    for (const alias of aliases) {
      lookup[alias.toLowerCase()] = canonical
    }
  }

  return lookup
}

const ASSET_LOOKUP = buildAssetLookup()


// ── MAIN NORMALIZER FUNCTION ──────────────────────────────────

const normalizeRow = (raw) => {
  const normalized           = {}
  const normalizationChanges = {}

  // records what changed — only if value actually changed
  // so normalizationChanges only has entries where
  // something was different from raw
  const recordChange = (field, from, to, reason) => {
    if (String(from) !== String(to)) {
      normalizationChanges[field] = {
        from:   String(from),
        to:     String(to),
        reason,
      }
    }
  }


  // ── TRANSACTION ID ────────────────────────────────────────
  // just trim whitespace — no other normalization needed
  normalized.transaction_id = raw.transaction_id
    ? String(raw.transaction_id).trim()
    : null


  // ── TIMESTAMP ─────────────────────────────────────────────
  // TRUST GUARANTEE from validator at this point:
  //   - not null or empty
  //   - not partial ("2024-03-09" or "2024-03-09T")
  //   - parseable to a valid date
  //   - year is between 2009 and currentYear+1
  //
  // THREE valid cases we handle here:
  //
  //   CASE A: already a Date object
  //           store directly, nothing to change
  //
  //   CASE B: string with UTC timezone
  //           "2024-03-01T09:00:00Z"
  //           "2024-03-01T09:00:00+00:00"
  //           parse and store, record format change if any
  //
  //   CASE C: string with non-UTC offset
  //           "2024-03-01T09:00:00+05:30"
  //           JS Date auto-converts to UTC on parse
  //           record the VALUE CHANGE so audit trail is clear
  //
  //   NO TIMEZONE → stored as null
  //           we do NOT assume UTC
  //           validator should have caught this
  //           if it reaches here something went wrong upstream
  //           store null so matching engine skips this row

  const tsRaw = raw.timestamp

  if (tsRaw instanceof Date) {
    // CASE A — already a proper Date object
    // nothing to convert, store directly
    normalized.timestamp = isNaN(tsRaw.getTime()) ? null : tsRaw

  } else {
    const tsString = String(tsRaw).trim()

    // detect timezone presence in the string
    // valid timezone indicators:
    //   ends with Z                    → UTC
    //   ends with +HH:MM or -HH:MM     → offset
    //   ends with +HHMM  or -HHMM      → offset without colon
    const hasTimezone = tsString.endsWith('Z') ||
      /[+-]\d{2}:?\d{2}$/.test(tsString)

    if (!hasTimezone) {
      // NO TIMEZONE — we refuse to guess
      // store null, do not attempt to match this row
      // note: validator marks these as invalid so normalizer
      // should never receive them — but defensive null is correct
      normalized.timestamp = null

    } else {
      // has timezone — safe to parse
      const parsed = new Date(tsString)

      if (isNaN(parsed.getTime())) {
        // should never happen if validator did its job
        // but defensive null is always correct
        normalized.timestamp = null

      } else {
        normalized.timestamp = parsed

        // check which case this is
        const isUTC = tsString.endsWith('Z') ||
          tsString.endsWith('+00:00') ||
          tsString.endsWith('+0000')

        if (isUTC) {
          // CASE B — already UTC
          // only record if format actually changed
          // "2024-03-01T09:00:00Z" → no change needed
          // "2024-03-01T09:00:00+00:00" → reformatted to Z
          if (tsString !== parsed.toISOString()) {
            recordChange(
              'timestamp',
              tsString,
              parsed.toISOString(),
              'FORMAT CHANGE: Already UTC — reformatted to standard ISO 8601 with Z suffix'
            )
          }
          // if tsString already equals toISOString() → no recordChange at all

        } else {
          // CASE C — non-UTC offset
          // JS Date.parse converts to UTC automatically
          // we just record what changed and why
          recordChange(
            'timestamp',
            tsString,
            parsed.toISOString(),
            `VALUE CHANGE: Non-UTC timezone offset detected — converted to UTC. ` +
            `Original local time preserved in "from" field of this change record`
          )
        }
      }
    }
  }


  // ── TYPE ──────────────────────────────────────────────────
  // goal: convert any known type variation to one of:
  // BUY | SELL | TRANSFER_IN | TRANSFER_OUT
  //
  // validator only checked FORMAT (no bad chars)
  // normalizer resolves VALUE (what does it actually mean)
  // unknown type that passed validator → resolves to null here

  const typeRaw = raw.type
    ? String(raw.type).trim()
    : null

  if (typeRaw) {
    const upper    = typeRaw.toUpperCase().trim()
    const resolved = VALID_TYPES.includes(upper)
      ? upper
      : TYPE_ALIASES[upper] || null

    normalized.type = resolved

    if (!resolved) {
      recordChange(
        'type',
        typeRaw,
        'null',
        `"${typeRaw}" could not be resolved to a canonical type`
      )
    } else if (resolved !== typeRaw) {
      const reason = TYPE_ALIASES[upper]
        ? `Alias "${typeRaw}" resolved to canonical type "${resolved}"`
        : `Converted to uppercase`
      recordChange('type', typeRaw, resolved, reason)
    }

  } else {
    normalized.type = null
    recordChange(
    'type',
    raw.type ?? 'null',
    'null',
    'Type was null or empty — could not normalize'
  )
  }


  // ── ASSET ─────────────────────────────────────────────────
  // step 1: trim whitespace
  // step 2: lowercase for O(1) lookup
  // step 3: check ASSET_LOOKUP (built from ASSET_ALIASES)
  // step 4: unknown asset → store uppercase
  //         not an error — might be new coin not in our list yet

  const assetRaw = raw.asset
    ? String(raw.asset).trim()
    : null

  if (assetRaw) {
    const canonical = ASSET_LOOKUP[assetRaw.toLowerCase()]

    if (canonical) {
      normalized.asset = canonical

      if (canonical !== assetRaw) {
        recordChange(
          'asset',
          assetRaw,
          canonical,
          `Asset "${assetRaw}" resolved to canonical symbol "${canonical}"`
        )
      }
    } else {
      const upperAsset = assetRaw.toUpperCase()
      normalized.asset = upperAsset

      if (upperAsset !== assetRaw) {
        recordChange(
          'asset',
          assetRaw,
          upperAsset,
          'Unknown asset — converted to uppercase, could not resolve to canonical symbol'
        )
      }
    }

  } else {
    normalized.asset = null
    recordChange(
    'asset',
    raw.asset ?? 'null',
    'null',
    'Asset was null or empty — could not normalize'
  )
  }


  // ── QUANTITY ──────────────────────────────────────────────
  // string "0.50" → number 0.50
  // negative and zero stored as-is (validator flagged them)
  // matching engine skips invalid rows anyway

  const qtyRaw = raw.quantity

  if (
    qtyRaw !== null &&
    qtyRaw !== undefined &&
    String(qtyRaw).trim() !== '' &&
    !isNaN(Number(qtyRaw))
  ) {
    normalized.quantity = Number(qtyRaw)

    if (typeof qtyRaw === 'string') {
      recordChange(
        'quantity',
        qtyRaw,
        normalized.quantity,
        'String converted to Number'
      )
    }
  } else {
    normalized.quantity = null
  }


  // ── PRICE USD ─────────────────────────────────────────────
  // string → number
  // null / NaN / empty / unparseable → store as null
  // validator already flagged the problem

  const priceRaw = raw.price_usd

  if (
    priceRaw !== null &&
    priceRaw !== undefined &&
    String(priceRaw).trim() !== '' &&
    String(priceRaw).trim().toLowerCase() !== 'nan' &&
    !isNaN(Number(priceRaw))
  ) {
    normalized.price_usd = Number(priceRaw)

    if (typeof priceRaw === 'string') {
      recordChange(
        'price_usd',
        priceRaw,
        normalized.price_usd,
        'String converted to Number'
      )
    }
  } else {
    normalized.price_usd = null
  }


  // ── FEE ───────────────────────────────────────────────────
  // same pattern as price and quantity
  // null fee is acceptable — some exchanges do not report fees

  const feeRaw = raw.fee

  if (
    feeRaw !== null &&
    feeRaw !== undefined &&
    String(feeRaw).trim() !== '' &&
    !isNaN(Number(feeRaw))
  ) {
    normalized.fee = Number(feeRaw)

    if (typeof feeRaw === 'string') {
      recordChange(
        'fee',
        feeRaw,
        normalized.fee,
        'String converted to Number'
      )
    }
  } else {
    normalized.fee = null
  }


  return { normalized, normalizationChanges }
}


module.exports = { normalizeRow }