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
// CF contact events -> one Whop `lead` event (opt-in tracking, no value)
const LEAD_EVENTS = new Set(['contact.created', 'contact.identified']);

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

// ---------- attribution (Whop needs anonymous_id + landing URL to credit an ad) ----------
// CF contact payloads carry `visits` (first_visit / last_visit / last_visit_with_utm: landing_page, ip,
// user_agent, utm_*) and `custom_attributes` (hidden form field `whop_visitor_id` = Whop _wuid cookie).
// We remember what we saw on contact events so later order events (which may carry less) still get it.
const attrCache = new Map(); // contact_id -> { anonymous_id, url, ip, ua, utm, ts }
const ATTR_TTL_MS = 28 * 24 * 3600 * 1000;
function cacheAttr(id, a) { if (!id || !a) return; attrCache.set(String(id), { ...a, ts: Date.now() }); if (attrCache.size > 50000) attrCache.delete(attrCache.keys().next().value); }
function cachedAttr(id) { const a = attrCache.get(String(id || '')); if (!a) return null; if (Date.now() - a.ts > ATTR_TTL_MS) { attrCache.delete(String(id)); return null; } return a; }
function qs(url, key) { try { return new URL(url).searchParams.get(key) || ''; } catch { return ''; } }
function extractAttribution(data) {
  const c = data.contact || data.order?.contact || data;
  const ca = c.custom_attributes || data.custom_attributes || {};
  const v = c.visits || data.visits || {};
  const visit = v.last_visit_with_utm || v.first_visit || v.last_visit || null;
  const a = {
    anonymous_id: String(ca.whop_visitor_id || ca.whop_wuid || '').trim(),
    url: String(ca.whop_page_url || visit?.landing_page || '').trim(),
    ip: visit?.ip || '',
    ua: visit?.user_agent || '',
    utm: visit ? { utm_source: visit.utm_source, utm_medium: visit.utm_medium, utm_campaign: visit.utm_campaign, utm_term: visit.utm_term, utm_content: visit.utm_content } : {},
  };
  if (a.anonymous_id && !/^wuid_/.test(a.anonymous_id)) a.anonymous_id = '';
  const id = c.id || data.contact_id;
  const prev = cachedAttr(id);
  const merged = prev ? { anonymous_id: a.anonymous_id || prev.anonymous_id, url: a.url || prev.url, ip: a.ip || prev.ip, ua: a.ua || prev.ua, utm: Object.keys(a.utm).some(k => a.utm[k]) ? a.utm : prev.utm } : a;
  if (merged.anonymous_id || merged.url) cacheAttr(id, merged);
  return merged;
}
function applyAttribution(whop, a) {
  if (!a) return whop;
  if (a.anonymous_id) whop.user.anonymous_id = a.anonymous_id;
  if (a.url) whop.url = a.url;
  const ctx = {};
  if (a.ip) ctx.ip_address = a.ip;
  if (a.ua) ctx.user_agent = a.ua;
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) if (a.utm?.[k]) ctx[k] = a.utm[k];
  const fbclid = qs(a.url, 'fbclid'); if (fbclid) ctx.fbclid = fbclid;
  if (Object.keys(ctx).length) whop.context = ctx;
  return whop;
}

// Turn a CF webhook body into a list of Whop event bodies
function buildEvents(licensee, body) {
  const data = body.data || {};
  const orderId = data.order_id || (data.subject_type === 'Order' ? data.id : null) || data.order?.id || data.id;
  const items = (data.line_items || []).map(normaliseItem);
  const contact = extractContact(data);
  const attr = extractAttribution(data);
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
      meta: { order_id: orderId, product: it.name, cf_event: body.event_type, attributed: !!(attr.anonymous_id || attr.url) },
    });
    applyAttribution(out[out.length - 1].whop, attr);
  }
  return out;
}

