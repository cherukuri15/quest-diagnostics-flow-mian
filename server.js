// Quest x Pronix.ai — Test Results AI Agent call flows
// Serves the flow page behind one shared login and stores comments in MongoDB.

require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// ---------------------------------------------------------------- settings from .env
const env = process.env;
const missing = ['MONGODB_URI', 'SESSION_SECRET', 'APP_USERNAME'].filter(k => !env[k]);
if (!env.APP_PASSWORD_HASH && !env.APP_PASSWORD) missing.push('APP_PASSWORD_HASH (or APP_PASSWORD)');
if (missing.length) {
  console.error(`Missing settings in .env: ${missing.join(', ')}. Copy .env.example to .env and fill them in.`);
  process.exit(1);
}
if (env.SESSION_SECRET.length < 32) {
  console.error('SESSION_SECRET must be at least 32 characters. See .env.example for how to generate one.');
  process.exit(1);
}

const PORT = Number(env.PORT) || 3000;
const IS_PROD = env.NODE_ENV === 'production';
const DB_NAME = env.MONGODB_DB || 'quest_flow_review';
const SESSION_HOURS = Number(env.SESSION_HOURS) || 12;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------- helpers
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

async function passwordMatches(password) {
  if (env.APP_PASSWORD_HASH) return bcrypt.compare(String(password), env.APP_PASSWORD_HASH);
  return safeEqual(password, env.APP_PASSWORD);
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\u0000/g, '').trim().slice(0, max);
}

const ID_RE = /^c[a-z0-9]{6,32}$/;
const KEY_RE = /^[A-Za-z0-9_:.\-]{1,120}$/;
const CLIENT_RE = /^u[0-9a-z]{4,40}$/;

function clientIdOf(req) {
  const id = req.get('X-Client-Id') || '';
  return CLIENT_RE.test(id) ? id : '';
}

function toClient(doc, clientId) {
  return {
    id: doc.id,
    key: doc.key,
    flow: doc.flow,
    title: doc.title,
    name: doc.name,
    text: doc.text,
    resolved: !!doc.resolved,
    at: doc.at instanceof Date ? doc.at.toISOString() : doc.at,
    mine: !!clientId && doc.by === clientId,
  };
}

