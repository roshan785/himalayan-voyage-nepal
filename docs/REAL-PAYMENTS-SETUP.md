# Real Payments — eSewa & Khalti setup guide

This document is the operator checklist for switching the Travel Shop from the
test provider to **real** eSewa / Khalti payments. It reflects what is actually
implemented in `src/payments.js` and verified by the test suite.

> **Current status (honest):** the code is implemented and verified against
> *simulated* gateways (a local mock for each provider's documented request and
> callback shapes). It has **not** been run against eSewa's or Khalti's real
> sandbox, because that requires **your** merchant credentials. Until a real
> sandbox run is done, no provider is marked `live`.

## 0. Where eSewa calls back (important for the URL to be correct)

eSewa redirects the customer's browser back to **`success_url` + `?data=<base64>`**,
appending with a literal `?`. Therefore `success_url` / `failure_url` must carry
**no query string of their own** — otherwise the browser parses
`status = "esewa-success?data=eyJ..."` and the signed `data` payload is lost, so
the payment can never be verified.

The app sends a clean `https://<your-site>/order.html`, then recovers the order
reference from the decoded `data` blob (`transaction_uuid`). This is enforced by
a test (`eSewa return URLs are clean so ?data= is not corrupted`).

---

## 1. What is already done (no action needed)

| Area | Status |
|---|---|
| eSewa ePay v2 adapter | ✅ signed form POST, HMAC-SHA256 verify **+** gateway transaction-status check |
| Khalti ePayment v2 adapter | ✅ server initiate (`pidx`) **+** server lookup verify |
| Sandbox/production host switch | ✅ one `PAYMENT_ENV` variable picks all gateway hosts |
| Mock provider | ✅ hard-blocked when `PAYMENT_ENV=production` |
| Server-side verification | ✅ a browser redirect alone can **never** mark an order paid |
| Amount / reference / status checks | ✅ verified signature **and** amount **and** gateway status |
| Duplicate protection | ✅ atomic confirm (`payment_status != 'paid'`) + partial unique index on `payment_ref` |
| Failed / cancelled / pending | ✅ left unpaid, never auto-confirmed |
| Preserve existing data | ✅ only additive tables (`orders`, `order_items`) |

---

## 2. What YOU must do before real payments can go live

### 2.1 eSewa merchant account (KYC)

1. Register at **https://merchant.esewa.com.np** and complete KYC — you will need:
   - Business/company registration or PAN/VAT certificate
   - Bank account details (settlement account)
   - Citizenship / ID of the authorised signatory
2. After approval, eSewa issues:
   - a **product code / service code** (a short string),
   - a **merchant secret key**.
3. Before approval you can use the **integration/sandbox** product code
   `EPAYTEST` with its published secret to test end-to-end in the RC host.
4. Confirm the callback/redirect host they expect; it must match your
   `PUBLIC_BASE_URL` (HTTPS).

### 2.2 Khalti merchant account (KYC)

1. Register at **https://admin.khalti.com** (live) and complete KYC:
   - Business documents + PAN/VAT
   - Bank account for settlement
   - Authorised signatory ID
2. Sandbox access: **https://test-admin.khalti.com** — no KYC needed for testing.
   - Sandbox test IDs: `9800000000` … `9800000005`, MPIN `1111`, OTP `987654`.
3. Copy the **`live_secret_key`** from the dashboard
   (sandbox key from test-admin, live key from admin).
4. Whitelist your return URL (your `PUBLIC_BASE_URL`) in the dashboard.

> Both providers settle to a **Nepali bank account** and require a completed
> merchant agreement. This is why real money cannot flow until these accounts
> exist and are approved — nothing in the code can substitute for them.

---

## 3. Environment variables to set in Render

Dashboard → **himalayan-voyage-nepal** → **Environment**. Add each key.

