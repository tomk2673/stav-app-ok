'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {harness}=require('./helpers/invoice-review.cjs');
const {setup,clientFor,ids}=require('./helpers/invoice-postgres.cjs');

async function review(options){
  const {db}=await setup(options),client=clientFor(db);
  let h;
  try{h=await harness({client,context:{organization:{id:ids.org},venue:{id:ids.venue},user:{id:ids.user},role:'manager'}});}
  catch(error){await db.close();throw error;}
  return {...h,db,client,async close(){h.dom.window.close();await db.close();}};
}

test('UI discounted approval uses real PostgreSQL: VAT, effective cost, stock, audit, duplicate clicks and posted immutability',async()=>{
  const h=await review();
  try{
    await Promise.all([h.post(),h.post()]);
    const l=(await h.db.query('select * from invoice_lines')).rows[0];
    assert.equal(Number(l.unit_price_net),100);assert.equal(Number(l.unit_price_gross),121);
    assert.equal(Number(l.line_total_net),900);assert.equal(Number(l.line_total_gross),1089);
    assert.equal(l.original_values.ocr_unit_gross,121);assert.equal(l.original_values.ocr_line_gross,1089);
    const p=(await h.db.query('select * from products')).rows[0];
    assert.equal(Number(p.current_purchase_price),90);assert.equal(Number(p.current_purchase_price_gross),108.9);
    const price=(await h.db.query('select * from purchase_price_history')).rows[0];
    assert.equal(Number(price.unit_price_net),90);assert.equal(Number(price.unit_price_gross),108.9);
    const stock=(await h.db.query('select * from stock_movements')).rows;
    assert.equal(stock.length,1);assert.equal(stock[0].movement_type,'receipt');assert.equal(Number(stock[0].quantity_ml),7000);
    const audits=(await h.db.query("select * from audit_events where event_type='invoice.posted'")).rows;
    assert.equal(audits.length,1);assert.equal(audits[0].after_data.total_net,900);assert.equal(audits[0].after_data.vat_total,189);
    assert.equal(audits[0].after_data.lines[0].adjustment_gross,-121);
    assert.equal((await h.db.query('select status from invoices')).rows[0].status,'posted');
    await assert.rejects(h.db.query('update invoices set total_amount_gross=1 where id=$1',[ids.invoice]),/immutable/);
    await assert.rejects(h.db.query('delete from stock_movements'),/permission denied/);
    await assert.rejects(h.db.query('insert into purchase_price_history(organization_id,product_id,invoice_line_id,unit_price) values ($1,$2,$3,1)',
      [ids.org,ids.product,l.id]),/unique constraint/);
    await h.db.query(`insert into audit_events(organization_id,venue_id,actor_user_id,event_type,entity_type,entity_id)
      values ($1,$2,$3,'invoice.posted','invoice',$4)`,[ids.org,ids.venue,ids.user,ids.invoice]);
    assert.equal((await h.db.query('select count(*)::int as n from stock_movements')).rows[0].n,1,'audit replay cannot stock twice');
  }finally{await h.close();}
});

test('fractional receipt, mixed VAT, ignored rounding and signed liquid return reach the ledger with conserved totals',async()=>{
  const h=await review({total:188.02,lines:[
    {quantity:1.5,unit_price_net:100,unit_price_gross:121,vat_rate:21,line_total_net:150,line_total_gross:181.5},
    {quantity:2,unit_price_net:100,unit_price_gross:112,vat_rate:12,line_total_net:150,line_total_gross:168},
    {quantity:-2,unit_price_net:100,unit_price_gross:121,vat_rate:21,line_total_net:-133.47,line_total_gross:-161.5},
    {raw_name:'Zaokrouhlení',quantity:null,unit_price_gross:null,vat_rate:0,line_total_net:0.02,line_total_gross:0.02,status:'ignored'}
  ]});
  try{
    assert.equal(h.w.PubGuruInvoiceReview.check().issues.length,0);await h.post();
    const stock=(await h.db.query('select movement_type,quantity_ml from stock_movements order by quantity_ml desc')).rows;
    assert.deepEqual(stock.map(x=>[x.movement_type,Number(x.quantity_ml)]),[['receipt',1400],['receipt',1050],['return',-1400]]);
    const audit=(await h.db.query("select after_data from audit_events where event_type='invoice.posted'")).rows[0].after_data;
    assert.equal(audit.total_gross,188.02);assert.equal(audit.total_net,166.55);assert.equal(audit.vat_total,21.47);
    assert.equal((await h.db.query('select count(*)::int as n from purchase_price_history')).rows[0].n,2,'return and rounding do not learn prices');
  }finally{await h.close();}
});

test('credit note alone posts a negative liquid return and does not replace purchase cost',async()=>{
  const h=await review({total:-108.9,lines:[{quantity:-1,unit_price_net:100,unit_price_gross:121,vat_rate:21,line_total_net:-90,line_total_gross:-108.9}]});
  try{
    h.w.document.querySelector('.vol').value='350';
    await h.post();const stock=(await h.db.query('select * from stock_movements')).rows[0];
    assert.equal(stock.movement_type,'return');assert.equal(Number(stock.quantity_ml),-350,'confirmed package size reaches the server even on returns');
    assert.equal((await h.db.query('select status from invoices')).rows[0].status,'posted');
    assert.equal(Number((await h.db.query('select current_purchase_price_gross from products')).rows[0].current_purchase_price_gross),121);
    assert.equal((await h.db.query('select count(*)::int as n from purchase_price_history')).rows[0].n,0);
  }finally{await h.close();}
});

