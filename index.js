// =============================================================================
// tracking-service — customer order-tracking microservice.
//
// PostgreSQL/Supabase-compatible ).
// The ONLY structural changes vs. the original: the database layer imports a
// drop-in mysql2-compatible adapter (./db-adapter.js) that translates queries
// to PostgreSQL instead of `mysql2/promise`
// Route logic and behaviour are otherwise unchanged.
// =============================================================================
import express from 'express'
import cors from 'cors'
import mysql from './db-adapter.js'
import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { sendEmail, brandThemeForDomain } from '../emailService.js'
import { createDomainMiddleware } from './domainMiddleware.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)


const dotenvCandidates = [
  process.env.DOTENV_PATH,
  path.resolve(__dirname, '.env'),
  path.resolve(__dirname, '..', '.env'),
  path.resolve(__dirname, '..', '..', '.env'),
  path.resolve(__dirname, '..', '..', '..', '.env'),
].filter(Boolean)

for (const p of dotenvCandidates) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p, override: true })
    break
  }
}

function env(name, fallback = '') {
  const v = process.env[name]
  if (v === undefined || v === null || String(v).trim() === '') return fallback
  return String(v)
}

function envInt(name, fallback) {
  const raw = env(name, '')
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

const PORT = envInt('TRACKING_SERVICE_PORT', envInt('PORT', 5002))

// Prefer DATABASE_URL (Supabase Postgres) when set, since the shared env's
// generic DB_HOST/PORT/USER/PASS/NAME point at the legacy MySQL RDS instance
// used by services not yet migrated to Postgres.
const DATABASE_URL = env('DATABASE_URL', '')
const DB_HOST = env('DB_HOST', 'localhost')
const DB_PORT = envInt('DB_PORT', 5432)
const DB_USER = env('DB_USER', '')
const DB_PASS = env('DB_PASS', '')
const DB_NAME = env('DB_NAME', '')

const corsOrigin = env('CORS_ORIGIN', '*')
const API_KEY = env('TRACKING_API_KEY', env('TRACKINGDETAIL_API_KEY', ''))
const JWT_SECRET = env('TRACKING_JWT_SECRET', env('TRACKINGDETAIL_JWT_SECRET', ''))
const OTP_TTL_SECONDS = Math.min(Math.max(envInt('TRACKING_OTP_TTL_SECONDS', envInt('TRACKINGDETAIL_OTP_TTL_SECONDS', 600)), 60), 1800)
const OTP_MAX_ATTEMPTS = Math.min(Math.max(envInt('TRACKING_OTP_MAX_ATTEMPTS', envInt('TRACKINGDETAIL_OTP_MAX_ATTEMPTS', 5)), 1), 20)
const ACCESS_TOKEN_TTL_SECONDS = Math.min(Math.max(envInt('TRACKING_ACCESS_TOKEN_TTL_SECONDS', envInt('TRACKINGDETAIL_ACCESS_TOKEN_TTL_SECONDS', 900)), 60), 3600)

const app = express()
app.set('trust proxy', true)
app.use(express.json({ limit: '1mb' }))

app.use(
  cors({
    origin: corsOrigin === '*' ? true : corsOrigin.split(',').map((s) => s.trim()).filter(Boolean),
    credentials: true,
  })
)

const pool = mysql.createPool(
  DATABASE_URL
    ? {
        connectionString: DATABASE_URL,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        ssl: { rejectUnauthorized: false },
      }
    : {
        host: DB_HOST,
        port: DB_PORT,
        user: DB_USER,
        password: DB_PASS,
        database: DB_NAME,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        ssl: { rejectUnauthorized: false },
      }
)

const domainMiddleware = createDomainMiddleware({
  lookupDomain: async (name) => {
    const [rows] = await pool.execute('SELECT id, status FROM domains WHERE domain_name = ?', [name])
    return rows[0] || null
  },
})
app.use(domainMiddleware)

function nowMysqlDatetime() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function addSecondsMysql(sec) {
  const d = new Date(Date.now() + sec * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

async function ensureTrackingOtpsTable() {
  try {
    await pool.execute(
      `CREATE TABLE IF NOT EXISTS tracking_otps (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(150) NOT NULL,
        otp_hash CHAR(64) NOT NULL,
        otp_salt CHAR(32) NOT NULL,
        expires_at DATETIME NOT NULL,
        used_at DATETIME NULL,
        attempts INT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL,
        INDEX idx_tracking_otps_email (email),
        INDEX idx_tracking_otps_expires_at (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    )
  } catch (e) {
    console.error('[tracking-service] ensureTrackingOtpsTable failed', e?.message || e)
  }
}

// NOTE: order_address_change_requests is shared with admin-service, which
// already creates this table (same columns) against the same Supabase DB.
// CREATE TABLE IF NOT EXISTS makes this a safe no-op when that's the case.
async function ensureOrderAddressChangeRequestsTable() {
  try {
    await pool.execute(
      `CREATE TABLE IF NOT EXISTS order_address_change_requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT NULL,
        order_number VARCHAR(60) NULL,
        customer_email VARCHAR(150) NOT NULL,
        current_shipping_json TEXT NULL,
        requested_shipping_json TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        admin_id INT NULL,
        admin_note VARCHAR(255) NULL,
        decided_at DATETIME NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        INDEX idx_oacr_status_created (status, created_at),
        INDEX idx_oacr_customer_email (customer_email),
        INDEX idx_oacr_order_id (order_id),
        INDEX idx_oacr_order_number (order_number)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    )
  } catch (e) {
    console.error('[tracking-service] ensureOrderAddressChangeRequestsTable failed', e?.message || e)
  }
}

function requireApiKey(req, res, next) {
  if (!API_KEY) return next()
  const got = String(req.headers['x-api-key'] || '').trim()
  if (!got || got !== API_KEY) return res.status(401).json({ error: 'Unauthorized' })
  return next()
}

function getBearerToken(req) {
  const raw = String(req.headers?.authorization || '')
  const m = raw.match(/^Bearer\s+(.+)$/i)
  return m ? String(m[1] || '').trim() : ''
}

function requireOtpAccess(req, res, next) {
  if (API_KEY) {
    const gotKey = String(req.headers['x-api-key'] || '').trim()
    if (gotKey && gotKey === API_KEY) return next()
  }

  const token = getBearerToken(req)
  if (!token) return res.status(401).json({ error: 'OTP verification required' })
  if (!JWT_SECRET) return res.status(500).json({ error: 'Server missing JWT secret' })

  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    const email = normalizeEmail(decoded?.email)
    if (!email) return res.status(401).json({ error: 'Invalid access token' })
    req.otpEmail = email
    return next()
  } catch {
    return res.status(401).json({ error: 'Invalid or expired access token' })
  }
}

function normalizeEmail(raw) {
  const e = String(raw || '').trim().toLowerCase()
  // Very small sanity check. DB has the source of truth.
  if (!e || !e.includes('@') || e.length > 150) return ''
  return e
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

function sha256Hex(raw) {
  return crypto.createHash('sha256').update(String(raw || ''), 'utf8').digest('hex')
}

async function fetchTrackingEventsExternal(trackingNumber) {
  const tn = String(trackingNumber || '').trim()
  if (!tn) return { ok: false, error: 'trackingNumber is required' }

  const baseUrl = String(env('TRACKING_EVENTS_API_BASE_URL', '')).trim().replace(/\/$/, '')
  if (!baseUrl) {
    return { ok: false, error: 'Tracking events API is not configured' }
  }

  const apiKey = String(env('TRACKING_EVENTS_API_KEY', '')).trim()
  const carrier = String(env('TRACKING_EVENTS_DEFAULT_CARRIER', 'royalmail')).trim()

  // Expected endpoint shape (configurable server-side):
  //   GET {baseUrl}/track?tracking={tn}&carrier={carrier}
  // Returns JSON with either { events: [...] } or { data: { events: [...] } }.
  const url = `${baseUrl}/track?tracking=${encodeURIComponent(tn)}&carrier=${encodeURIComponent(carrier)}`
  const headers = {}
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

  try {
    const res = await fetch(url, { headers })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return { ok: false, error: data?.error || `Tracking provider request failed (${res.status})` }
    }

    const eventsRaw = Array.isArray(data?.events)
      ? data.events
      : Array.isArray(data?.data?.events)
        ? data.data.events
        : []

    const events = eventsRaw
      .map((e) => {
        const status = String(e?.status || e?.message || e?.description || '').trim()
        const location = String(e?.location || e?.country || '').trim()
        const timestamp = String(e?.timestamp || e?.time || e?.datetime || e?.date || '').trim()
        return {
          status,
          location,
          timestamp,
          raw: e,
        }
      })
      .filter((e) => e.status || e.timestamp)

    return { ok: true, trackingNumber: tn, carrier, events }
  } catch (e) {
    return { ok: false, error: e?.message || 'Failed to fetch tracking events' }
  }
}

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1')
    res.json({ ok: true, service: 'tracking-service', db: 'connected' })
  } catch (e) {
    res.status(500).json({ ok: false, service: 'tracking-service', db: 'disconnected', error: e?.message || String(e) })
  }
})

