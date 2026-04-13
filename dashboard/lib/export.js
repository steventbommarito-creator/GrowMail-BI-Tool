// Export utilities — Excel and PDF

export function exportToExcel(data, filename, sheetName = 'Sheet1') {
  import('xlsx').then(XLSX => {
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    XLSX.writeFile(wb, `${filename}.xlsx`);
  });
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
