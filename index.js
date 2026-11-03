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
import jwt from 'jsonwebtoken'
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

// Extra allowed hosts, comma separated (optional). Active storefront domains from
// the `domains` table are always allowed - same rule as user-order-service.
const corsExtraHosts = env('CORS_ORIGIN', '')
  .split(',')
  .map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''))
  .filter((h) => h && h !== '*')
const API_KEY = env('TRACKING_API_KEY', env('TRACKINGDETAIL_API_KEY', ''))
// Must match JWT_SECRET in user-order-service so its login tokens verify here.
const JWT_SECRET = env('JWT_SECRET', '')

const app = express()
app.set('trust proxy', true)
app.use(express.json({ limit: '1mb' }))

const corsAllowCache = new Map() // host -> { ok, at }
async function corsOriginCheck(origin, cb) {
  try {
    if (!origin) return cb(null, true) // server-to-server / curl: no browser Origin
    let host = ''
    try {
      host = new URL(origin).hostname.toLowerCase().replace(/^www\./, '')
    } catch {
      return cb(null, false)
    }
    if (corsExtraHosts.includes(host)) return cb(null, true)
    if (process.env.NODE_ENV !== 'production' && (host === 'localhost' || host === '127.0.0.1')) return cb(null, true)
    const hit = corsAllowCache.get(host)
    if (hit && Date.now() - hit.at < 60000) return cb(null, hit.ok)
    const [rows] = await pool.execute("SELECT 1 FROM domains WHERE domain_name = ? AND status = 'active' LIMIT 1", [host])
    const ok = Array.isArray(rows) && rows.length > 0
    corsAllowCache.set(host, { ok, at: Date.now() })
    return cb(null, ok)
  } catch (e) {
    console.error('[cors] origin check failed:', e?.message || e)
    return cb(null, false)
  }
}
app.use(cors({ origin: corsOriginCheck, credentials: true }))
app.options('*', cors({ origin: corsOriginCheck, credentials: true }))

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

// Fixed-window in-memory limiter. One process (pm2 fork), so no shared store needed.
function rateLimit({ windowMs, max, key }) {
  const hits = new Map() // key -> { count, resetAt }
  setInterval(() => {
    const now = Date.now()
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k)
  }, windowMs).unref()
  return (req, res, next) => {
    const k = key(req)
    const now = Date.now()
    let rec = hits.get(k)
    if (!rec || rec.resetAt <= now) {
      rec = { count: 0, resetAt: now + windowMs }
      hits.set(k, rec)
    }
    rec.count += 1
    if (rec.count > max) {
      res.set('Retry-After', String(Math.ceil((rec.resetAt - now) / 1000)))
      return res.status(429).json({ error: 'Too many requests. Please try again later.' })
    }
    return next()
  }
}

const ipLimiter = rateLimit({ windowMs: 60_000, max: 120, key: (req) => req.ip })
const userLimiter = rateLimit({ windowMs: 60_000, max: 60, key: (req) => req.userEmail })
const addressChangeLimiter = rateLimit({ windowMs: 15 * 60_000, max: 5, key: (req) => req.userEmail })

app.use('/api/trackingdetail', ipLimiter)

function requireApiKey(req, res, next) {
  if (!API_KEY) return next()
  const got = String(req.headers['x-api-key'] || '').trim()
  if (!got || got !== API_KEY) return res.status(401).json({ error: 'Unauthorized' })
  return next()
}

// Signed-in customers only: the email comes from the login token, never from the request.
function requireUserAuth(req, res, next) {
  if (!JWT_SECRET) return res.status(500).json({ error: 'Server missing JWT secret' })
  const m = String(req.headers?.authorization || '').match(/^Bearer\s+(.+)$/i)
  const token = m ? String(m[1] || '').trim() : ''
  if (!token) return res.status(401).json({ error: 'Sign in required' })
  try {
    const email = normalizeEmail(jwt.verify(token, JWT_SECRET)?.email)
    if (!email) return res.status(401).json({ error: 'Invalid token' })
    req.userEmail = email
    return next()
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}

function normalizeEmail(raw) {
  const e = String(raw || '').trim().toLowerCase()
  // Very small sanity check. DB has the source of truth.
  if (!e || !e.includes('@') || e.length > 150) return ''
  return e
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
    console.error('[tracking-service] carrier lookup failed', e?.message || e)
    return { ok: false, error: 'Failed to fetch tracking events' }
  }
}

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1')
    res.json({ ok: true, service: 'tracking-service', db: 'connected' })
  } catch (e) {
    console.error('[tracking-service] health check failed', e?.message || e)
    res.status(500).json({ ok: false, service: 'tracking-service', db: 'disconnected' })
  }
})

