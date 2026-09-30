// Custom quote spec fields — one definition shared by the public intake form,
// the quote workspace, the confirmation email and the PDFs. Specs are stored
// on quote_requests.specs as { [field.id]: value }.

export const PRODUCT_TYPES = [
  { id: 'postcard',    label: 'Postcard' },
  { id: 'letter',      label: 'Letter Package' },
  { id: 'self_mailer', label: 'Self-Mailer' },
  { id: 'brochure',    label: 'Brochure / Flyer' },
  { id: 'booklet',     label: 'Catalog / Booklet' },
  { id: 'other',       label: 'Other' },
];

const ALL = PRODUCT_TYPES.map(p => p.id);

// type: text | select | number | checkbox | textarea
// types: which product types show the field
export const SPEC_SECTIONS = [
  {
    title: 'Piece',
    fields: [
      { id: 'finished_size', label: 'Finished size', type: 'text', placeholder: 'e.g. 6 x 9', required: true, types: ALL },
      { id: 'flat_size',     label: 'Flat size', type: 'text', placeholder: 'e.g. 11 x 17', types: ['self_mailer', 'brochure', 'booklet', 'other'] },
      { id: 'folds',         label: 'Folds', type: 'select', options: ['None', 'Half', 'Tri-fold', 'Z-fold', 'Gate', 'Other'], types: ['self_mailer', 'brochure', 'other'] },
      { id: 'page_count',    label: 'Page count', type: 'number', types: ['booklet'] },
      { id: 'binding',       label: 'Binding', type: 'select', options: ['Saddle stitch', 'Perfect bound', 'Other'], types: ['booklet'] },
      { id: 'paper_stock',   label: 'Paper stock', type: 'text', placeholder: 'e.g. 14pt C2S gloss cover, 70# uncoated text', required: true, types: ALL },
      { id: 'ink',           label: 'Ink', type: 'select', options: ['4/4', '4/0', '4/1', '1/1', '1/0', 'Other'], required: true, types: ALL },
      { id: 'bleed',         label: 'Bleeds', type: 'checkbox', types: ALL },
      { id: 'coating',       label: 'Coating', type: 'select', options: ['None', 'Aqueous', 'UV', 'Matte', 'Other'], types: ALL },
      { id: 'finishing',     label: 'Other finishing', type: 'text', placeholder: 'Die-cut, perf, scoring, tabs…', types: ALL },
    ],
  },
  {
    title: 'Letter package',
    fields: [
      { id: 'envelope_size',    label: 'Envelope', type: 'select', options: ['#10', '6 x 9', '9 x 12', 'A-size', 'Other'], types: ['letter'] },
      { id: 'envelope_window',  label: 'Window', type: 'select', options: ['None', 'Single', 'Double'], types: ['letter'] },
      { id: 'envelope_printing', label: 'Envelope printing', type: 'text', placeholder: 'e.g. 1/0 return address', types: ['letter'] },
      { id: 'insert_count',     label: 'Number of inserts', type: 'number', types: ['letter'] },
      { id: 'reply_device',     label: 'BRE / reply device', type: 'checkbox', types: ['letter'] },
    ],
  },
  {
    title: 'Mailing',
    fields: [
      { id: 'mail_class',     label: 'Mail class', type: 'select', required: true, types: ALL,
        options: ['First-Class', 'Marketing Mail', 'Nonprofit Marketing Mail', 'EDDM', 'Print only — no mailing'] },
      { id: 'postage_type',   label: 'Postage type', type: 'select', types: ALL,
        options: ['Permit indicia', 'Meter', 'Live stamp', 'Not sure'] },
      { id: 'personalization', label: 'Personalization', type: 'select', types: ALL,
        options: ['Static', 'Variable data', 'Not sure'] },
      { id: 'versions',       label: 'Number of versions', type: 'number', types: ALL },
      { id: 'list_source',    label: 'Mailing list', type: 'select', types: ALL,
        options: ['Customer provides', 'We need to source', 'N/A'] },
    ],
  },
];

export function productLabel(id) {
  return PRODUCT_TYPES.find(p => p.id === id)?.label || id;
}

export function fieldsFor(productType) {
  return SPEC_SECTIONS
    .map(s => ({ ...s, fields: s.fields.filter(f => f.types.includes(productType)) }))
    .filter(s => s.fields.length);
}

// Human-readable [label, value] pairs for a stored specs object, in form order.
export function specRows(productType, specs = {}) {
  const rows = [];
  for (const s of fieldsFor(productType)) {
    for (const f of s.fields) {
      const v = specs[f.id];
      if (v === undefined || v === null || v === '' || v === false) continue;
      rows.push([f.label, v === true ? 'Yes' : String(v)]);
    }
  }
  return rows;
}