function buildLeadEvent(licensee, body) {
  const data = body.data || {};
  const contact = extractContact(data);
  if (!contact.email) return null;
  const cid = data.id || body.subject_id || contact.external_id || slugify(contact.email);
  const attr = extractAttribution({ ...data, contact_id: cid });
  const key = `lead-${cid}`;
  const ev = {
    dedupe_key: `${licensee.account_id}:${key}`,
    whop: {
      account_id: licensee.account_id,
      event_name: licensee.lead_event || 'lead',
      event_id: `cf-${key}`,
      action_source: 'website',
      user: { email: contact.email, first_name: contact.first_name, last_name: contact.last_name, phone: contact.phone, external_id: contact.external_id },
    },
    meta: { contact_id: cid, cf_event: body.event_type, attributed: !!(attr.anonymous_id || attr.url) },
  };
  applyAttribution(ev.whop, attr);
  return ev;
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

const rawRecent = [];
app.post('/cf/:slug', async (req, res) => {
  const licensee = LICENSEES[req.params.slug];
  if (!licensee) return res.status(404).json({ error: 'unknown licensee' });
  const body = req.body || {};
  const eventType = body.event_type || '';
  rawRecent.unshift({ ts: new Date().toISOString(), slug: req.params.slug, event_type: eventType, data: body.data }); if (rawRecent.length > 30) rawRecent.pop();

  if (LEAD_EVENTS.has(eventType)) {
    const ev = buildLeadEvent(licensee, body);
    if (!ev) { logEvent({ slug: req.params.slug, cf_event: eventType, action: 'no_email' }); return res.status(200).json({ ok: true, ignored: 'no_email' }); }
    if (alreadySent(ev.dedupe_key)) { logEvent({ slug: req.params.slug, cf_event: eventType, action: 'dedupe_skip', contact_id: ev.meta.contact_id }); return res.status(200).json({ ok: true, events: [{ ...ev.meta, event: ev.whop.event_name, action: 'dedupe_skip' }] }); }
    try {
      const r = await postToWhop(licensee.api_key, ev.whop);
      const ok = r.status >= 200 && r.status < 300;
      if (ok) markSent(ev.dedupe_key);
      const out = { ...ev.meta, event: ev.whop.event_name, email: ev.whop.user.email, whop_status: r.status, whop_resp: r.text.slice(0, 300), body: DRY_RUN ? ev.whop : undefined };
      logEvent({ slug: req.params.slug, cf_event: eventType, contact_id: ev.meta.contact_id, sent: [out] });
      return res.status(r.status >= 500 ? 500 : 200).json({ ok: r.status < 500, events: [out] });
    } catch (e) {
      logEvent({ slug: req.params.slug, cf_event: eventType, error: String(e.message || e) });
      return res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  }

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
// ---------- unsubscribe (nurture emails) ----------
// GET /unsub?e=<email> -> forwards to a Zapier catch hook (env UNSUB_HOOK_URL) which adds the email to the
// "FFC Buyer Log Table"; the nurture zap's existing Find+Filter then stops every further email. Shows a plain page.
const UNSUB_HOOK_URL = process.env.UNSUB_HOOK_URL || '';
const unsubRecent = [];
app.get('/unsub', async (req, res) => {
  const email = String(req.query.e || req.query.email || '').trim().toLowerCase();
  const ok = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  let forwarded = false;
  if (ok && UNSUB_HOOK_URL) {
    try { const r = await fetch(UNSUB_HOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, source: 'nurture-unsub', ts: new Date().toISOString() }) }); forwarded = r.ok; } catch {}
  }
  unsubRecent.unshift({ ts: new Date().toISOString(), email: ok ? email : null, forwarded }); if (unsubRecent.length > 200) unsubRecent.pop();
  console.log(JSON.stringify({ unsub: email, forwarded }));
  res.set('Content-Type', 'text/html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed</title></head>
<body style="margin:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"><div style="max-width:520px;margin:60px auto;background:#fff;border-radius:10px;padding:36px 32px;color:#1f2937;">
<h2 style="margin:0 0 12px;">${ok ? "You're unsubscribed" : 'Something went wrong'}</h2>
<p style="line-height:1.6;margin:0;">${ok ? `<strong>${email.replace(/[<>&]/g,'')}</strong> won't get any more emails from this sequence.` : 'That unsubscribe link is missing an email address. Reply to the email with STOP and we will remove you.'}</p>
</div></body></html>`);
});
app.get('/admin/unsubs', (req, res) => {
  if (!ADMIN_TOKEN || req.query.token !== ADMIN_TOKEN) return res.status(403).end();
  res.json(unsubRecent);
});

app.get('/admin/raw', (req, res) => {
  if (!ADMIN_TOKEN || req.query.token !== ADMIN_TOKEN) return res.status(403).end();
  res.json(rawRecent);
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