app.get('/api/trackingdetail/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1')
    res.json({ ok: true, service: 'tracking-service', db: 'connected' })
  } catch (e) {
    console.error('[tracking-service] health check failed', e?.message || e)
    res.status(500).json({ ok: false, service: 'tracking-service', db: 'disconnected' })
  }
})

app.get('/api/trackingdetail/tracking/:trackingNumber', requireApiKey, async (req, res) => {
  try {
    const trackingNumber = String(req.params.trackingNumber || '').trim()
    const out = await fetchTrackingEventsExternal(trackingNumber)
    if (!out.ok) return res.status(400).json(out)
    return res.json(out)
  } catch (e) {
    console.error('[tracking-service] tracking route failed', e)
    return res.status(500).json({ ok: false, error: 'Failed to fetch tracking' })
  }
})

// Only these columns are sent to the customer. Rows are still read with SELECT * and
// filtered here, so internal columns (admin remarks, payment screenshots, invoice
// metadata, bank account, raw gateway responses, user ids) never leave the server,
// including columns added to these tables later.
const CUSTOMER_ORDER_FIELDS = [
  'order_number', 'status', 'payment_status', 'payment_method', 'currency',
  'subtotal', 'shipping', 'total', 'discount_amount', 'tracking_number',
  'customer_name', 'shipping_address', 'shipping_city', 'shipping_state',
  'shipping_zip', 'shipping_country', 'created_at', 'updated_at',
]
const CUSTOMER_ITEM_FIELDS = ['name', 'sku', 'quantity', 'unit_price', 'line_total']
const CUSTOMER_PAYMENT_FIELDS = ['provider', 'amount', 'currency', 'status', 'created_at']
const CUSTOMER_ADDRESS_REQUEST_FIELDS = [
  'id', 'order_number', 'current_shipping_json', 'requested_shipping_json',
  'status', 'admin_note', 'decided_at', 'created_at', 'updated_at',
]

function pick(row, fields) {
  const out = {}
  for (const f of fields) if (row && row[f] !== undefined) out[f] = row[f]
  return out
}

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
    return orders.map((o) => ({ order: pick(o, CUSTOMER_ORDER_FIELDS), items: [], payments: [] }))
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
      order: pick(o, CUSTOMER_ORDER_FIELDS),
      items: (itemsByOrderId.get(oid) || []).map((it) => pick(it, CUSTOMER_ITEM_FIELDS)),
      payments: (paymentsByOrderId.get(oid) || []).map((p) => pick(p, CUSTOMER_PAYMENT_FIELDS)),
    }
  })
}

app.get('/api/trackingdetail/address-change-requests', requireUserAuth, userLimiter, async (req, res) => {
  try {
    const email = req.userEmail

    const limit = Math.min(Math.max(Number(req.query?.limit || 200), 1), 500)
    const [rows] = await pool.execute(
      `SELECT *
       FROM order_address_change_requests
       WHERE LOWER(TRIM(customer_email)) = ? AND domain_id = ?
       ORDER BY created_at DESC
       LIMIT ${Number.isFinite(limit) ? Math.trunc(limit) : 200}`,
      [String(email).trim().toLowerCase(), req.domainId]
    )
    const list = Array.isArray(rows) ? rows : []
    return res.json({ requests: list.map((r) => pick(r, CUSTOMER_ADDRESS_REQUEST_FIELDS)) })
  } catch (e) {
    console.error('[tracking-service] failed to fetch address change requests', e)
    return res.status(500).json({ error: 'Failed to fetch address change requests' })
  }
})

app.post('/api/trackingdetail/order/:orderNumber/address-change-request', requireUserAuth, addressChangeLimiter, async (req, res) => {
  let connection
  try {
    const email = req.userEmail

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
app.post('/api/trackingdetail/orders', requireUserAuth, userLimiter, async (req, res) => {
  try {
    const email = req.userEmail

    const limit = Math.min(Math.max(Number(req.body?.limit || 50), 1), 200)
    const orders = await fetchTrackingDetailsByEmail(email, limit, req.domainId)
    return res.json({ email, orders })
  } catch (e) {
    console.error('[tracking-service] failed to fetch orders', e)
    return res.status(500).json({ error: 'Failed to fetch tracking details' })
  }
})

app.listen(PORT, () => {
  console.log(`✅ tracking-service running on port ${PORT}`)
})

;(async () => {
  await ensureOrderAddressChangeRequestsTable()
})().catch(() => {})
