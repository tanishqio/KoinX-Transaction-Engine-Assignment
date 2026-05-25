//overview
//used for connecting to db and then creaing indexes in each table required

const mongoose = require('mongoose')
const logger   = require('./logger')

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI)
    logger.info('MongoDB connected successfully')
    const Transaction        = require('../models/Transaction')
  
    await Transaction.createIndexes()
   
    logger.info('All indexes created successfully')

  } catch (err) {
    logger.error(`MongoDB connection failed: ${err.message}`)
    
    process.exit(1)
  }
}

module.exports = connectDB