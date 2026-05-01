'use client';

// Tiny helpers that turn an Order ID or Mail Drop ID into a hyperlink that
// opens the corresponding Osprey screen in a new tab. Used wherever IDs are
// displayed in the dashboard.
//
// stopPropagation on click is important because some of these IDs render
// inside <tr onClick> rows (the cashflow accordion) — without it, clicking
// the link would also toggle the row expansion.

const ORDER_BASE = 'https://osprey.onebrand.io/orders/';
const DROP_BASE  = 'https://osprey.onebrand.io/mail-orders/';

// Subtle dotted underline so the IDs read as links without overwhelming the
// surrounding text. Inherits color so each table cell's existing color
// styling is preserved.
const linkStyle = {
  color: 'inherit',
  textDecoration: 'underline',
  textDecorationStyle: 'dotted',
  textDecorationColor: 'currentColor',
  textUnderlineOffset: '2px',
  cursor: 'pointer',
};

export function OspreyOrderLink({ id, className, style }) {
  if (!id) return <span className={className}>—</span>;
  return (
    <a href={`${ORDER_BASE}${id}`}
       target="_blank"
       rel="noopener noreferrer"
       onClick={(e) => e.stopPropagation()}
       title="Open in Osprey"
       className={className}
       style={{ ...linkStyle, ...style }}>
      {id}
    </a>
  );
}

export function OspreyDropLink({ id, className, style }) {
  if (!id) return <span className={className}>—</span>;
  return (
    <a href={`${DROP_BASE}${id}`}
       target="_blank"
       rel="noopener noreferrer"
       onClick={(e) => e.stopPropagation()}
       title="Open in Osprey"
       className={className}
       style={{ ...linkStyle, ...style }}>
      {id}
    </a>
  );
}
