// =============================================================================
// ZAIRE SKETCH MIND — BACKEND SERVER
// =============================================================================
// Version: 1.0.0
// Stack: Express + PostgreSQL + Redis + Socket.IO + BullMQ
// Run: npm install && npm run dev
// =============================================================================

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const http = require('http');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const slowDown = require('express-slow-down');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const GitHubStrategy = require('passport-github2').Strategy;
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy');
const { Server } = require('socket.io');
const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
const { Sequelize, DataTypes } = require('sequelize');
const { z } = require('zod');
const winston = require('winston');

// =============================================================================
// LOGGER
// =============================================================================

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp }) => {
      return `${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()],
});

// =============================================================================
// DATABASE (PostgreSQL + Sequelize)
// =============================================================================

const sequelize = new Sequelize(
  process.env.DB_NAME || 'zaire_sketch_mind',
  process.env.DB_USER || 'postgres',
  process.env.DB_PASSWORD || 'password',
  {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    dialect: 'postgres',
    logging: false,
    pool: { max: 10, min: 2, acquire: 30000, idle: 10000 },
    retry: { max: 3 },
    dialectOptions: process.env.NODE_ENV === 'production' ? {
      ssl: { require: true, rejectUnauthorized: false }
    } : {},
  }
);

// Models
const User = sequelize.define('User', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  email: { type: DataTypes.STRING(255), allowNull: false, unique: true },
  name: { type: DataTypes.STRING(100), allowNull: true },
  avatar: { type: DataTypes.STRING(500), allowNull: true },
  googleId: { type: DataTypes.STRING(50), allowNull: true, unique: true },
  githubId: { type: DataTypes.STRING(50), allowNull: true, unique: true },
  provider: { type: DataTypes.ENUM('google', 'github'), defaultValue: 'google' },
  subscription: { type: DataTypes.ENUM('free', 'pro', 'enterprise'), defaultValue: 'free' },
  role: { type: DataTypes.ENUM('user', 'admin'), defaultValue: 'user' },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  lastLoginAt: { type: DataTypes.DATE, allowNull: true },
}, { tableName: 'users', timestamps: true });

const Generation = sequelize.define('Generation', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  userId: { type: DataTypes.UUID, allowNull: false },
  prompt: { type: DataTypes.TEXT, allowNull: false },
  negativePrompt: { type: DataTypes.TEXT, allowNull: true },
  model: { type: DataTypes.STRING(50), defaultValue: 'flux' },
  width: { type: DataTypes.INTEGER, defaultValue: 1024 },
  height: { type: DataTypes.INTEGER, defaultValue: 1024 },
  steps: { type: DataTypes.INTEGER, defaultValue: 30 },
  cfgScale: { type: DataTypes.FLOAT, defaultValue: 7.5 },
  status: { type: DataTypes.ENUM('pending', 'processing', 'completed', 'failed', 'cancelled'), defaultValue: 'pending' },
  progress: { type: DataTypes.INTEGER, defaultValue: 0 },
  imageUrl: { type: DataTypes.STRING(500), allowNull: true },
  errorMessage: { type: DataTypes.TEXT, allowNull: true },
  processingTime: { type: DataTypes.INTEGER, allowNull: true },
}, { tableName: 'generations', timestamps: true });

const GalleryItem = sequelize.define('GalleryItem', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  userId: { type: DataTypes.UUID, allowNull: false },
  generationId: { type: DataTypes.UUID, allowNull: false, unique: true },
  title: { type: DataTypes.STRING(200), allowNull: true },
  description: { type: DataTypes.TEXT, allowNull: true },
  imageUrl: { type: DataTypes.STRING(500), allowNull: false },
  isPublic: { type: DataTypes.BOOLEAN, defaultValue: false },
  likes: { type: DataTypes.INTEGER, defaultValue: 0 },
  tags: { type: DataTypes.ARRAY(DataTypes.STRING), defaultValue: [] },
}, { tableName: 'gallery_items', timestamps: true });

// Associations
User.hasMany(Generation, { foreignKey: 'userId' });
User.hasMany(GalleryItem, { foreignKey: 'userId' });
Generation.hasOne(GalleryItem, { foreignKey: 'generationId' });

// =============================================================================
// REDIS
// =============================================================================

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  enableOfflineQueue: false,
  lazyConnect: true,
  retryStrategy: (times) => Math.min(times * 50, 2000),
});

redis.on('error', (err) => logger.error('Redis error:', err.message));

// =============================================================================
// BULLMQ QUEUES
// =============================================================================

const imageGenerationQueue = new Queue('image-generation', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 86400, count: 1000 },
    removeOnFail: { age: 604800 },
  },
});

// =============================================================================
// JWT HELPERS
// =============================================================================

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_EXPIRES_IN = '7d';

function generateAccessToken(user) {
  return jwt.sign(
    { userId: user.id, email: user.email, subscription: user.subscription, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function generateRefreshToken(user) {
  return jwt.sign({ userId: user.id, type: 'refresh' }, JWT_SECRET, { expiresIn: '30d' });
}

// =============================================================================
// MIDDLEWARE
// =============================================================================

async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Access token required' });
    }
    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findByPk(decoded.userId, {
      attributes: ['id', 'email', 'name', 'avatar', 'subscription', 'role', 'isActive']
    });
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (!user.isActive) return res.status(403).json({ error: 'Account deactivated' });
    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    if (error.name === 'JsonWebTokenError') return res.status(401).json({ error: 'Invalid token' });
    res.status(500).json({ error: 'Authentication failed' });
  }
}

function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Not Found', message: `Route ${req.method} ${req.path} not found` });
}

function errorHandler(err, req, res, next) {
  logger.error(`Error: ${err.message}`);
  const statusCode = err.statusCode || err.status || 500;
  const message = process.env.NODE_ENV === 'production' ? 'Internal Server Error' : err.message;
  res.status(statusCode).json({ error: 'Internal Server Error', message });
}

// =============================================================================
// EXPRESS APP
// =============================================================================

const app = express();
const server = http.createServer(app);

if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
  origin: (origin, callback) => {
    const allowed = [process.env.FRONTEND_URL, process.env.FRONTEND_URL?.replace('https://', 'http://')].filter(Boolean);
    if (!origin || allowed.includes(origin) || process.env.NODE_ENV === 'development') callback(null, true);
    else { logger.warn(`CORS blocked: ${origin}`); callback(new Error('Not allowed by CORS')); }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
}));

app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(passport.initialize());

// Request tracing
app.use((req, res, next) => {
  req.id = req.get('X-Request-ID') || uuidv4();
  res.set('X-Request-ID', req.id);
  logger.info(`[${req.id}] → ${req.method} ${req.path}`);
  next();
});

// =============================================================================
// SOCKET.IO
// =============================================================================

const io = new Server(server, {
  cors: { origin: process.env.FRONTEND_URL || '*', credentials: true },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
});

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token || socket.handshake.query.token;
    if (!token) { socket.userId = null; socket.isAuthenticated = false; return next(); }
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.userId;
    socket.user = decoded;
    socket.isAuthenticated = true;
    next();
  } catch (error) {
    next(new Error('Authentication failed'));
  }
});

io.on('connection', (socket) => {
  logger.info(`🔌 Socket: ${socket.id}`);
  if (socket.isAuthenticated) socket.join(`user:${socket.userId}`);
  socket.on('subscribe:generation', (id) => { if (socket.isAuthenticated) socket.join(`generation:${id}`); });
  socket.on('ping', () => socket.emit('pong', { timestamp: Date.now() }));
  socket.on('disconnect', () => logger.info(`🔌 Socket ${socket.id} disconnected`));
});

function emitToUser(userId, event, data) {
  io.to(`user:${userId}`).emit(event, data);
}

// =============================================================================
// ROUTES: HEALTH
// =============================================================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'alive', timestamp: new Date().toISOString(), uptime: process.uptime() });
});

app.get('/api/health/ready', async (req, res) => {
  const checks = { database: false, redis: false };
  try { await sequelize.authenticate(); checks.database = true; } catch (e) {}
  try { await redis.ping(); checks.redis = true; } catch (e) {}
  const healthy = checks.database && checks.redis;
  res.status(healthy ? 200 : 503).json({ status: healthy ? 'ready' : 'not ready', checks });
});

// =============================================================================
// ROUTES: AUTH
// =============================================================================

app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(401).json({ error: 'Refresh token required' });
    const decoded = jwt.verify(refreshToken, JWT_SECRET);
    const user = await User.findByPk(decoded.userId);
    if (!user) return res.status(401).json({ error: 'Invalid refresh token' });
    const newAccess = generateAccessToken(user);
    const newRefresh = generateRefreshToken(user);
    res.json({ accessToken: newAccess, refreshToken: newRefresh });
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.json({ message: 'Logged out' });
});

// =============================================================================
// ROUTES: GENERATE
// =============================================================================

const generateSchema = z.object({
  prompt: z.string().min(1).max(2000),
  negativePrompt: z.string().max(1000).optional(),
  width: z.number().int().min(256).max(2048).optional().default(1024),
  height: z.number().int().min(256).max(2048).optional().default(1024),
  steps: z.number().int().min(10).max(50).optional().default(30),
  cfgScale: z.number().min(1).max(20).optional().default(7.5),
  model: z.enum(['flux', 'stable-diffusion-xl', 'dall-e-3']).optional().default('flux'),
});

app.post('/api/generate', authenticate, async (req, res) => {
  try {
    const v = generateSchema.parse(req.body);
    const user = req.user;

    const gen = await Generation.create({
      userId: user.id,
      prompt: v.prompt,
      negativePrompt: v.negativePrompt,
      width: v.width,
      height: v.height,
      steps: v.steps,
      cfgScale: v.cfgScale,
      model: v.model,
      status: 'pending',
    });

    const job = await imageGenerationQueue.add('generate', {
      generationId: gen.id,
      userId: user.id,
      ...v,
    }, { jobId: gen.id });

    res.status(202).json({ success: true, generationId: gen.id, jobId: job.id, status: 'pending' });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation Error', details: error.errors });
    logger.error('Gen error:', error);
    res.status(500).json({ error: 'Failed to create generation' });
  }
});

app.get('/api/generate/:id', authenticate, async (req, res) => {
  try {
    const gen = await Generation.findOne({ where: { id: req.params.id, userId: req.user.id } });
    if (!gen) return res.status(404).json({ error: 'Not found' });
    res.json({ id: gen.id, prompt: gen.prompt, status: gen.status, progress: gen.progress, imageUrl: gen.imageUrl, errorMessage: gen.errorMessage });
  } catch (error) {
    res.status(500).json({ error: 'Failed' });
  }
});

app.get('/api/generate', authenticate, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const { count, rows } = await Generation.findAndCountAll({
      where: { userId: req.user.id },
      order: [['createdAt', 'DESC']],
      limit,
      offset: (page - 1) * limit,
    });
    res.json({ generations: rows, pagination: { page, limit, total: count } });
  } catch (error) {
    res.status(500).json({ error: 'Failed' });
  }
});

app.delete('/api/generate/:id', authenticate, async (req, res) => {
  try {
    const gen = await Generation.findOne({
      where: { id: req.params.id, userId: req.user.id, status: ['pending', 'processing'] }
    });
    if (!gen) return res.status(404).json({ error: 'Not found or completed' });
    const job = await imageGenerationQueue.getJob(gen.id);
    if (job) await job.remove();
    await gen.update({ status: 'cancelled' });
    res.json({ message: 'Cancelled', generationId: gen.id });
  } catch (error) {
    res.status(500).json({ error: 'Failed' });
  }
});

// =============================================================================
// ROUTES: GALLERY
// =============================================================================

app.get('/api/gallery/public', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 24, 100);
    const { count, rows } = await GalleryItem.findAndCountAll({
      where: { isPublic: true },
      order: [['createdAt', 'DESC']],
      limit,
      offset: (page - 1) * limit,
      include: [{ model: User, attributes: ['id', 'name', 'avatar'] }]
    });
    res.json({ items: rows, pagination: { page, limit, total: count } });
  } catch (error) {
    res.status(500).json({ error: 'Failed' });
  }
});

app.get('/api/gallery/my/items', authenticate, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const { count, rows } = await GalleryItem.findAndCountAll({
      where: { userId: req.user.id },
      order: [['createdAt', 'DESC']],
      limit,
      offset: (page - 1) * limit,
    });
    res.json({ items: rows, pagination: { page, limit, total: count } });
  } catch (error) {
    res.status(500).json({ error: 'Failed' });
  }
});

app.post('/api/gallery/publish', authenticate, async (req, res) => {
  try {
    const { generationId, title, description, tags, isPublic = true } = req.body;
    const gen = await Generation.findOne({ where: { id: generationId, userId: req.user.id, status: 'completed' } });
    if (!gen) return res.status(404).json({ error: 'Not found or not completed' });
    const existing = await GalleryItem.findOne({ where: { generationId } });
    if (existing) return res.status(409).json({ error: 'Already published' });
    const item = await GalleryItem.create({
      userId: req.user.id,
      generationId,
      title: title || gen.prompt.substring(0, 200),
      description,
      imageUrl: gen.imageUrl,
      isPublic,
      tags: tags || []
    });
    res.status(201).json({ success: true, galleryItemId: item.id });
  } catch (error) {
    res.status(500).json({ error: 'Failed' });
  }
});

// =============================================================================
// ERROR HANDLING
// =============================================================================

app.use(notFoundHandler);
app.use(errorHandler);

// =============================================================================
// GRACEFUL SHUTDOWN
// =============================================================================

async function gracefulShutdown(signal) {
  logger.info(`🛑 ${signal} received. Shutting down...`);
  server.close(async () => {
    try {
      await imageGenerationQueue.close();
      await redis.quit();
      await sequelize.close();
      logger.info('All connections closed');
    } catch (err) {
      logger.error('Shutdown error:', err);
    }
    process.exit(0);
  });
  setTimeout(() => { logger.error('Forced shutdown'); process.exit(1); }, 30000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// =============================================================================
// STARTUP
// =============================================================================

async function startServer() {
  try {
    await sequelize.authenticate();
    logger.info('✅ Database connected');
    await redis.ping();
    logger.info('✅ Redis connected');
    await sequelize.sync({ alter: process.env.NODE_ENV !== 'production' });
    logger.info('✅ Models synced');

    // Setup queue listeners
    imageGenerationQueue.on('completed', (job, result) => {
      logger.info(`✅ Job ${job.id} completed`);
      if (job.data?.userId) emitToUser(job.data.userId, 'job:completed', { jobId: job.id, result });
    });

    imageGenerationQueue.on('failed', (job, err) => {
      logger.error(`❌ Job ${job.id} failed: ${err.message}`);
      if (job.data?.userId) emitToUser(job.data.userId, 'job:failed', { jobId: job.id, error: err.message });
    });

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      logger.info(`🚀 Zaire Sketch Mind API listening on port ${PORT}`);
      logger.info(`📡 Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    logger.error('Failed to start:', error);
    process.exit(1);
  }
}

startServer();

module.exports = { app, server, sequelize, redis, imageGenerationQueue };
