// Local test: fake CF invoice.paid + order.completed payloads through the bridge in DRY_RUN
process.env.DRY_RUN = '1';
process.env.LICENSEES = JSON.stringify(require('../licensees.example.json'));
const { app } = require('../server');
const http = require('http');
const srv = http.createServer(app).listen(0);
const port = srv.address().port;
const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, json: await r.json() }));

const contact = { id: 555, email_address: 'jane@example.com', first_name: 'Jane', last_name: 'Doe', phone_number: '+15550001' };
const li = (id, name, amount, qty = 1) => ({ id, quantity: qty, original_product: { id: id * 10, name }, products_price: { amount: String(amount), currency: 'usd' }, products_variant: { id: id * 100, name } });

(async () => {
  let fails = 0;
  const check = (label, cond) => { console.log(cond ? '✅' : '❌', label); if (!cond) fails++; };

  // 1. main checkout invoice: main + 2 bumps
  let r = await post('/cf/michael', { event_type: 'one-time-order.invoice.paid', data: { id: 9001, order_id: 777, status: 'paid', contact, line_items: [li(1, 'Faceless Funnel Challenge (10 Day Challenge)', 6.95), li(2, '22 Niches Pack', 14.95), li(3, 'Viral Reel Pack', 21.95)] } });
  check('invoice.paid -> 200', r.status === 200);
  check('3 whop events built', r.json.events.length === 3);
  check('main -> purchase 6.95', r.json.events[0].event === 'purchase' && r.json.events[0].value === 6.95);
  check('bump names mapped', r.json.events[1].event === 'bump_22_niches' && r.json.events[2].event === 'bump_viral_reels');
  check('event_id shape', r.json.events[0].body.event_id === 'cf-777-100');
  check('currency lowercase', r.json.events[0].body.currency === 'usd');

  // 2. CF retries same invoice -> all deduped
  r = await post('/cf/michael', { event_type: 'one-time-order.invoice.paid', data: { id: 9001, order_id: 777, status: 'paid', contact, line_items: [li(1, 'Faceless Funnel Challenge', 6.95), li(2, '22 Niches Pack', 14.95), li(3, 'Viral Reel Pack', 21.95)] } });
  check('retry deduped', r.json.events.every(e => e.action === 'dedupe_skip'));

  // 3. OTO as a new invoice on same order
  r = await post('/cf/michael', { event_type: 'one-time-order.invoice.paid', data: { id: 9002, order_id: 777, status: 'paid', contact, line_items: [li(4, 'DFY Funnel Build', 97)] } });
  check('OTO -> oto_dfy_funnel 97', r.json.events[0].event === 'oto_dfy_funnel' && r.json.events[0].value === 97);

  // 4. order.completed fires too with all line items -> nothing double-sent
  r = await post('/cf/michael', { event_type: 'order.completed', data: { id: 777, subject_type: 'Order', billing_status: 'paid', contact, line_items: [li(1, 'Faceless Funnel Challenge', 6.95), li(2, '22 Niches Pack', 14.95), li(3, 'Viral Reel Pack', 21.95), li(4, 'DFY Funnel Build', 97)] } });
  check('order.completed fully deduped', r.json.events.every(e => e.action === 'dedupe_skip'));

  // 4b. opt-in: contact.created -> one `lead` event, deduped on retry / contact.identified
  r = await post('/cf/michael', { event_type: 'contact.created', subject_id: 4242, data: { id: 4242, email_address: 'lead@example.com', first_name: 'Lee', last_name: 'Ad', phone_number: '' } });
  check('contact.created -> lead', r.status === 200 && r.json.events[0].event === 'lead' && r.json.events[0].email === 'lead@example.com');
  check('lead has no value + event_id', r.json.events[0].body.value === undefined && r.json.events[0].body.event_id === 'cf-lead-4242');
  r = await post('/cf/michael', { event_type: 'contact.identified', subject_id: 4242, data: { id: 4242, email_address: 'lead@example.com' } });
  check('contact.identified deduped', r.json.events[0].action === 'dedupe_skip');
  r = await post('/cf/michael', { event_type: 'contact.created', data: { id: 4243 } });
  check('contact without email ignored', r.json.ignored === 'no_email');

  // 4c. attribution: contact.created with visits + hidden whop_visitor_id -> lead carries anonymous_id/url/context;
  //     a later order for the same contact (no visits in payload) reuses the cached attribution
  const visits = { first_visit: { landing_page: 'https://go.example.com/free-case-study?utm_source=ig&wacid=adcamp_1&wasid=adgrp_1&waid=ad_1&fbclid=IwAR0x', ip: '203.0.113.9', user_agent: 'UA/1.0', utm_source: 'ig', utm_medium: 'paid_social', utm_campaign: null, utm_term: null, utm_content: 'reel A' }, last_visit: null, last_visit_with_utm: null };
  r = await post('/cf/michael', { event_type: 'contact.created', subject_id: 5151, data: { id: 5151, email_address: 'attr@example.com', first_name: 'At', last_name: 'Tr', custom_attributes: { whop_visitor_id: 'wuid_abc123' }, visits } });
  let b = r.json.events[0].body;
  check('lead carries anonymous_id', b.user.anonymous_id === 'wuid_abc123');
  check('lead carries landing url', b.url === visits.first_visit.landing_page);
  check('lead context ip/ua/utm/fbclid', b.context.ip_address === '203.0.113.9' && b.context.user_agent === 'UA/1.0' && b.context.utm_source === 'ig' && b.context.fbclid === 'IwAR0x' && b.context.utm_campaign === undefined);
  r = await post('/cf/michael', { event_type: 'one-time-order.invoice.paid', data: { id: 9010, order_id: 790, status: 'paid', contact: { id: 5151, email_address: 'attr@example.com', first_name: 'At' }, line_items: [li(1, 'Faceless Funnel Challenge', 6.95)] } });
  b = r.json.events[0].body;
  check('purchase reuses cached anonymous_id + url', b.user.anonymous_id === 'wuid_abc123' && b.url === visits.first_visit.landing_page && r.json.events[0].attributed === true);
  r = await post('/cf/michael', { event_type: 'one-time-order.invoice.paid', data: { id: 9011, order_id: 791, status: 'paid', contact: { id: 5252, email_address: 'noattr@example.com' }, line_items: [li(1, 'Faceless Funnel Challenge', 6.95)] } });
  b = r.json.events[0].body;
  check('no attribution -> no url/anonymous_id/context keys', b.url === undefined && b.user.anonymous_id === undefined && b.context === undefined && r.json.events[0].attributed === false);
  r = await post('/cf/michael', { event_type: 'contact.created', subject_id: 5353, data: { id: 5353, email_address: 'bad@example.com', custom_attributes: { whop_visitor_id: 'not-a-wuid' } } });
  check('junk visitor id dropped', r.json.events[0].body.user.anonymous_id === undefined);

  // 5. unknown product -> slug event, real amount
  r = await post('/cf/michael', { event_type: 'one-time-order.invoice.paid', data: { id: 9003, order_id: 778, status: 'paid', contact, line_items: [li(9, 'Mystery Box', 12.5)] } });
  check('unknown product -> mystery_box 12.5', r.json.events[0].event === 'mystery_box' && r.json.events[0].value === 12.5);

  // 6. ignored events
  r = await post('/cf/michael', { event_type: 'contact.created', data: { id: 1 } });
  check('contact.created without email ignored', r.json.ignored === 'no_email');
  r = await post('/cf/michael', { event_type: 'one-time-order.invoice.paid', data: { id: 9004, order_id: 779, status: 'unpaid', contact, line_items: [li(1, 'Faceless Funnel Challenge', 6.95)] } });
  check('unpaid invoice ignored', r.json.ignored_status === 'unpaid');
  r = await post('/cf/nobody', { event_type: 'order.completed', data: {} });
  check('unknown licensee 404', r.status === 404);

  srv.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})();
