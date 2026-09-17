// whop-cf-bridge — ClickFunnels 2.0 webhooks -> Whop Ads Events API
//
// Flow:  CF workspace webhook (invoice paid / order completed)
//        -> POST /cf/<licensee-slug>
//        -> map each paid line item to a Whop event (purchase / bump_x / oto_x / downsell)
//        -> POST https://api.whop.com/api/v1/events  (one call per product, deduped)
//
// Config: env LICENSEES = JSON (see licensees.example.json). Keys never live in the repo.

const express = require('express');
const crypto = require('crypto');

const WHOP_EVENTS_URL = process.env.WHOP_EVENTS_URL || 'https://api.whop.com/api/v1/events';
const DRY_RUN = process.env.DRY_RUN === '1';
const PORT = process.env.PORT || 3900;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// ---------- licensee config ----------
function loadLicensees() {
  let raw = process.env.LICENSEES;
  if (!raw) {
    try { raw = require('fs').readFileSync(__dirname + '/licensees.local.json', 'utf8'); } catch { raw = '{}'; }
  }
  const cfg = JSON.parse(raw);
  for (const [slug, l] of Object.entries(cfg)) {
    if (!l.account_id || !l.api_key) throw new Error(`licensee ${slug}: account_id + api_key required`);
    l.products = l.products || [];
  }
  return cfg;
}
let LICENSEES = loadLicensees();

// ---------- helpers ----------
const slugify = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

// CF payloads accepted by CF for event type -> we accept any of these
const PAID_EVENTS = new Set([
  'one-time-order.invoice.paid',
  'orders/invoice.paid',
  'one-time-order.completed',
  'order.completed',
]);

// Pick the product mapping rule for a line item.
// Rule shape: { match: "22 niches" | ["22 niches","niches"], product_id?: 123, event: "bump_22_niches", value?: 14.95 }
function findRule(licensee, item) {
  const name = (item.name || '').toLowerCase();
  for (const r of licensee.products) {
    if (r.product_id && (r.product_id === item.product_id || r.product_id === item.variant_id)) return r;
    const pats = Array.isArray(r.match) ? r.match : (r.match ? [r.match] : []);
    if (pats.some(p => name.includes(String(p).toLowerCase()))) return r;
  }
  return null;
}

// Normalise a CF line item (order line items and invoice line items differ slightly)
function normaliseItem(li) {
  const qty = num(li.quantity) || 1;
  const unit = num(li.products_price?.amount ?? li.price?.amount ?? li.unit_amount ?? li.amount);
  const total = li.total_amount != null ? num(li.total_amount) : unit * qty;
  return {
    id: li.id,
    name: li.products_variant?.name || li.original_product?.name || li.product?.name || li.name || '',
    product_id: li.original_product?.id || li.product?.id || li.product_id || null,
    variant_id: li.products_variant?.id || li.variant_id || null,
    quantity: qty,
    unit,
    total: total || unit,
    currency: (li.products_price?.currency || li.currency || 'usd').toLowerCase(),
  };
}

function extractContact(data) {
  const c = data.contact || data.order?.contact || {};
  return {
    email: c.email_address || data.email_address || data.email || '',
    first_name: c.first_name || '',
    last_name: c.last_name || '',
    phone: c.phone_number || data.phone_number || '',
    external_id: c.id ? String(c.id) : (data.contact_id ? String(data.contact_id) : ''),
  };
}

// Turn a CF webhook body into a list of Whop event bodies
function buildEvents(licensee, body) {
  const data = body.data || {};
  const orderId = data.order_id || (data.subject_type === 'Order' ? data.id : null) || data.order?.id || data.id;
  const items = (data.line_items || []).map(normaliseItem);
  const contact = extractContact(data);
  const out = [];
  for (const it of items) {
    const rule = findRule(licensee, it);
    const eventName = rule?.event || slugify(it.name) || 'unknown_product';
    const value = rule?.value != null ? num(rule.value) : it.total;
    if (rule?.skip) continue;
    if (!(value > 0)) continue; // Whop rejects purchase events with value <= 0
    const key = `${orderId}-${it.variant_id || it.product_id || slugify(it.name)}`;
    out.push({
      dedupe_key: `${licensee.account_id}:${key}`,
      whop: {
        account_id: licensee.account_id,
        event_name: eventName,
        event_id: `cf-${key}`,
        action_source: 'website',
        value,
        currency: it.currency || 'usd',
        user: {
          email: contact.email,
          first_name: contact.first_name,
          last_name: contact.last_name,
          phone: contact.phone,
          external_id: contact.external_id,
        },
      },
      meta: { order_id: orderId, product: it.name, cf_event: body.event_type },
    });
  }
  return out;
}

