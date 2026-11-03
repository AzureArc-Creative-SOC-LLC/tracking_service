# tracking-service — API Reference

**Base URL:** `https://www.microservices.tech` (production) or `http://localhost:5002` (local, `TRACKING_SERVICE_PORT`)

All responses are `application/json`. Requests with a body expect `Content-Type: application/json`.

---

## Authentication

There is no OTP. Customer routes use the **login token issued by `user-order-service`** (`POST /api/auth/login`). This service verifies that token itself with the shared `JWT_SECRET` — it never calls `user-order-service`, so the two services stay independent.

```
Authorization: Bearer <token from /api/auth/login>
```

The customer's email is taken **from the token**. Any `email` sent in the body or query string is ignored, so a signed-in user can only see their own data.

`GET /tracking/:trackingNumber` is the exception: it reads no customer data and uses the server-side `TRACKING_API_KEY` (header `x-api-key`) when one is configured.

### Auth failure responses (customer routes)

| Status | Body | Meaning |
|---|---|---|
| `401` | `{ "error": "Sign in required" }` | No `Authorization` header |
| `401` | `{ "error": "Invalid token" }` | Token has no valid email |
| `401` | `{ "error": "Invalid or expired token" }` | Bad signature or expired (tokens last 30 days) |
| `500` | `{ "error": "Server missing JWT secret" }` | `JWT_SECRET` not set on this service |

On a `401`, log the user in again to get a new token.

---

## Storefront (domain) detection

Every request is scoped to a storefront, taken from the browser's `Origin` header (then `Referer`, then `Host`) and matched against the active rows of the `domains` table. Orders and address-change requests are filtered by that `domain_id`. An unknown or inactive host falls back to the default domain (`alluvi.store`).

## CORS

Browsers are allowed from active storefront domains in the `domains` table, plus any hosts listed in `CORS_ORIGIN` (optional, comma separated). Requests with no `Origin` (server-to-server, curl) are not affected.

## Rate limits

Over the limit the service returns `429 { "error": "Too many requests. Please try again later." }` with a `Retry-After` header (seconds).

| Scope | Routes | Limit |
|---|---|---|
| Per IP | all `/api/trackingdetail/*` | 120 / minute |
| Per signed-in user | `POST /orders`, `GET /address-change-requests` | 60 / minute |
| Per signed-in user | `POST /order/:orderNumber/address-change-request` | 5 / 15 minutes |

---

## Endpoints

| Method | Path | Auth |
|---|---|---|
| GET | `/health` | none |
| GET | `/api/trackingdetail/health` | none |
| POST | `/api/trackingdetail/orders` | Bearer |
| GET | `/api/trackingdetail/address-change-requests` | Bearer |
| POST | `/api/trackingdetail/order/:orderNumber/address-change-request` | Bearer |
| GET | `/api/trackingdetail/tracking/:trackingNumber` | `x-api-key` (if configured) |

---

## Health

### GET `/health` and GET `/api/trackingdetail/health`

No auth. Both do the same check (`SELECT 1`).

**Response `200`:**
```json
{ "ok": true, "service": "tracking-service", "db": "connected" }
```

**Response `500`** (database unreachable; the error detail is logged server-side only):
```json
{ "ok": false, "service": "tracking-service", "db": "disconnected" }
```

---

## Orders

Data comes from the shared `orders`, `order_items` and `payments` tables owned by `admin-service`. Only a fixed list of customer-safe fields is returned (shown in the example below). Internal columns — admin remarks, payment screenshots, invoice metadata, bank account used, raw gateway responses, user and row ids — are never sent, including columns added to those tables later. Read fields defensively (e.g. `order.tracking_number ?? null`).

### POST `/api/trackingdetail/orders`

Lists the signed-in customer's orders for the current storefront, newest first, each with its items and payments.

**Auth:** Bearer

**Request body** (optional):
```json
{ "limit": 50 }
```
`limit` is optional: default 50, max 200. Any `email` field is ignored.