app.get('/api/trackingdetail/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1')
    res.json({ ok: true, service: 'tracking-service', db: 'connected' })
  } catch (e) {
    res.status(500).json({ ok: false, service: 'tracking-service', db: 'disconnected', error: e?.message || String(e) })
  }
})

app.get('/api/trackingdetail/tracking/:trackingNumber', requireOtpAccess, async (req, res) => {
  try {
    const trackingNumber = String(req.params.trackingNumber || '').trim()
    const out = await fetchTrackingEventsExternal(trackingNumber)
    if (!out.ok) return res.status(400).json(out)
    return res.json(out)
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'Failed to fetch tracking' })
  }
})

app.post('/api/trackingdetail/request-otp', async (req, res) => {
  let connection
  try {
    const email = normalizeEmail(req.body?.email)
    if (!email) return res.status(400).json({ ok: false, error: 'Valid email is required' })

    connection = await pool.getConnection()
    const [ordersRows] = await connection.execute(
      'SELECT id FROM orders WHERE LOWER(TRIM(customer_email)) = ? LIMIT 1',
      [email]
    )

    const hasOrder = Array.isArray(ordersRows) && ordersRows.length > 0

    if (hasOrder) {
      const otp = generateOtp()
      const salt = crypto.randomBytes(16).toString('hex')
      const otpHash = sha256Hex(`${salt}:${otp}`)
      const createdAt = nowMysqlDatetime()
      const expiresAt = addSecondsMysql(OTP_TTL_SECONDS)

      await connection.execute(
        `INSERT INTO tracking_otps (email, otp_hash, otp_salt, expires_at, used_at, attempts, created_at, domain_id)
         VALUES (?, ?, ?, ?, NULL, 0, ?, ?)`,
        [email, otpHash, salt, expiresAt, createdAt, req.domainId]
      )

      try {
        await sendEmail(
          email,
          'Your Alluvi Track Order OTP',
          'tracking_otp',
          { otp, expiresMinutes: Math.ceil(OTP_TTL_SECONDS / 60), brandTheme: brandThemeForDomain(req.domain) }
        )
      } catch (e) {
        console.error('[tracking-service] OTP email send failed', e?.message || e)
      }
    }

    return res.json({ ok: true })
  } catch (e) {
    console.error('[tracking-service] request-otp failed', e)
    return res.status(500).json({ ok: false, error: 'Failed to request OTP' })
  } finally {
    if (connection) connection.release()
  }
})