// ---------------------------------------------------------------- start-up
async function main() {
  const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await mongo.connect();
  const db = mongo.db(DB_NAME);
  const comments = db.collection('comments');
  await comments.createIndex({ id: 1 }, { unique: true });
  await comments.createIndex({ at: 1 });
  console.log(`Connected to MongoDB database "${DB_NAME}".`);

  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY === '1' || IS_PROD) app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'", "'unsafe-inline'"],
        'script-src-attr': ["'unsafe-inline'"],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
        'upgrade-insecure-requests': IS_PROD ? [] : null,
      },
    },
  }));

  app.use(session({
    name: 'qfr.sid',
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      client: mongo,
      dbName: DB_NAME,
      collectionName: 'sessions',
      ttl: SESSION_HOURS * 60 * 60,
    }),
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PROD,
      maxAge: SESSION_HOURS * 60 * 60 * 1000,
    },
  }));

  app.use(express.urlencoded({ extended: false, limit: '10kb' }));
  app.use(express.json({ limit: '20kb' }));

  // ---------------------------------------------- health check (no login needed)
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // ---------------------------------------------- login / logout
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => res.redirect('/login?error=locked'),
  });

  app.get('/login', (req, res) => {
    if (req.session.authed) return res.redirect('/');
    res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
  });

  app.post('/login', loginLimiter, async (req, res, next) => {
    try {
      const { username = '', password = '' } = req.body || {};
      const userOk = safeEqual(String(username).trim(), env.APP_USERNAME);
      const passOk = await passwordMatches(password);
      if (!userOk || !passOk) return res.redirect('/login?error=1');
      req.session.regenerate(err => {
        if (err) return next(err);
        req.session.authed = true;
        req.session.at = Date.now();
        req.session.save(e => (e ? next(e) : res.redirect('/')));
      });
    } catch (e) { next(e); }
  });

  app.get('/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('qfr.sid');
      res.redirect('/login');
    });
  });

  // ---------------------------------------------- everything below needs the login
  function requireLogin(req, res, next) {
    if (req.session && req.session.authed) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Your session ended. Sign in again.' });
    return res.redirect('/login');
  }
  app.use(requireLogin);

  app.get('/', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  // ---------------------------------------------- comments API
  app.get('/api/comments', async (req, res, next) => {
    try {
      const clientId = clientIdOf(req);
      const docs = await comments.find({}).sort({ at: 1 }).limit(5000).toArray();
      res.set('Cache-Control', 'no-store');
      res.json(docs.map(d => toClient(d, clientId)));
    } catch (e) { next(e); }
  });

  app.post('/api/comments', async (req, res, next) => {
    try {
      const b = req.body || {};
      const clientId = clientIdOf(req);
      const doc = {
        id: ID_RE.test(b.id || '') ? b.id : 'c' + crypto.randomBytes(8).toString('hex'),
        key: KEY_RE.test(b.key || '') ? b.key : '',
        flow: Number.isInteger(b.flow) && b.flow >= 0 && b.flow <= 20 ? b.flow : 0,
        title: cleanText(b.title, 200),
        name: cleanText(b.name, 80),
        text: cleanText(b.text, 4000),
        resolved: false,
        at: new Date(),
        by: clientId,
      };
      if (!doc.key) return res.status(400).json({ error: 'The comment is missing the step it belongs to.' });
      if (!doc.name) return res.status(400).json({ error: 'Add your name.' });
      if (!doc.text) return res.status(400).json({ error: 'Write a comment first.' });
      await comments.insertOne(doc);
      res.status(201).json(toClient(doc, clientId));
    } catch (e) {
      if (e && e.code === 11000) return res.status(409).json({ error: 'That comment was already saved.' });
      next(e);
    }
  });

  app.patch('/api/comments/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!ID_RE.test(id)) return res.status(400).json({ error: 'Unknown comment.' });
      if (typeof (req.body || {}).resolved !== 'boolean') return res.status(400).json({ error: 'Nothing to change.' });
      const updated = await comments.findOneAndUpdate(
        { id },
        { $set: { resolved: req.body.resolved, resolvedAt: req.body.resolved ? new Date() : null } },
        { returnDocument: 'after' },
      );
      if (!updated) return res.status(404).json({ error: 'That comment no longer exists.' });
      res.json(toClient(updated, clientIdOf(req)));
    } catch (e) { next(e); }
  });

  app.delete('/api/comments/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      const clientId = clientIdOf(req);
      if (!ID_RE.test(id)) return res.status(400).json({ error: 'Unknown comment.' });
      const doc = await comments.findOne({ id });
      if (!doc) return res.status(404).json({ error: 'That comment no longer exists.' });
      if (!clientId || doc.by !== clientId) return res.status(403).json({ error: 'Only the person who wrote a comment can delete it.' });
      await comments.deleteOne({ id });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // ---------------------------------------------- errors
  app.use((req, res) => res.status(404).send('Not found'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'The server could not save that. Try again.' });
    res.status(500).send('Something went wrong. Try again.');
  });

if (require.main === module) {
    const server = app.listen(PORT, () => {
      console.log(`Flow review running on http://localhost:${PORT}`);
    });

    const shutdown = () => {
      server.close(() => mongo.close().then(() => process.exit(0)));
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }

  return app;
}


const appPromise = main();

appPromise.catch(err => {
  console.error('Could not start:', err.message);
});

module.exports = async (req, res) => {
  try {
    const app = await appPromise;
    return app(req, res);
  } catch (err) {
    console.error('App initialization failed:', err.message);
    if (!res.headersSent) {
      return res.status(500).send('Application initialization failed.');
    }
  }
};
