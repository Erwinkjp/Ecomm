/**
 * Parse delimiter-separated flat file into array of row objects.
 */
function parseFlatFile(content, options = {}) {
  const { delimiter = ',', hasHeader = true } = options;
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) return [];

  const rawRows = lines.map((line) => {
    const parts = splitByDelimiter(line, delimiter);
    return parts.map((p) => p.trim().replace(/^["']|["']$/g, ''));
  });

  if (!hasHeader || rawRows.length === 0) {
    return rawRows.map((values) => values.reduce((acc, v, i) => ({ ...acc, [i]: v }), {}));
  }
  const headers = rawRows[0].map((h, i) => h || `col_${i}`);
  return rawRows.slice(1).map((values) => {
    const row = {};
    headers.forEach((h, i) => { row[h] = values[i]; });
    return row;
  });
}

function splitByDelimiter(line, delimiter) {
  if (delimiter === ',') {
    const parts = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') inQuotes = !inQuotes;
      else if ((c === ',' && !inQuotes) || c === '\t') {
        parts.push(current);
        current = '';
      } else current += c;
    }
    parts.push(current);
    return parts;
  }
  return line.split(delimiter);
}

module.exports = { parseFlatFile };
