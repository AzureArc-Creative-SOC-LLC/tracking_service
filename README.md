# tracking-service

A small microservice that lets signed-in customers look up their orders and submit shipping-address change requests. Customers sign in through `user-order-service`; this service verifies that login token itself and never calls `user-order-service`.

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js >= 18 (ESM) |
| Framework | Express 4 |
| Database | PostgreSQL via `pg`, through `db-adapter.js` (mysql2-compatible shim) |
| Auth | Login JWT from `user-order-service` (`jsonwebtoken`, shared `JWT_SECRET`) |

## Getting started

```bash
npm install
npm run dev    # nodemon, auto-restart
npm start      # plain node
```

Copy `.env.example` to `.env` and fill in real values. In production the service reads `/var/www/.env`.

The server starts on port `5002` by default (`TRACKING_SERVICE_PORT`).

## Configuration

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | Must equal the value in `user-order-service`, so its login tokens verify here. |
| `TRACKING_API_KEY` | Optional. Protects `GET /tracking/:trackingNumber` via `x-api-key`. |
| `TRACKING_EVENTS_API_BASE_URL`, `TRACKING_EVENTS_API_KEY`, `TRACKING_EVENTS_DEFAULT_CARRIER` | Carrier events provider (optional). |
| `CORS_ORIGIN` | Optional extra allowed hosts, comma separated. Active storefront domains from the `domains` table are always allowed. |
| `DATABASE_URL` or `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASS`/`DB_NAME` | Database. |

The storefront is detected from the request `Origin` header and matched against the `domains` table. Orders and address-change requests are filtered by that domain.

## Routes

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /health` | No | DB liveness probe. |
| `GET /api/trackingdetail/health` | No | Same probe under the `/api` prefix. |
| `POST /api/trackingdetail/orders` | Bearer login token | The signed-in customer's orders + items + payments. Email comes from the token. |
| `GET /api/trackingdetail/tracking/:trackingNumber` | `x-api-key` (if set) | Carrier tracking events from an external provider (needs `TRACKING_EVENTS_API_BASE_URL`). |
| `GET /api/trackingdetail/address-change-requests` | Bearer login token | The customer's address-change requests. |
| `POST /api/trackingdetail/order/:orderNumber/address-change-request` | Bearer login token | Submits a shipping-address change request (rejects if one is already pending for that order). |

Rate limits: 120/min per IP; 60/min per user on orders and request listing; 5 per 15 min per user on creating address-change requests. See `documentation/API_DOCUMENTATION.md`.