app.post('/api/trackingdetail/verify-otp', async (req, res) => {
  let connection
  try {
    const email = normalizeEmail(req.body?.email)
    const otp = String(req.body?.otp || '').trim()
    if (!email) return res.status(400).json({ ok: false, error: 'Valid email is required' })
    if (!otp || !/^[0-9]{6}$/.test(otp)) return res.status(400).json({ ok: false, error: 'Valid 6-digit OTP is required' })

    if (!JWT_SECRET) return res.status(500).json({ ok: false, error: 'Server missing JWT secret' })

    connection = await pool.getConnection()
    await connection.beginTransaction()

    const [rows] = await connection.execute(
      `SELECT id, otp_hash, otp_salt, expires_at, used_at, attempts
       FROM tracking_otps
       WHERE email = ?
       ORDER BY id DESC
       LIMIT 1
       FOR UPDATE`,
      [email]
    )

    const list = Array.isArray(rows) ? rows : []
    if (!list.length) {
      await connection.rollback()
      return res.status(400).json({ ok: false, error: 'Invalid OTP' })
    }

    const rec = list[0]
    if (rec.used_at) {
      await connection.rollback()
      return res.status(400).json({ ok: false, error: 'OTP already used. Please request a new OTP.' })
    }

    const exp = new Date(rec.expires_at)
    if (Number.isNaN(exp.getTime()) || exp.getTime() < Date.now()) {
      await connection.rollback()
      return res.status(400).json({ ok: false, error: 'OTP expired. Please request a new OTP.' })
    }

    const attempts = Number(rec.attempts || 0)
    if (attempts >= OTP_MAX_ATTEMPTS) {
      await connection.rollback()
      return res.status(400).json({ ok: false, error: 'Too many attempts. Please request a new OTP.' })
    }

    const computed = sha256Hex(`${String(rec.otp_salt || '')}:${otp}`)
    const match = computed === String(rec.otp_hash || '')

    if (!match) {
      await connection.execute('UPDATE tracking_otps SET attempts = attempts + 1 WHERE id = ?', [rec.id])
      await connection.commit()
      return res.status(400).json({ ok: false, error: 'Invalid OTP' })
    }

    await connection.execute('UPDATE tracking_otps SET used_at = ? WHERE id = ?', [nowMysqlDatetime(), rec.id])
    await connection.commit()

    const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL_SECONDS })
    return res.json({ ok: true, token, expiresIn: ACCESS_TOKEN_TTL_SECONDS })
  } catch (e) {
    if (connection) {
      try {
        await connection.rollback()
      } catch {
        // ignore
      }
    }
    console.error('[tracking-service] verify-otp failed', e)
    return res.status(500).json({ ok: false, error: 'Failed to verify OTP' })
  } finally {
    if (connection) connection.release()
  }
})

