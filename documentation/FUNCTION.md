# tracking-service — Function Reference

Everything lives in `index.js`. Customer auth is the login token issued by `user-order-service` (same `JWT_SECRET`); there is no OTP.

## Configuration helpers

### `env(name, fallback = '')`
Reads `process.env[name]`; returns `fallback` if unset or blank. Used for every config constant at startup (`PORT`, `DB_*`, `API_KEY`, `JWT_SECRET`, `CORS_ORIGIN`) and by `fetchTrackingEventsExternal` (`TRACKING_EVENTS_*`).

### `envInt(name, fallback)`
Same as `env`, coerced to a number; returns `fallback` if not finite. Used for `PORT` and `DB_PORT`.

---

## Date/time helper

### `nowMysqlDatetime()`
Current time as `YYYY-MM-DD HH:MM:SS` (server local time). Used by `POST .../address-change-request` to stamp `created_at` and `updated_at`.

---

## Storefront and CORS

### `domainMiddleware` (from `domainMiddleware.js`)
Runs on every request. Resolves the storefront from `Origin`, then `Referer`, then `Host`, looks it up in the `domains` table (60 s cache), and sets `req.domain` and `req.domainId`. Unknown or inactive hosts fall back to `alluvi.store`. It never rejects a request.

### `corsOriginCheck(origin, cb)`
CORS origin callback. Allows requests with no `Origin`, hosts in `CORS_ORIGIN`, localhost outside production, and any active domain in the `domains` table (60 s cache). Everything else is blocked.

---

## Schema bootstrap (startup only)

### `ensureOrderAddressChangeRequestsTable()`
Idempotently creates `order_address_change_requests`. The table is shared with `admin-service`, so this is a no-op when it already exists. It does **not** add `domain_id` to an existing table; that column must be added in the database. Errors are logged, not thrown. Called once from the startup IIFE.

---

## Auth and limits

### `requireUserAuth(req, res, next)`
Middleware for customer routes. Requires `Authorization: Bearer <token>`, verifies it with `JWT_SECRET`, normalises the token's `email` claim and sets `req.userEmail`. Returns `401` for a missing, invalid or expired token and `500` if `JWT_SECRET` is not set. Any email in the body or query string is ignored.

**Used by:** `POST /api/trackingdetail/orders`, `GET /api/trackingdetail/address-change-requests`, `POST /api/trackingdetail/order/:orderNumber/address-change-request`.

### `requireApiKey(req, res, next)`
If `TRACKING_API_KEY` is set, requires a matching `x-api-key` header (`401` otherwise); if unset, passes through.

**Used by:** `GET /api/trackingdetail/tracking/:trackingNumber`.

### `rateLimit({ windowMs, max, key })`
In-memory fixed-window limiter (no dependency; single pm2 process). Returns `429` with `Retry-After` when a key exceeds `max` in the window. Expired entries are swept on a timer.

| Limiter | Key | Limit | Applied to |
|---|---|---|---|
| `ipLimiter` | `req.ip` | 120 / min | all `/api/trackingdetail/*` |
| `userLimiter` | `req.userEmail` | 60 / min | `POST /orders`, `GET /address-change-requests` |
| `addressChangeLimiter` | `req.userEmail` | 5 / 15 min | `POST /order/:orderNumber/address-change-request` |

### `normalizeEmail(raw)`
Trims and lowercases an email; returns `''` unless it contains `@` and is at most 150 characters. Used to validate the token's email claim.

---

## Data helpers

### `fetchTrackingEventsExternal(trackingNumber)`
Calls the external carrier provider (`GET {TRACKING_EVENTS_API_BASE_URL}/track?tracking=…&carrier=…`) and normalises the result to `{ ok, trackingNumber, carrier, events[] }`. Returns `{ ok: false, error }` if the provider is not configured or the call fails (details are logged, not returned).

### `fetchTrackingDetailsByEmail(email, limit, domainId)`
Loads the email's orders for that domain (newest first, limit 1–200, default 50), plus their `order_items` and `payments`, and groups them as `[{ order, items, payments }]`. Rows are read with `SELECT *` but filtered through `pick()` and the `CUSTOMER_*_FIELDS` lists, so only customer-safe columns are returned. Returns `[]` when there are no orders.

### `pick(row, fields)`
Returns a copy of `row` containing only the listed fields. Used for orders, items, payments and address-change requests.

---

## Routes

| Route | Guard | What it does | Uses |
|---|---|---|---|
| `GET /health` | none | `SELECT 1`; returns DB status. | `pool` |
| `GET /api/trackingdetail/health` | none | Same check under the `/api` prefix. | `pool` |
| `GET /api/trackingdetail/tracking/:trackingNumber` | `requireApiKey` | Fetches carrier events from the external provider. | `fetchTrackingEventsExternal` |
| `POST /api/trackingdetail/orders` | `requireUserAuth`, `userLimiter` | Returns `{ email, orders }` for the token's email; optional body `limit`. | `fetchTrackingDetailsByEmail` |
| `GET /api/trackingdetail/address-change-requests` | `requireUserAuth`, `userLimiter` | Lists the user's address-change requests for the domain (limit 1–500, default 200). | `pool` |
| `POST /api/trackingdetail/order/:orderNumber/address-change-request` | `requireUserAuth`, `addressChangeLimiter` | Locks the user's order row (must match email and domain, else `404`), rejects if a `pending` request exists (`409`), snapshots the current address and inserts a `pending` request. | `nowMysqlDatetime` |

All routes also pass through `ipLimiter` and `domainMiddleware`.

### Startup sequence
```js
app.listen(PORT, ...)
;(async () => {
  await ensureOrderAddressChangeRequestsTable()
})().catch(() => {})
```

---

## External modules

| Import | From | Role |
|---|---|---|
| `mysql` (aliased) | `./db-adapter.js` | `mysql2/promise`-compatible pool that translates MySQL-dialect SQL to PostgreSQL via `pg`. |
| `createDomainMiddleware` | `./domainMiddleware.js` | Storefront detection. |
| `jwt` | `jsonwebtoken` | Verifies the login token. |
