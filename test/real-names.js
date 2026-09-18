// Michael's real CF product names -> expected Whop events (guards the match rules)
process.env.LICENSEES = JSON.stringify(require('../licensees.example.json'));
const { buildEvents, loadLicensees } = require('../server');
const L = loadLicensees().michael;
const cases = [['FF Challenge',6.95,'purchase'],['22 Money Niches',14.95,'bump_22_niches'],['Viral Reel Pack',21.95,'bump_viral_reels'],['Upgrade V.I.P.',97,'oto_dfy_funnel'],['DFY Digital Product Pack v2',47,'oto_dfy_products'],['VIP Deal',47,'downsell']];
let fails=0;
for (const [name,amt,expect] of cases) {
  const ev = buildEvents(L, { event_type:'one-time-order.invoice.paid', data:{ order_id:1, contact:{id:1,email_address:'a@b.c'}, line_items:[{id:1,quantity:1,original_product:{id:1,name},products_price:{amount:String(amt),currency:'usd'},products_variant:{id:1,name}}] } })[0];
  const ok = ev && ev.whop.event_name===expect && ev.whop.value===amt;
  console.log(ok?'✅':'❌', name, '->', ev?.whop.event_name, ev?.whop.value); if(!ok) fails++;
}
process.exit(fails?1:0);
