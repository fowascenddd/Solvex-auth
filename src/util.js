const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chunkText(text, size = 1900) {
  const chunks = [];
  let rest = String(text);
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf(' ', size);
    if (cut < size * 0.5) cut = size;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

function capBytes(str, maxBytes) {
  if (Buffer.byteLength(str) <= maxBytes) return str;
  let s = Buffer.from(str, 'utf8').subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/, '');
  const lastNewline = s.lastIndexOf('\n');
  if (lastNewline > 0) s = s.slice(0, lastNewline);
  return s;
}

function stripFences(text) {
  return String(text)
    .replace(/^[ \t]*```[a-zA-Z0-9_-]*[ \t]*\r?$/gm, '')
    .replace(/^\s*\n/, '')
    .replace(/\s+$/, '') + '\n';
}

module.exports = { sleep, chunkText, capBytes, stripFences };
