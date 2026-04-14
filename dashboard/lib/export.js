// Export utilities — CSV and PDF

export function exportToCSV(data, filename) {
  if (!data || data.length === 0) return;
  const headers = Object.keys(data[0]);
  const escape = (v) => {
    const s = v == null ? '' : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [
    headers.map(escape).join(','),
    ...data.map(row => headers.map(k => escape(row[k])).join(',')),
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportToPDF(columns, rows, filename, title) {
  import('jspdf').then(({ default: jsPDF }) => {
    import('jspdf-autotable').then(() => {
      const doc = new jsPDF({ orientation: 'landscape' });
      doc.setFontSize(14);
      doc.text(title || filename, 14, 15);
      doc.setFontSize(9);
      doc.text(`Generated: ${new Date().toLocaleString('en-US', { timeZone: 'America/Detroit' })} ET`, 14, 22);
      doc.autoTable({
        head: [columns.map(c => c.label)],
        body: rows.map(r => columns.map(c => r[c.key] ?? '')),
        startY: 28,
        styles: { fontSize: 8 },
        headStyles: { fillColor: [45, 125, 70] },
      });
      doc.save(`${filename}.pdf`);
    });
  });
}
