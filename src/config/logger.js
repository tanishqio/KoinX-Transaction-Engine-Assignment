const winston = require('winston')
require('winston-daily-rotate-file')

const { combine, timestamp, printf, colorize, errors } = winston.format

//printf call the function for every log entry
const logformat = printf(({ timestamp, level, message, stack }) => {
    return `[${timestamp}] ${level.toUpperCase()}: ${stack || message}`
})

//making the format which will be printed on console
const consoleformat = combine(colorize(), timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    errors({ stack: true }),
    logformat)

const fileformat = combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    errors({ stack: true }),
    logformat)

const combinedtransport = new winston.transports.DailyRotateFile({
    filename: 'logs/combined-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',
    maxFiles: '15d',
    zippedArchive: true,
    format: fileformat,
    level: 'info'
})

const errortransport = new winston.transports.DailyRotateFile({
    filename: 'logs/error-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',
    maxFiles: '15d',
    zippedArchive: true,
    format: fileformat,
    level: 'error'
})

const logger = winston.createLogger({
    level: 'info',
    transports: [
        new winston.transports.Console({ format: consoleformat }),
        combinedtransport,
        errortransport
    ],
})

combinedtransport.on('rotate', (oldFile, newFile) => {
    logger.info(`Log rotated: ${oldFile} → ${newFile}`)
})

module.exports=logger