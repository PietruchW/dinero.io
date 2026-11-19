// Czytnik plików Excel (.xlsx) bez zewnętrznych bibliotek. Plik .xlsx to
// archiwum ZIP z plikami XML; rozpakowujemy je wbudowanym w przeglądarkę
// DecompressionStream i wyciągamy tylko wartości komórek pierwszego arkusza.
// Wynik ma ten sam kształt co parser CSV: tablica wierszy z tekstami.

const MAX_ENTRY_BYTES = 50 * 1024 * 1024; // ochrona przed „bombą zip”
const MAX_ROWS = 20000;

/** Czy bajty to archiwum ZIP (czyli m.in. .xlsx). */
export function isZip(bytes) {
  const b = toBytes(bytes);
  return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

/** Czy to stary, binarny format Excela (.xls), którego nie czytamy. */
export function isLegacyXls(bytes) {
  const b = toBytes(bytes);
  return b.length > 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;
}

function toBytes(bytes) {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

/**
 * Spis plików w archiwum ZIP: nazwa → { method, offset, size, compressed }.
 * @param {Uint8Array} b
 */
function zipEntries(b) {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('Uszkodzony plik ZIP');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = new Map();
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > b.length || view.getUint32(p, true) !== 0x02014b50) throw new Error('Uszkodzony plik ZIP');
    const method = view.getUint16(p + 10, true);
    const compressed = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = decoder.decode(b.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, offset, size, compressed });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readEntry(b, entry) {
  if (entry.size > MAX_ENTRY_BYTES) throw new Error('Plik jest za duży');
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (view.getUint32(entry.offset, true) !== 0x04034b50) throw new Error('Uszkodzony plik ZIP');
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  const data = b.subarray(start, start + entry.compressed);
  let out;
  if (entry.method === 0) {
    out = data;
  } else if (entry.method === 8) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('Ta przeglądarka nie umie otworzyć plików Excel. Zaktualizuj system albo użyj pliku CSV.');
    }
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    out = new Uint8Array(await new Response(stream).arrayBuffer());
  } else {
    throw new Error('Nieobsługiwana kompresja w pliku');
  }
  if (out.length > MAX_ENTRY_BYTES) throw new Error('Plik jest za duży');
  return new TextDecoder().decode(out);
}

/** Zamienia encje XML i zapis _xHHHH_ z Excela na zwykły tekst. */
function decodeXml(text) {
  return text
    .replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
      const named = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[e.toLowerCase()];
      if (named) return named;
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/_x([0-9a-f]{4})_/gi, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

function attr(attrs, name) {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return m ? m[1] : null;
}

/** Tekst komórki/ciągu: sklejone wszystkie <t>, bez wymowy fonetycznej <rPh>. */
function textOf(xml) {
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of clean.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += m[1];
  return decodeXml(out);
}

function sharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => (m[1] ? textOf(m[1]) : ''));
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Które style komórek (atrybut s) oznaczają datę. */
function dateStyles(xml) {
  const result = new Set();
  if (!xml) return result;
  const custom = new Map();
  for (const m of xml.matchAll(/<numFmt\s([^>]*)\/?>/g)) {
    const id = Number(attr(m[1], 'numFmtId'));
    const code = decodeXml(attr(m[1], 'formatCode') ?? '');
    custom.set(id, code);
  }
  const isDateCode = (code) => /[dy]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''));
  const xfs = xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (!xfs) return result;
  [...xfs[1].matchAll(/<xf\s([^>]*?)\/?>/g)].forEach((m, index) => {
    const id = Number(attr(m[1], 'numFmtId') ?? 0);
    if (BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateCode(custom.get(id)))) result.add(index);
  });
  return result;
}

/** Numer seryjny daty z Excela → "RRRR-MM-DD". */
function serialToDate(serial, date1904) {
  const days = Math.floor(serial) + (date1904 ? 1462 : 0);
  const d = new Date(Date.UTC(1899, 11, 30) + days * 86400000);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function columnIndex(ref) {
  const letters = (ref ?? '').match(/^[A-Z]+/);
  if (!letters) return null;
  let n = 0;
  for (const ch of letters[0]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function sheetPath(workbook, rels) {
  const first = workbook?.match(/<sheet\s([^>]*?)\/?>/);
  const rid = first ? attr(first[1], 'r:id') : null;
  if (rid && rels) {
    for (const m of rels.matchAll(/<Relationship\s([^>]*?)\/?>/g)) {
      if (attr(m[1], 'Id') === rid) {
        const target = decodeXml(attr(m[1], 'Target') ?? '');
        return target.startsWith('/') ? target.slice(1) : `xl/${target}`;
      }
    }
  }
  return 'xl/worksheets/sheet1.xml';
}

/**
 * Wiersze pierwszego arkusza pliku .xlsx jako teksty. Daty zamienione
 * na "RRRR-MM-DD", liczby zapisane z kropką (np. "-70.5").
 * @param {ArrayBuffer|Uint8Array} bytes
 * @returns {Promise<string[][]>}
 */
export async function readXlsx(bytes) {
  const b = toBytes(bytes);
  const entries = zipEntries(b);
  const get = async (name) => (entries.has(name) ? readEntry(b, entries.get(name)) : null);
  const workbook = await get('xl/workbook.xml');
  if (!workbook) throw new Error('To nie jest plik Excel');
  const rels = await get('xl/_rels/workbook.xml.rels');
  const path = sheetPath(workbook, rels);
  const sheet = await get(path);
  if (!sheet) throw new Error('Brak arkusza w pliku');
  const strings = sharedStrings(await get('xl/sharedStrings.xml'));
  const dates = dateStyles(await get('xl/styles.xml'));
  const date1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(workbook);

  const data = sheet.match(/<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/);
  if (!data) return [];
  const rows = [];
  for (const rowMatch of data[1].matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    if (rows.length >= MAX_ROWS) break;
    const row = [];
    let next = 0;
    for (const c of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const body = c[2] ?? '';
      const col = columnIndex(attr(attrs, 'r')) ?? next;
      next = col + 1;
      const type = attr(attrs, 't') ?? 'n';
      const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let value = '';
      if (type === 's') value = strings[Number(raw)] ?? '';
      else if (type === 'inlineStr') value = textOf(body);
      else if (type === 'str' || type === 'e') value = decodeXml(raw ?? '');
      else if (type === 'b') value = raw === '1' ? 'PRAWDA' : 'FAŁSZ';
      else if (type === 'd') value = (raw ?? '').slice(0, 10);
      else if (raw != null && raw !== '') {
        const n = Number(raw);
        if (!Number.isFinite(n)) value = raw;
        else if (dates.has(Number(attr(attrs, 's') ?? 0))) value = serialToDate(n, date1904);
        else value = String(Math.round(n * 100) / 100);
      }
      while (row.length < col) row.push('');
      row[col] = value;
    }
    rows.push(row);
  }
  return rows;
}
