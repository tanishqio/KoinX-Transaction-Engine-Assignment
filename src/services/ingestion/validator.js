
// Overview of this file
// Takes one row as input
// Checks every field for problems
// Returns:
//  isValid- true/false
// qualityFlags- object where key=fieldname, value=problem detail
// flaggedFields- array of field names that have issue 



// bitcoin started in 2009
// any crypto transaction before that is impossible
const MIN_VALID_YEAR = 2009
const MAX_VALID_YEAR = new Date().getFullYear() + 1


const validateRow = (raw) => {
    // qualityFlags→ key value pair
    // key= field name 
    // value= problem detail 
    const qualityFlags = {}
    const flaggedFields = []
    let isValid = true

    const addFlag = (field, issue, rawValue, message) => {
        qualityFlags[field] = {
            issue,
            rawValue: String(rawValue ?? ''),
            message,
        }
        flaggedFields.push(field)
        isValid = false
    }


    // for transaction id
    //checking it exsis to not
    const txId = raw.transaction_id
        ? String(raw.transaction_id).trim()
        : null

    if (!txId || txId === '') {
        addFlag(
            'transaction_id',
            'MISSING_ID',
            raw.transaction_id,
            'Transaction ID is missing or empty'
        )
    }



    //Condtions for timestanp:
    // 1. null or empty - MISSING_TIMESTAMP
    // 2. has date but no time- PARTIAL_TIMESTAMP
    // 3. cannot be parsed at all- UNPARSEABLE_TIMESTAMP
    // 4. year is before 2009- INVALID_DATE_RANGE
    // 5. valid and complete- pass

    const tsRaw = raw.timestamp
        ? String(raw.timestamp).trim()
        : null

    if (!tsRaw || tsRaw.toLowerCase() === 'null' || tsRaw === '') {
        addFlag(
            'timestamp',
            'MISSING_TIMESTAMP',
            tsRaw,
            'Timestamp is null or empty'
        )
    } else if (tsRaw.match(/^\d{4}-\d{2}-\d{2}T?$/)) {
        // has date but no time
        // "2024-03-09" or "2024-03-09T"
        addFlag(
            'timestamp',
            'PARTIAL_TIMESTAMP',
            tsRaw,
            'Timestamp has date but no time — cannot reliably match'
        )
    } else {
        const parsed = new Date(tsRaw)

        if (isNaN(parsed.getTime())) {
            addFlag(
                'timestamp',
                'UNPARSEABLE_TIMESTAMP',
                tsRaw,
                'Timestamp could not be parsed to a valid date'
            )
        } else {
            const year = parsed.getFullYear()
            if (year < MIN_VALID_YEAR || year > MAX_VALID_YEAR) {
                addFlag(
                    'timestamp',
                    'INVALID_DATE_RANGE',
                    tsRaw,
                    `Year ${year} is outside valid crypto range (${MIN_VALID_YEAR} - ${MAX_VALID_YEAR})`
                )
            }
        }
    }


    //Condtiotins for ttype:
    // we are cheking that it is null or not
    //we are checking it is of proper format or not
    const typeRaw = raw.type
        ? String(raw.type).trim()
        : null

    if (!typeRaw || typeRaw === '') {
        addFlag(
            'type',
            'MISSING_TYPE',
            typeRaw,
            'Transaction type is missing'
        )
    } else if (/[^A-Za-z_\s]/.test(typeRaw)) {
        addFlag(
            'type',
            'INVALID_TYPE_FORMAT',
            typeRaw,
            'Type contains invalid characters — only letters and underscores allowed'
        )
    }



    // Asset conditions:
    // we are checking it exsists or not
    // it is inn correct format or not
    const assetRaw = raw.asset
        ? String(raw.asset).trim()
        : null

    if (!assetRaw || assetRaw === '') {
        addFlag(
            'asset',
            'MISSING_ASSET',
            raw.asset,
            'Asset is missing or empty'
        )
    } else if (/[^A-Za-z]/.test(assetRaw)) {
        addFlag(
            'asset',
            'INVALID_ASSET_FORMAT',
            assetRaw,
            'Asset contains invalid characters — only letters allowed'
        )
    }

    // quantity conditions:
    //check for null or empty 
    // check for invalid format
    // check for negative number
    // check for zero
    // if nothing then pass

    const qtyRaw = raw.quantity

    if (
        qtyRaw === null ||
        qtyRaw === undefined ||
        String(qtyRaw).trim() === ''
    ) {
        addFlag(
            'quantity',
            'MISSING_QUANTITY',
            qtyRaw,
            'Quantity is missing'
        )
    } else if (isNaN(Number(qtyRaw))) {
        addFlag(
            'quantity',
            'INVALID_QUANTITY',
            qtyRaw,
            'Quantity contains non-numeric characters'
        )
    } else {
        const qty = Number(qtyRaw)
        if (qty < 0) {
            addFlag(
                'quantity',
                'NEGATIVE_QUANTITY',
                qtyRaw,
                'Quantity is negative — data error, cannot be used for matching'
            )
        } else if (qty === 0) {
            addFlag(
                'quantity',
                'ZERO_QUANTITY',
                qtyRaw,
                'Quantity is zero — transaction has no value'
            )
        }
    }


    // conditions for price:
    // we are considering it can be 0
    //check for invalid format
    //check for empty
    //check for negative value
    const priceRaw = raw.price_usd

    if (
        priceRaw === null ||
        priceRaw === undefined ||
        String(priceRaw).trim() === '' ||
        String(priceRaw).trim().toLowerCase() === 'nan' ||
        isNaN(Number(priceRaw))
    ) {
        addFlag(
            'price_usd',
            'MISSING_PRICE',
            priceRaw,
            'Price is missing or invalid'
        )
    } else if (Number(priceRaw) < 0) {
        addFlag(
            'price_usd',
            'NEGATIVE_PRICE',
            priceRaw,
            'Price cannot be negative'
        )
    }
    else if (!/^\d+(\.\d+)?$/.test(String(priceRaw).trim())) {
        addFlag(
            'price_usd',
            'INVALID_PRICE_FORMAT',
            priceRaw,
            'Price contains invalid characters — must be a valid number'
        )
    }


    // Fee conditions:
    //considering null fee is acceptable
    // check for invalid format
    // check for negative

    const feeRaw = raw.fee

    if (
        feeRaw !== null &&
        feeRaw !== undefined &&
        String(feeRaw).trim() !== '' &&
        isNaN(Number(feeRaw))
    ) {
        addFlag(
            'fee',
            'INVALID_FEE',
            feeRaw,
            'Fee contains non-numeric characters'
        )
    } else if (Number(feeRaw) < 0) {
        addFlag(
            'fee',
            'NEGATIVE_FEE',
            feeRaw,
            'Fee cannot be negative'
        )
    }


    return { isValid, qualityFlags, flaggedFields }
}

module.exports = { validateRow }