| Key | Value | Where to get it |
|---|---|---|
| `PUBLIC_BASE_URL` | `https://himalayan-voyage-nepal-0sem.onrender.com` | Your live site origin (HTTPS, no trailing slash) |
| `PAYMENT_ENV` | `sandbox` first, then `production` | You choose; **only** this switches live/sandbox |
| `ESEWA_PRODUCT_CODE` | e.g. `EPAYTEST` (sandbox) or your live code | eSewa merchant portal |
| `ESEWA_SECRET_KEY` | your merchant secret | eSewa merchant portal |
| `KHALTI_SECRET_KEY` | `live_secret_key_...` | Khalti dashboard (test-admin for sandbox) |

Already present and unchanged (do not remove): `DATABASE_URL`, `JWT_SECRET`,
`ADMIN_EMAIL`, `ADMIN_PASSWORD`, `NODE_VERSION`.

**Do NOT** set `ESEWA_BASE_URL` / `KHALTI_BASE_URL` unless a provider tells you
to use a different host — the correct host is chosen from `PAYMENT_ENV`.

### Verify the wiring (after setting the variables)

```bash
curl -s https://himalayan-voyage-nepal-0sem.onrender.com/api/health | python3 -m json.tool
```

Look for the `payments` block — it reports the environment, whether mock is
allowed, and which gateways are configured (never a secret value):

```json
"payments": {
  "env": "sandbox",
  "mockAllowed": true,
  "publicBaseUrlSet": true,
  "esewa": { "configured": true, "host": "https://rc-epay.esewa.com.np" },
  "khalti": { "configured": true, "host": "https://dev.khalti.com/api/v2" }
}
```

---

## 4. Sandbox test procedure (do this BEFORE production)

### 4.1 Run it locally first (no credentials needed for the offline mock)

```bash
cd ~/Documents/OpenOS/apps/travel-nepal
DATABASE_URL="sqlite:/tmp/hv-test.db" npm test     # isolated DB only
```
The suite covers the eSewa form fields, signature, callback parsing, replay and
tamper cases without touching any real gateway.

### 4.2 Then against eSewa's real sandbox

Set `PAYMENT_ENV=sandbox` plus `ESEWA_PRODUCT_CODE=EPAYTEST` and the **published
EPAYTEST secret** (obtain it from eSewa — it is not stored in this repo), and
`PUBLIC_BASE_URL` to a URL eSewa can redirect back to.

1. Open the shop, add a package, go to checkout, choose **eSewa**.
2. Complete the payment with eSewa's sandbox test credentials.
3. Confirm:
   - you are returned to `/order.html?data=...`,
   - the order shows **Paid** (the server verified it — not the browser),
   - the admin **Orders** view shows `payment_status = paid` and the gateway ref,
   - the same callback sent twice does not double-confirm.
4. Repeat once with a **failure** flow and confirm the order stays unpaid.

Only after all of the above pass should you consider production.

---

## 5. Switching to production (real money)

1. Set `PAYMENT_ENV=production` and the **live** eSewa/Khalti credentials.
2. `mock` disappears automatically; `/api/payments/providers` will list only the
   real gateways and `bank`.
3. Run **one real, small-value transaction** and verify it end-to-end.
4. Watch the admin Orders view and both provider dashboards for the settlement.

> ⚠️ Real money moves from step 1 onward. Do not flip `PAYMENT_ENV=production`
> until the sandbox procedure in §4 has passed with your own credentials.

---

## 6. Security properties (why a redirect cannot fake a payment)

- The **browser redirect is only evidence.** The server re-derives everything:
  - eSewa: re-computes the callback HMAC with the merchant secret **and** calls
    eSewa's transaction-status API; both must say success.
  - Khalti: calls Khalti's server-to-server `lookup` with the `pidx`.
- The **amount** the gateway reports must equal the stored order total.
- Confirmation is **atomic**: `UPDATE ... WHERE payment_status != 'paid'`, so a
  replayed or concurrent callback confirms an order at most once.
- A verified gateway reference is protected by a **partial unique index**, so
  one transaction cannot back two orders.
- In production, `mock` is **disabled** unless an operator opts in explicitly.

---

## 7. Rollback

Set `PAYMENT_ENV=sandbox` (or remove the gateway keys). The site immediately
stops offering real gateways; orders, bookings and data are untouched.
`mock` becomes available again for local development only.
