
//Single source of truth for all canonical values and aliases

const VALID_TYPES = ['BUY', 'SELL', 'TRANSFER_IN', 'TRANSFER_OUT']

const TYPE_ALIASES = {
  // BUY
  BOUGHT:     'BUY',
  PURCHASE:   'BUY',
  PURCHASING: 'BUY',
  // SELL
  SOLD:       'SELL',
  SELLING:    'SELL',
  // TRANSFER_IN
  DEPOSIT:    'TRANSFER_IN',
  DEPOSITED:  'TRANSFER_IN',
  RECEIVE:    'TRANSFER_IN',
  RECEIVED:   'TRANSFER_IN',
  IN:         'TRANSFER_IN',
  CREDIT:     'TRANSFER_IN',
  CREDITED:   'TRANSFER_IN',
  // TRANSFER_OUT
  WITHDRAWAL: 'TRANSFER_OUT',
  WITHDRAW:   'TRANSFER_OUT',
  WITHDRAWN:  'TRANSFER_OUT',
  SEND:       'TRANSFER_OUT',
  SENT:       'TRANSFER_OUT',
  OUT:        'TRANSFER_OUT',
  DEBIT:      'TRANSFER_OUT',
  DEBITED:    'TRANSFER_OUT',
}

//assets
const ASSET_ALIASES = {
  BTC:   ['bitcoin', 'btc', 'xbt', 'Bitcoin', 'BITCOIN', 'XBT'],
  ETH:   ['ethereum', 'eth', 'ether', 'Ethereum', 'ETHEREUM', 'Ether'],
  SOL:   ['solana', 'sol', 'Solana', 'SOLANA'],
  USDT:  ['tether', 'usdt', 'Tether', 'TETHER'],
  MATIC: ['polygon', 'matic', 'Polygon', 'POLYGON'],
  LINK:  ['chainlink', 'link', 'Chainlink', 'CHAINLINK'],
  USDC:  ['usd-coin', 'usdc', 'USD Coin'],
  BNB:   ['binance-coin', 'bnb', 'Binance Coin'],
}

module.exports = {
  VALID_TYPES,
  TYPE_ALIASES,
  ASSET_ALIASES,
}