// ---------- dedupe (in-memory; Whop event_id is the durable guard) ----------
const seen = new Map(); // key -> ts
const SEEN_TTL_MS = 7 * 24 * 3600 * 1000;
function alreadySent(key) {
  const ts = seen.get(key);
  if (ts && Date.now() - ts < SEEN_TTL_MS) return true;
  return false;
}
function markSent(key) { seen.set(key, Date.now()); if (seen.size > 50000) { const k = seen.keys().next().value; seen.delete(k); } }

// ---------- recent log for debugging ----------
const recent = [];
function logEvent(entry) { recent.unshift({ ts: new Date().toISOString(), ...entry }); if (recent.length > 200) recent.pop(); console.log(JSON.stringify(entry)); }

async function postToWhop(apiKey, whopBody) {
  if (DRY_RUN) return { status: 200, text: 'DRY_RUN', dry: true };
  const res = await fetch(WHOP_EVENTS_URL, {
    method: 'POST',
    headers: { 'Authorization': apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(whopBody),
  });
  const text = await res.text();
  return { status: res.status, text };
}

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => res.json({ ok: true, licensees: Object.keys(LICENSEES).length, dry_run: DRY_RUN }));

app.post('/cf/:slug', async (req, res) => {
  const licensee = LICENSEES[req.params.slug];
  if (!licensee) return res.status(404).json({ error: 'unknown licensee' });
  const body = req.body || {};
  const eventType = body.event_type || '';

  if (!PAID_EVENTS.has(eventType)) {
    logEvent({ slug: req.params.slug, cf_event: eventType, action: 'ignored' });
    return res.status(200).json({ ok: true, ignored: eventType });
  }
  // invoice events: only act on paid invoices; order events: only completed/paid
  const st = (body.data?.status || body.data?.billing_status || '').toLowerCase();
  if (st && !['paid', 'completed', 'succeeded', 'active'].includes(st)) {
    logEvent({ slug: req.params.slug, cf_event: eventType, action: 'ignored_status', status: st });
    return res.status(200).json({ ok: true, ignored_status: st });
  }

  const events = buildEvents(licensee, body);
  const results = [];
  let retryable = false;
  for (const ev of events) {
    if (alreadySent(ev.dedupe_key)) { results.push({ ...ev.meta, event: ev.whop.event_name, action: 'dedupe_skip' }); continue; }
    try {
      const r = await postToWhop(licensee.api_key, ev.whop);
      const ok = r.status >= 200 && r.status < 300;
      if (ok) markSent(ev.dedupe_key);
      if (r.status >= 500) retryable = true;
      results.push({ ...ev.meta, event: ev.whop.event_name, value: ev.whop.value, email: ev.whop.user.email, whop_status: r.status, whop_resp: r.text.slice(0, 300), body: DRY_RUN ? ev.whop : undefined });
    } catch (e) {
      retryable = true;
      results.push({ ...ev.meta, event: ev.whop.event_name, error: String(e.message || e) });
    }
  }
  logEvent({ slug: req.params.slug, cf_event: eventType, order_id: events[0]?.meta.order_id, sent: results });
  // 500 makes ClickFunnels retry (1s,15s,1m,5m,15m,1h,12h,24h); 200 = done
  res.status(retryable ? 500 : 200).json({ ok: !retryable, events: results });
});

app.get('/admin/recent', (req, res) => {
  if (!ADMIN_TOKEN || req.query.token !== ADMIN_TOKEN) return res.status(403).end();
  res.json(recent);
});
app.post('/admin/reload', (req, res) => {
  if (!ADMIN_TOKEN || req.query.token !== ADMIN_TOKEN) return res.status(403).end();
  LICENSEES = loadLicensees();
  res.json({ ok: true, licensees: Object.keys(LICENSEES) });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`whop-cf-bridge listening on :${PORT} dry_run=${DRY_RUN} licensees=${Object.keys(LICENSEES).join(',')}`));
}
module.exports = { app, buildEvents, normaliseItem, loadLicensees };