async function fetchTrackingDetailsByEmail(email, limit, domainId) {
  const safeLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 50, 1), 200)
  const normalizedEmail = String(email || '').trim().toLowerCase()
  const [ordersRows] = await pool.execute(
    `SELECT *
     FROM orders
     WHERE LOWER(TRIM(customer_email)) = ? AND domain_id = ?
     ORDER BY created_at DESC
     LIMIT ${safeLimit}`,
    [normalizedEmail, domainId]
  )

  const orders = Array.isArray(ordersRows) ? ordersRows : []
  if (!orders.length) return []

  const getOrderPk = (o) => {
    if (o && o.id !== undefined && o.id !== null) return o.id
    if (o && o.order_id !== undefined && o.order_id !== null) return o.order_id
    return null
  }

  const orderIds = orders.map(getOrderPk).filter((id) => Number.isFinite(Number(id)))

  // If we can't determine any order IDs (schema mismatch / unexpected columns),
  // still return the orders instead of crashing with "IN ()" SQL.
  if (!orderIds.length) {
    return orders.map((o) => ({ order: o, items: [], payments: [] }))
  }

  const placeholders = orderIds.map(() => '?').join(',')

  const [itemsRows] = await pool.execute(
    `SELECT * FROM order_items WHERE order_id IN (${placeholders}) ORDER BY id ASC`,
    orderIds
  )

  const [paymentsRows] = await pool.execute(
    `SELECT * FROM payments WHERE order_id IN (${placeholders}) ORDER BY created_at DESC`,
    orderIds
  )

  const items = Array.isArray(itemsRows) ? itemsRows : []
  const payments = Array.isArray(paymentsRows) ? paymentsRows : []

  const itemsByOrderId = new Map()
  for (const it of items) {
    const oid = it.order_id
    const arr = itemsByOrderId.get(oid) || []
    arr.push(it)
    itemsByOrderId.set(oid, arr)
  }

  const paymentsByOrderId = new Map()
  for (const p of payments) {
    const oid = p.order_id
    const arr = paymentsByOrderId.get(oid) || []
    arr.push(p)
    paymentsByOrderId.set(oid, arr)
  }

  return orders.map((o) => {
    const oid = getOrderPk(o)
    return {
      order: o,
      items: itemsByOrderId.get(oid) || [],
      payments: paymentsByOrderId.get(oid) || [],
    }
  })
}

