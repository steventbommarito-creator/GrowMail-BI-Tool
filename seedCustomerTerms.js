require('dotenv').config();
const xlsx = require('xlsx');
const supabase = require('./lib/supabase');

async function seedCustomerTerms() {
  const filePath = '/Users/stevenbommarito/Documents/Terms customers/consolidated_customer_terms.xlsx';
  console.log('Reading Excel file...');
  const workbook = xlsx.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const records = xlsx.utils.sheet_to_json(sheet, { defval: null });
  console.log(`Read ${records.length} rows`);

  // Deduplicate by customer_id — keep the record with the most recent "Updated" date
  const map = new Map();
  for (const r of records) {
    const id = r['customer_id'] || r['Customer ID'];
    const label = r['term_label'] || r['Term Label'];
    if (!id || !label) continue;

    const idStr = String(id).trim();
    const labelStr = String(label).trim();
    if (!idStr || idStr === 'null') continue;

    const existing = map.get(idStr);
    if (!existing) {
      map.set(idStr, { customer_id: idStr, term_label: labelStr, _updated: r['Updated'] });
    } else {
      // Keep record with later Updated date
      const newDate = r['Updated'] ? new Date(r['Updated']) : new Date(0);
      const existDate = existing._updated ? new Date(existing._updated) : new Date(0);
      if (newDate > existDate) {
        map.set(idStr, { customer_id: idStr, term_label: labelStr, _updated: r['Updated'] });
      }
    }
  }

  const rows = [...map.values()].map(r => ({
    customer_id: r.customer_id,
    term_label: r.term_label,
  }));
  console.log(`Deduped to ${rows.length} unique customers`);

  // Preview term distribution
  const dist = {};
  for (const r of rows) {
    dist[r.term_label] = (dist[r.term_label] || 0) + 1;
  }
  console.log('Term distribution:', dist);

  // Upsert in batches of 500
  const BATCH = 500;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await supabase
      .from('customer_terms')
      .upsert(batch, { onConflict: 'customer_id' });
    if (error) {
      console.error(`Batch ${i} error:`, error.message);
      process.exit(1);
    }
    upserted += batch.length;
    console.log(`  Upserted ${upserted}/${rows.length}`);
  }

  console.log('Done!');
}

seedCustomerTerms().catch(err => { console.error(err); process.exit(1); });
