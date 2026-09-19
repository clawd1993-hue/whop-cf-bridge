# whop-cf-bridge

ClickFunnels 2.0 → Whop Ads purchase tracking for FFC licensees who run their funnel on ClickFunnels (not GHL).

**Why:** Whop Ads attributes sales with its own pixel + Events API. ClickFunnels' outgoing webhooks can't be custom-shaped, so this tiny server translates CF's order/invoice payload into Whop's exact event format (one Whop event per product, deduped).

## Per-licensee setup (2 things)
1. **Whop pixel** in the funnel head (Funnel → Settings → Head tracking code) with their `biz_` id.
2. **CF webhook:** Workspace Settings → Webhooks → Add New Endpoint
   - URL: `https://<this-service>/cf/<their-slug>`
   - Event types: `one-time-order.invoice.paid` (+ `order.completed` as backup, safe: deduped)
   - API version: **V2**
   - Scope: their FFC funnel (optional)

Needs CF **Scale plan or above** (webhooks).

## Config
Env var `LICENSEES` = JSON like `licensees.example.json`. `products[].match` = case-insensitive substring of the CF product/variant name → Whop `event`. Unmatched products still get sent, as a slugified name with the real charged amount. `value` in a rule overrides the CF amount (keeps Whop formulas exact).

Event names must match the Whop custom-metric formulas: `purchase`, `bump_22_niches`, `bump_viral_reels`, `oto_dfy_funnel`, `oto_dfy_products`, `downsell`.

## Behaviour
- Only acts on paid invoices / completed orders. Everything else → 200 ignored.
- Dedupe: in-memory (7 days) + Whop `event_id = cf-<orderId>-<variantId>` so CF retries and order.completed re-fires never double count.
- Whop 5xx / network error → responds 500 so CF retries (1s → 24h schedule). Whop 4xx → logged, 200 (retry won't help).
- **Opt-in tracking:** add CF events `contact.created` + `contact.identified` to the webhook → bridge sends one Whop `lead` event per contact (no value, `event_id cf-lead-<contactId>`, deduped). Override the name per licensee with `"lead_event": "optin"` in LICENSEES.
- `GET /health`, `GET /admin/recent?token=…` (last 200 deliveries), `POST /admin/reload?token=…`.

## Local test
`npm test` — runs fake CF payloads through the bridge in DRY_RUN.