// GET /api/trackingdetail/orders?email=someone@example.com
app.get('/api/trackingdetail/orders', requireOtpAccess, async (req, res) => {
  try {
    const email = req.otpEmail ? String(req.otpEmail) : normalizeEmail(req.query?.email)
    if (!email) return res.status(400).json({ error: 'Valid email query param is required' })

    const limit = Math.min(Math.max(Number(req.query?.limit || 50), 1), 200)

    const orders = await fetchTrackingDetailsByEmail(email, limit, req.domainId)
    return res.json({ email, orders })
  } catch (e) {
    console.error('[tracking-service] failed to fetch orders', e)
    return res.status(500).json({ error: 'Failed to fetch tracking details', details: e?.message || String(e) })
  }
})

app.get('/api/trackingdetail/address-change-requests', requireOtpAccess, async (req, res) => {
  try {
    const email = req.otpEmail ? String(req.otpEmail) : normalizeEmail(req.query?.email)
    if (!email) return res.status(400).json({ error: 'Valid email is required' })

    const limit = Math.min(Math.max(Number(req.query?.limit || 200), 1), 500)
    const [rows] = await pool.execute(
      `SELECT *
       FROM order_address_change_requests
       WHERE LOWER(TRIM(customer_email)) = ? AND domain_id = ?
       ORDER BY created_at DESC
       LIMIT ${Number.isFinite(limit) ? Math.trunc(limit) : 200}`,
      [String(email).trim().toLowerCase(), req.domainId]
    )
    return res.json({ requests: Array.isArray(rows) ? rows : [] })
  } catch (e) {
    console.error('[tracking-service] failed to fetch address change requests', e)
    return res.status(500).json({ error: 'Failed to fetch address change requests' })
  }
})

