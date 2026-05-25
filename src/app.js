require('dotenv').config()
const express   = require('express')
const connectDB = require('./config/db')
const logger    = require('./config/logger')

const app = express()


app.use(express.json())

//routes
app.use('/reconcile', require('./routes/reconcile'))


const reportRoutes = require('./routes/report')
app.use('/report', reportRoutes)

//starting server
const PORT = process.env.PORT || 3000

const start = async () => {
  await connectDB()    
  app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`)
  })
}

start()