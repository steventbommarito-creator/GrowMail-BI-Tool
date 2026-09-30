'use client';

// Custom quote request form, shared by the public /intake page (no login, see
// proxy.js) and the internal /quotes/new page. Files go straight to the
// quote-files bucket under intake/, then the form posts to /api/quotes/intake
// which creates the request and (unless turned off internally) emails the rep.

import { useState } from 'react';
import Link from 'next/link';
import { createClient } from '../lib/supabase';
import { PRODUCT_TYPES, fieldsFor } from '../lib/quoteSpecs';

const MAX_FILE_BYTES = 25 * 1024 * 1024;

const inputCls = 'w-full rounded-lg border px-3 py-2 text-sm outline-none';
const inputStyle = { background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text-primary)' };

function Label({ children, required }) {
  return (
    <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
      {children}{required && <span style={{ color: 'var(--status-critical)' }}> *</span>}
    </label>
  );
}

function Section({ title, children }) {
  return (
    <section className="rounded-xl border p-5 space-y-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
      <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h2>
      {children}
    </section>
  );
}

function SpecField({ field, value, onChange }) {
  if (field.type === 'checkbox') {
    return (
      <label className="flex items-center gap-2 text-sm pt-6" style={{ color: 'var(--text-primary)' }}>
        <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} />
        {field.label}
      </label>
    );
  }
  return (
    <div>
      <Label required={field.required}>{field.label}</Label>
      {field.type === 'select' ? (
        <select className={inputCls} style={inputStyle} value={value || ''} required={field.required}
          onChange={e => onChange(e.target.value)}>
          <option value="">Select…</option>
          {field.options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input className={inputCls} style={inputStyle} type={field.type === 'number' ? 'number' : 'text'}
          min={field.type === 'number' ? 0 : undefined} placeholder={field.placeholder}
          required={field.required} value={value || ''} onChange={e => onChange(e.target.value)} />
      )}
    </div>
  );
}

