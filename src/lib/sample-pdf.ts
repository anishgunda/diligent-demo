export function samplePdf() {
  const content = [
    'BT /F1 25 Tf 60 760 Td (Westmere Logistics) Tj',
    '/F1 13 Tf 0 -34 Td (DEMONSTRATION INVOICE) Tj',
    '0 -46 Td (Invoice WL-2026-1184) Tj',
    '0 -25 Td (Issued 18 November 2026) Tj',
    '0 -25 Td (Due 18 December 2026) Tj',
    '0 -40 Td (Transport and fulfilment services) Tj',
    '0 -28 Td (Amount due: GBP 18,420.00) Tj',
    '0 -48 Td (Synthetic payment destination: DEMO-9081) Tj',
    '0 -28 Td (Payment reference: WL-1184) Tj ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
    return String(offset).padStart(10, '0') + ' 00000 n \n';
  });
  const xref = pdf.length;
  pdf += 'xref\n0 6\n0000000000 65535 f \n' + offsets.join('') + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return new File([pdf], 'Westmere-WL-2026-1184.pdf', { type: 'application/pdf' });
}
