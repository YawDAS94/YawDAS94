/**
 * Minimal RFC 4180 CSV reader. The bundled listing data has commas inside
 * quoted fields ("New York, NY 10022") and quoted broker names, so splitting on
 * commas mangles roughly 5% of the rows -- hence a real parser.
 */

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'; // escaped quote
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      // Swallow \r\n as a single terminator; ignore blank line noise.
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Parse into objects keyed by the header row. */
export function parseCsvObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    header.forEach((key, idx) => {
      obj[key] = r[idx] ?? '';
    });
    return obj;
  });
}

export function toNumber(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/[$,%\s,]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