app.post('/api/trackingdetail/order/:orderNumber/address-change-request', requireOtpAccess, async (req, res) => {
  let connection
  try {
    const email = req.otpEmail ? String(req.otpEmail) : normalizeEmail(req.body?.email)
    if (!email) return res.status(400).json({ error: 'Valid email is required' })

    const orderNumber = String(req.params.orderNumber || '').trim()
    if (!orderNumber) return res.status(400).json({ error: 'orderNumber is required' })

    const requested = {
      shipping_address: String(req.body?.shipping_address || '').trim(),
      shipping_city: String(req.body?.shipping_city || '').trim(),
      shipping_zip: String(req.body?.shipping_zip || '').trim(),
      shipping_country: String(req.body?.shipping_country || '').trim(),
    }

    if (!requested.shipping_address) {
      return res.status(400).json({ error: 'shipping_address is required' })
    }

    connection = await pool.getConnection()
    await connection.beginTransaction()

    const [orderRows] = await connection.execute(
      `SELECT * FROM orders WHERE order_number = ? AND LOWER(TRIM(customer_email)) = ? AND domain_id = ? LIMIT 1 FOR UPDATE`,
      [orderNumber, String(email).trim().toLowerCase(), req.domainId]
    )

    const orders = Array.isArray(orderRows) ? orderRows : []
    if (!orders.length) {
      await connection.rollback()
      return res.status(404).json({ error: 'Order not found' })
    }

    const order = orders[0]
    const orderId = order?.id !== undefined && order?.id !== null ? Number(order.id) : null

    const [pendingRows] = await connection.execute(
      `SELECT id FROM order_address_change_requests
       WHERE status = 'pending' AND (
         (order_id IS NOT NULL AND order_id = ?) OR (order_number IS NOT NULL AND order_number = ?)
       )
       ORDER BY id DESC
       LIMIT 1
       FOR UPDATE`,
      [orderId, orderNumber]
    )
    const pending = Array.isArray(pendingRows) ? pendingRows : []
    if (pending.length) {
      await connection.rollback()
      return res.status(409).json({ error: 'A pending address change request already exists for this order.' })
    }

    const currentShipping = {
      shipping_address: String(order?.shipping_address || '').trim(),
      shipping_city: String(order?.shipping_city || '').trim(),
      shipping_zip: String(order?.shipping_zip || '').trim(),
      shipping_country: String(order?.shipping_country || '').trim(),
    }

    const now = nowMysqlDatetime()
    const [ins] = await connection.execute(
      `INSERT INTO order_address_change_requests
        (order_id, order_number, customer_email, current_shipping_json, requested_shipping_json, status, admin_id, admin_note, decided_at, created_at, updated_at, domain_id)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?, ?)`,
      [
        Number.isFinite(orderId) ? orderId : null,
        orderNumber,
        String(email).trim().toLowerCase(),
        JSON.stringify(currentShipping),
        JSON.stringify(requested),
        now,
        now,
        req.domainId,
      ]
    )

    await connection.commit()
    return res.json({ success: true, id: ins?.insertId })
  } catch (e) {
    if (connection) {
      try {
        await connection.rollback()
      } catch {
        // ignore
      }
    }
    console.error('[tracking-service] address change request failed', e)
    return res.status(500).json({ error: 'Failed to submit address change request' })
  } finally {
    if (connection) connection.release()
  }
})

// POST /api/trackingdetail/orders { "email": "someone@example.com" }
app.post('/api/trackingdetail/orders', requireOtpAccess, async (req, res) => {
  try {
    const email = req.otpEmail ? String(req.otpEmail) : normalizeEmail(req.body?.email)
    if (!email) return res.status(400).json({ error: 'Valid email is required' })

    const limit = Math.min(Math.max(Number(req.body?.limit || 50), 1), 200)
    const orders = await fetchTrackingDetailsByEmail(email, limit, req.domainId)
    return res.json({ email, orders })
  } catch (e) {
    console.error('[tracking-service] failed to fetch orders', e)
    return res.status(500).json({ error: 'Failed to fetch tracking details', details: e?.message || String(e) })
  }
})

// New endpoint: Fetch orders by email (for authenticated users, no OTP needed)
app.post('/api/trackingdetail/orders-by-email', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email)
    if (!email) return res.status(400).json({ ok: false, error: 'Valid email is required' })

    const limit = req.body?.limit || 50
    const orders = await fetchTrackingDetailsByEmail(email, limit, req.domainId)
    return res.json({ ok: true, orders })
  } catch (e) {
    console.error('[tracking-service] orders-by-email failed', e)
    return res.status(500).json({ ok: false, error: 'Failed to fetch orders' })
  }
})

app.listen(PORT, () => {
  console.log(`✅ tracking-service running on port ${PORT}`)
})

;(async () => {
  await ensureTrackingOtpsTable()
  await ensureOrderAddressChangeRequestsTable()
})().catch(() => {})
