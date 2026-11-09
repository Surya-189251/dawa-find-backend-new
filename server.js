require('dotenv').config();

const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');

const app = express();

/*
|--------------------------------------------------------------------------
| CORS
|--------------------------------------------------------------------------
|
| Allow:
| 1. Local development
| 2. Production Vercel frontend
| 3. Dawa-Find Vercel preview deployments
| 4. Any additional origins supplied through CLIENT_ORIGIN
|
*/

const configuredOrigins = (process.env.CLIENT_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  // Requests such as curl/Postman/server-to-server may not have Origin
  if (!origin) {
    return true;
  }

  // Explicit origins from Render environment variable
  if (configuredOrigins.includes(origin)) {
    return true;
  }

  // Local development
  if (
    origin === 'http://localhost:5173' ||
    origin === 'http://127.0.0.1:5173'
  ) {
    return true;
  }

  // Main production frontend
  if (origin === 'https://dawa-find-frontend.vercel.app') {
    return true;
  }

  // Vercel preview deployments for this project
  try {
    const url = new URL(origin);

    if (
      url.protocol === 'https:' &&
      (
        url.hostname === 'dawa-find-frontend.vercel.app' ||
        (
          url.hostname.startsWith('dawa-find-frontend-') &&
          url.hostname.endsWith('.vercel.app')
        )
      )
    ) {
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

const corsOptions = {
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }

    console.warn('Blocked by CORS:', origin);

    return callback(
      new Error(`CORS blocked origin: ${origin}`)
    );
  },

  credentials: true,

  methods: [
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'OPTIONS',
  ],

  allowedHeaders: [
    'Content-Type',
    'Authorization',
  ],
};

app.use(cors(corsOptions));

/*
|--------------------------------------------------------------------------
| BODY PARSER
|--------------------------------------------------------------------------
|
| Prescription scans contain base64 image data and need a larger limit.
|
*/

app.use(
  express.json({
    limit: '12mb',
  })
);

/*
|--------------------------------------------------------------------------
| HEALTH CHECK
|--------------------------------------------------------------------------
*/

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
  });
});

/*
|--------------------------------------------------------------------------
| API ROUTES
|--------------------------------------------------------------------------
*/

app.use(
  '/api/v1/auth',
  require('./routes/authRoutes')
);

app.use(
  '/api/v1/pharmacies',
  require('./routes/pharmacyRoutes')
);

app.use(
  '/api/v1/medicines',
  require('./routes/medicineRoutes')
);

app.use(
  '/api/v1/partner',
  require('./routes/partnerRoutes')
);

app.use(
  '/api/v1/admin',
  require('./routes/adminRoutes')
);

app.use(
  '/api/v1/ai',
  require('./routes/aiRoutes')
);

/*
|--------------------------------------------------------------------------
| ERROR HANDLER
|--------------------------------------------------------------------------
*/

app.use((err, _req, res, _next) => {
  // Bad input is the client's fault: answer 400/409 with a clear message
  // instead of a 500 that exposes internal errors.
  if (err.name === 'ValidationError') {
    // Build our own messages: Mongoose's defaults echo the submitted value
    // (including passwords) back to the client.
    const messages = Object.values(err.errors).map((e) => {
      if (e.kind === 'required') return `${e.path} is required`;
      if (e.kind === 'minlength') return `${e.path} must be at least ${e.properties.minlength} characters`;
      return `${e.path} is invalid`;
    });
    return res.status(400).json({ message: messages.join('. ') });
  }

  if (err.name === 'CastError') {
    return res.status(400).json({ message: `Invalid ${err.path}` });
  }

  if (err.code === 11000) {
    return res.status(409).json({ message: 'That record already exists' });
  }

  if (err.message && err.message.startsWith('CORS blocked origin')) {
    return res.status(403).json({ message: err.message });
  }

  console.error(err);

  res.status(500).json({
    message:
      process.env.NODE_ENV === 'production'
        ? 'Server error'
        : err.message || 'Server error',
  });
});

/*
|--------------------------------------------------------------------------
| START SERVER
|--------------------------------------------------------------------------
*/

const PORT =
  process.env.PORT || 5000;

connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(
        `API on http://localhost:${PORT}`
      );
    });
  })
  .catch((err) => {
    console.error(
      'DB connection failed:',
      err.message
    );

    process.exit(1);
  });