**Response `200`:** (`email` is the token's email)
```json
{
  "email": "jane@example.com",
  "orders": [
    {
      "order": {
        "order_number": "ORD-20260630-163929904-273E19",
        "status": "pending",
        "payment_status": "pending",
        "payment_method": "Manual",
        "currency": "GBP",
        "subtotal": "260.00",
        "shipping": "0.00",
        "total": "260.00",
        "discount_amount": "0.00",
        "tracking_number": null,
        "customer_name": "Jane Doe",
        "shipping_address": "22 Baker St",
        "shipping_city": "London",
        "shipping_state": null,
        "shipping_zip": "NW1 6XE",
        "shipping_country": "United Kingdom",
        "created_at": "2026-06-30T16:39:28.000Z",
        "updated_at": "2026-06-30T16:39:28.026Z"
      },
      "items": [
        { "name": "BPC-157 & TB-500", "sku": "bpc-157-tb-500", "quantity": 2, "unit_price": "130.00", "line_total": "260.00" }
      ],
      "payments": [
        { "provider": "Manual", "amount": "260.00", "currency": "GBP", "status": "pending", "created_at": "2026-06-30T16:39:28.000Z" }
      ]
    }
  ]
}
```
`orders` is sorted newest-first. `items` and `payments` can be empty arrays.

**Response `401`:** see "Auth failure responses".

**Response `429`:** rate limit.

**Response `500`:**
```json
{ "error": "Failed to fetch tracking details" }
```

---

## Carrier Tracking

### GET `/api/trackingdetail/tracking/:trackingNumber`

Fetches live carrier events from an external provider.

> Works only when the operator has set `TRACKING_EVENTS_API_BASE_URL`; otherwise it returns the `400` "not configured" response below. It reads nothing from the database.

**Auth:** `x-api-key: <TRACKING_API_KEY>` when that key is configured on the server (if no key is configured the route is open).

| Param | Type | Notes |
|---|---|---|
| `trackingNumber` | string | the carrier tracking number |

**Response `200`:**
```json
{
  "ok": true,
  "trackingNumber": "AB123456789GB",
  "carrier": "royalmail",
  "events": [
    {
      "status": "Delivered",
      "location": "London, UK",
      "timestamp": "2026-07-01T09:15:00Z",
      "raw": { "...": "original event object exactly as returned by the carrier provider" }
    }
  ]
}
```

**Response `400`:**
```json
{ "ok": false, "error": "Tracking events API is not configured" }
```
Also used for a missing `trackingNumber` and provider-side errors, with a different `error` string.

**Response `401`:** `{ "error": "Unauthorized" }` (missing or wrong `x-api-key`).

**Response `500`:**
```json
{ "ok": false, "error": "Failed to fetch tracking" }
```

---

## Address Change Requests

### GET `/api/trackingdetail/address-change-requests`

Lists the signed-in customer's shipping-address change requests for the current storefront, newest first.

**Auth:** Bearer

**Query params:** `limit` (optional, default 200, max 500). Any `email` is ignored.

**Response `200`:**
```json
{
  "requests": [
    {
      "id": 1,
      "order_number": "ORD-20260630-163929904-273E19",
      "current_shipping_json": "{\"shipping_address\":\"22 Baker St\",\"shipping_city\":\"London\",\"shipping_zip\":\"NW1 6XE\",\"shipping_country\":\"United Kingdom\"}",
      "requested_shipping_json": "{\"shipping_address\":\"99 New Street\",\"shipping_city\":\"Manchester\",\"shipping_zip\":\"M1 1AA\",\"shipping_country\":\"United Kingdom\"}",
      "status": "pending",
      "admin_note": null,
      "decided_at": null,
      "created_at": "2026-07-03T14:28:40.000Z",
      "updated_at": "2026-07-03T14:28:40.000Z"
    }
  ]
}
```

`current_shipping_json` and `requested_shipping_json` are **JSON-encoded strings** — `JSON.parse()` them. Each parses to `{ shipping_address, shipping_city, shipping_zip, shipping_country }`.

`status` is `pending`, `approved` or `rejected` (approval happens in `admin-service`).

**Response `500`:**
```json
{ "error": "Failed to fetch address change requests" }
```

### POST `/api/trackingdetail/order/:orderNumber/address-change-request`

Requests a shipping-address change for one of the signed-in customer's orders. It only queues a `pending` request for an admin; it does not change the order.

**Auth:** Bearer

| Param | Type | Notes |
|---|---|---|
| `orderNumber` | string | the order's `order_number` |

**Request body:**
```json
{
  "shipping_address": "99 New Street",
  "shipping_city": "Manchester",
  "shipping_zip": "M1 1AA",
  "shipping_country": "United Kingdom"
}
```
`shipping_address` is required; the other fields are optional (empty string if omitted). Any `email` field is ignored.

**Response `200`:**
```json
{ "success": true, "id": 1 }
```

**Response `400`:** `{ "error": "orderNumber is required" }` or `{ "error": "shipping_address is required" }`

**Response `404`** (order not found, not yours, or on another storefront):
```json
{ "error": "Order not found" }
```

**Response `409`** (a pending request already exists for this order):
```json
{ "error": "A pending address change request already exists for this order." }
```

**Response `429`:** rate limit (5 per 15 minutes per user).

**Response `500`:**
```json
{ "error": "Failed to submit address change request" }
```

---

## Error response shape

Customer routes use `{ "error": "..." }`. The carrier tracking route and health use `{ "ok": false, ... }`. Internal error text is never returned to clients; it is written to the server log.