export default function QuoteRequestForm({ internal = false }) {
  const [form, setForm] = useState({
    rep_name: '', rep_user: '', customer_name: '', product_type: '',
    qty1: '', qty2: '', artwork_ready_date: '', in_home_date: '', notes: '', website: '',
  });
  const [specs, setSpecs] = useState({});
  const [files, setFiles] = useState([]);
  const [notifyRep, setNotifyRep] = useState(!internal);
  const [status, setStatus] = useState('idle');   // idle | submitting | done
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  function addFiles(list) {
    const next = [...files];
    for (const f of list) {
      if (f.size > MAX_FILE_BYTES) { setError(`${f.name} is over 25 MB — send it separately after submitting.`); continue; }
      if (!next.some(x => x.name === f.name && x.size === f.size)) next.push(f);
    }
    setFiles(next);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!form.product_type) { setError('Choose a product type.'); return; }
    setStatus('submitting');

    try {
      // Upload files first; the RPC only records paths under intake/.
      const supabase = createClient();
      const batch = crypto.randomUUID();
      const uploaded = [];
      for (const f of files) {
        const safe = f.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-120);
        const path = `intake/${batch}/${safe}`;
        const { error: upErr } = await supabase.storage.from('quote-files').upload(path, f, { upsert: false });
        if (upErr) throw new Error(`Upload failed for ${f.name}: ${upErr.message}`);
        uploaded.push({ path, name: f.name, size: f.size });
      }

      const res = await fetch('/api/quotes/intake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rep_name: form.rep_name.trim(),
          rep_email: `${form.rep_user.trim().toLowerCase()}@growmail.com`,
          customer_name: form.customer_name.trim(),
          product_type: form.product_type,
          quantities: [form.qty1, form.qty2].map(q => String(q).replace(/\D/g, '')).filter(Boolean),
          specs,
          artwork_ready_date: form.artwork_ready_date,
          in_home_date: form.in_home_date,
          notes: form.notes.trim(),
          files: uploaded,
          website: form.website,
          notify: notifyRep,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Something went wrong');
      setResult({ ...body, email: `${form.rep_user.trim().toLowerCase()}@growmail.com` });
      setStatus('done');
    } catch (err) {
      setError(err.message);
      setStatus('idle');
    }
  }

  if (status === 'done') {
    return (
      <div className="max-w-xl mx-auto mt-16 rounded-xl border p-8 text-center"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{internal ? 'Quote created' : 'Request received'}</p>
        <p className="text-4xl font-bold my-3" style={{ color: 'var(--accent)' }}>{result.quote_code}</p>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          {!notifyRep
            ? <>No email was sent to the rep.</>
            : result.emailSent
              ? <>A confirmation with {internal ? 'the' : 'your'} request details was sent to <strong>{result.email}</strong>.</>
              : <>The request is saved, but the confirmation email didn&apos;t go out — keep this quote number for reference.</>}
        </p>
        <div className="mt-6 flex justify-center gap-3">
          {internal && (
            <Link href="/quotes" className="px-4 py-2 rounded-lg text-sm font-semibold border"
              style={{ borderColor: 'var(--border)', color: 'var(--text-primary)' }}>
              Back to quotes
            </Link>
          )}
          <button onClick={() => window.location.reload()} className="px-4 py-2 rounded-lg text-sm font-semibold"
            style={{ background: 'var(--accent)', color: 'var(--accent-text)' }}>
            {internal ? 'Key in another' : 'Submit another request'}
          </button>
        </div>
      </div>
    );
  }

  const sections = form.product_type ? fieldsFor(form.product_type) : [];

  return (
    <form onSubmit={handleSubmit} className="max-w-3xl mx-auto space-y-5 pb-16">
      <header className="pt-4">
        {internal && (
          <Link href="/quotes" className="text-sm" style={{ color: 'var(--text-muted)' }}>← Quotes</Link>
        )}
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
          {internal ? 'New Custom Quote' : 'Custom Quote Request'}
        </h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          {internal
            ? 'Key in a request that came in by phone or email. It gets the next quote number.'
            : <>Tell us about the job. You&apos;ll get a quote number by email right away.</>}
        </p>
      </header>

      {/* honeypot — hidden from people, bots fill it */}
      <input type="text" name="website" value={form.website} onChange={set('website')}
        tabIndex={-1} autoComplete="off" aria-hidden="true"
        style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }} />

      <Section title={internal ? 'Rep & customer' : 'You & your customer'}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <Label required>{internal ? 'Rep name' : 'Your name'}</Label>
            <input className={inputCls} style={inputStyle} required value={form.rep_name} onChange={set('rep_name')} />
          </div>
          <div>
            <Label required>{internal ? 'Rep GrowMail email' : 'Your GrowMail email'}</Label>
            <div className="flex items-center rounded-lg border overflow-hidden" style={inputStyle}>
              <input className="flex-1 min-w-0 px-3 py-2 text-sm bg-transparent outline-none" required
                style={{ color: 'var(--text-primary)' }} placeholder="yourname" value={form.rep_user}
                onChange={e => setForm(f => ({ ...f, rep_user: e.target.value.replace(/[@\s]/g, '') }))} />
              <span className="px-3 py-2 text-sm border-l whitespace-nowrap"
                style={{ color: 'var(--text-muted)', borderColor: 'var(--border)', background: 'var(--surface)' }}>
                @growmail.com
              </span>
            </div>
          </div>
          <div className="sm:col-span-2">
            <Label required>Customer / company</Label>
            <input className={inputCls} style={inputStyle} required value={form.customer_name} onChange={set('customer_name')} />
          </div>
        </div>
      </Section>

      <Section title="Product">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {PRODUCT_TYPES.map(p => {
            const on = form.product_type === p.id;
            return (
              <button type="button" key={p.id} onClick={() => setForm(f => ({ ...f, product_type: p.id }))}
                className="rounded-lg border px-3 py-2.5 text-sm font-medium text-left"
                style={{
                  background: on ? 'var(--accent-light)' : 'var(--surface2)',
                  borderColor: on ? 'var(--accent)' : 'var(--border)',
                  color: 'var(--text-primary)',
                }}>
                {p.label}
              </button>
            );
          })}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <Label required>Quantity 1</Label>
            <input className={inputCls} style={inputStyle} required inputMode="numeric" placeholder="e.g. 25,000"
              value={form.qty1} onChange={set('qty1')} />
          </div>
          <div>
            <Label>Quantity 2 (optional)</Label>
            <input className={inputCls} style={inputStyle} inputMode="numeric" placeholder="e.g. 50,000"
              value={form.qty2} onChange={set('qty2')} />
          </div>
        </div>
      </Section>

      {sections.map(s => (
        <Section key={s.title} title={s.title}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {s.fields.map(f => (
              <SpecField key={f.id} field={f} value={specs[f.id]}
                onChange={v => setSpecs(prev => ({ ...prev, [f.id]: v }))} />
            ))}
          </div>
        </Section>
      ))}

      <Section title="Timing, files & notes">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <Label>Artwork ready date</Label>
            <input type="date" className={inputCls} style={inputStyle} value={form.artwork_ready_date} onChange={set('artwork_ready_date')} />
          </div>
          <div>
            <Label>Target in-home date</Label>
            <input type="date" className={inputCls} style={inputStyle} value={form.in_home_date} onChange={set('in_home_date')} />
          </div>
        </div>
        <div>
          <Label>Artwork, samples or spec sheets</Label>
          <label className="block rounded-lg border border-dashed px-3 py-4 text-sm text-center cursor-pointer"
            style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); addFiles(e.dataTransfer.files); }}>
            Drop files here or click to choose (25 MB max each)
            <input type="file" multiple className="hidden" onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
          </label>
          {files.length > 0 && (
            <ul className="mt-2 space-y-1">
              {files.map((f, i) => (
                <li key={f.name + f.size} className="flex justify-between text-sm" style={{ color: 'var(--text-secondary)' }}>
                  <span className="truncate">{f.name}</span>
                  <button type="button" className="ml-3" style={{ color: 'var(--status-critical)' }}
                    onClick={() => setFiles(files.filter((_, j) => j !== i))}>Remove</button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <Label>Notes</Label>
          <textarea rows={4} className={inputCls} style={inputStyle} value={form.notes} onChange={set('notes')}
            placeholder="Anything else the quoting team should know" />
        </div>
      </Section>

      {internal && (
        <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
          <input type="checkbox" checked={notifyRep} onChange={e => setNotifyRep(e.target.checked)} />
          Email the rep a confirmation with the quote number
        </label>
      )}

      {error && (
        <div className="rounded-lg px-3 py-2 text-sm" style={{ background: 'var(--status-critical-bg)', color: 'var(--status-critical)' }}>
          {error}
        </div>
      )}

      <button type="submit" disabled={status === 'submitting'}
        className="w-full py-3 rounded-lg text-sm font-semibold"
        style={{
          background: status === 'submitting' ? 'var(--surface2)' : 'var(--accent)',
          color: status === 'submitting' ? 'var(--text-muted)' : 'var(--accent-text)',
          cursor: status === 'submitting' ? 'not-allowed' : 'pointer',
        }}>
        {status === 'submitting' ? 'Submitting…' : internal ? 'Create quote' : 'Submit request'}
      </button>
    </form>
  );
}