test('counted receipt and return keep unit quantities and record missing stock instead of inventing a balance',async()=>{
  const h=await review({counted:true,total:0,lines:[
    {quantity:1,unit_price_net:100,unit_price_gross:100,vat_rate:0,line_total_net:100,line_total_gross:100},
    {quantity:-2,unit_price_net:50,unit_price_gross:50,vat_rate:0,line_total_net:-100,line_total_gross:-100}
  ]});
  try{
    await h.post();const stock=(await h.db.query('select * from stock_movements order by movement_type')).rows;
    assert.deepEqual(stock.map(x=>[x.movement_type,Number(x.quantity_ml),Number(x.quantity_units),Number(x.untracked_units)]),
      [['receipt',0,1,0],['return',0,-1,1]]);
    assert.equal(Number(stock[1].requested_quantity_units),-2);
  }finally{await h.close();}
});

test('invalid VAT, unbalanced money and missing volume leave the actual database untouched',async()=>{
  const h=await review();
  try{
    const fields=[['.vat',''],['#totalGross','1'],['.vol','0']];
    for(const [selector,value] of fields){const field=h.w.document.querySelector(selector),saved=field.value;field.value=value;await h.post();field.value=saved;}
    assert.equal(h.client.writes.length,0);
    assert.equal((await h.db.query('select count(*)::int as n from stock_movements')).rows[0].n,0);
    assert.equal((await h.db.query('select count(*)::int as n from purchase_price_history')).rows[0].n,0);
    assert.equal((await h.db.query('select count(*)::int as n from audit_events')).rows[0].n,0);
    assert.equal((await h.db.query('select status from invoices')).rows[0].status,'review');
  }finally{await h.close();}
});

test('source fingerprint duplication and unauthorized posting are rejected by real database constraints and RLS',async()=>{
  const {db}=await setup();
  try{
    await assert.rejects(db.query(`insert into invoices(organization_id,venue_id,source_fingerprint,created_by) values ($1,$2,'source-once',$3)`,[ids.org,ids.venue,ids.user]),/unique constraint/);
    await assert.rejects(db.query(`insert into invoices(organization_id,venue_id,source_fingerprint,created_by) values ($1,$2,'new-source',$3)`,[ids.otherOrg,ids.venue,ids.user]),/row-level security/);
    await db.exec(`reset role;update memberships set role='staff';set role authenticated;`);
    await assert.rejects(db.query(`insert into audit_events(organization_id,venue_id,actor_user_id,event_type,entity_type,entity_id) values ($1,$2,$3,'invoice.posted','invoice',$4)`,[ids.org,ids.venue,ids.user,ids.invoice]),/requires owner or manager/);
    assert.equal((await db.query('select count(*)::int as n from audit_events')).rows[0].n,0);
    assert.equal((await db.query('select count(*)::int as n from stock_movements')).rows[0].n,0);
  }finally{await db.close();}
});

test('a failed audit/stock transaction rolls back the signed movements and leaves the invoice staged for retry',async()=>{
  const {db}=await setup({lines:[{quantity:1,unit_price_net:100,unit_price_gross:121,vat_rate:21,line_total_net:100,line_total_gross:121},
    {quantity:-1,unit_price_net:100,unit_price_gross:121,vat_rate:21,line_total_net:-100,line_total_gross:-121}],total:0});
  try{
    await db.exec(`update invoice_lines set status='approved';update invoices set status='approved';reset role;
      create function public.test_reject_return() returns trigger language plpgsql as $$begin
        if new.movement_type='return' then raise exception 'Test return rejected';end if;return new;end;$$;
      create trigger trg_test_reject_return before insert on stock_movements for each row execute function public.test_reject_return();
      set role authenticated;`);
    await assert.rejects(db.query(`insert into audit_events(organization_id,venue_id,actor_user_id,event_type,entity_type,entity_id)
      values ($1,$2,$3,'invoice.posted','invoice',$4)`,[ids.org,ids.venue,ids.user,ids.invoice]),/Test return rejected/);
    assert.equal((await db.query('select count(*)::int as n from stock_movements')).rows[0].n,0,'earlier receipt is rolled back too');
    assert.equal((await db.query('select count(*)::int as n from audit_events')).rows[0].n,0);
    assert.equal((await db.query('select status from invoices')).rows[0].status,'approved');
    await db.exec('reset role;drop trigger trg_test_reject_return on stock_movements;set role authenticated;');
    await db.query(`insert into audit_events(organization_id,venue_id,actor_user_id,event_type,entity_type,entity_id)
      values ($1,$2,$3,'invoice.posted','invoice',$4)`,[ids.org,ids.venue,ids.user,ids.invoice]);
    assert.equal((await db.query('select count(*)::int as n from stock_movements')).rows[0].n,2);
    assert.equal((await db.query('select status from invoices')).rows[0].status,'posted');
  }finally{await db.close();}
});
