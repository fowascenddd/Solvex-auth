const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);
const TEXT_EXT = /\.(txt|lua|luau|json|md|csv|log|js|mjs|cjs|ts|tsx|jsx|py|html|htm|css|xml|yml|yaml|ini|cfg|conf|toml|sh|bat|ps1|c|cpp|h|hpp|cs|java|kt|rs|go|php|rb|sql|env|rbxm|rbxmx)$/i;

const MAX_TEXT_BYTES = 300 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 4;
const MAX_TEXT_FILES = 3;

function isDiscordHost(url) {
  try {
    const host = new URL(url).hostname;
    return /(^|\.)(discordapp\.com|discordapp\.net|discord\.com|discord\.media)$/.test(host);
  } catch (_) {
    return false;
  }
}

async function download(url, maxBytes) {
  if (!isDiscordHost(url)) throw new Error('only files uploaded to Discord are supported');
  const res = await fetch(url);
  if (!res.ok) throw new Error('download failed (' + res.status + ')');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error('file is too large');
  return buf;
}

// Reads Discord attachments: text/code files become text, images become base64 data URLs.
async function readAttachments(list) {
  const out = { files: [], images: [], notes: [] };
  for (const att of list.slice(0, 8)) {
    const name = att.name || 'file';
    const mime = String(att.contentType || '').split(';')[0].trim().toLowerCase();
    try {
      if (IMAGE_MIME.has(mime)) {
        if (out.images.length >= MAX_IMAGES) throw new Error('only ' + MAX_IMAGES + ' images per message');
        if (att.size > MAX_IMAGE_BYTES) throw new Error('image is over 5 MB');
        const buf = await download(att.url, MAX_IMAGE_BYTES);
        const type = mime === 'image/jpg' ? 'image/jpeg' : mime;
        out.images.push('data:' + type + ';base64,' + buf.toString('base64'));
      } else if (mime.startsWith('text/') || mime === 'application/json' || TEXT_EXT.test(name)) {
        if (out.files.length >= MAX_TEXT_FILES) throw new Error('only ' + MAX_TEXT_FILES + ' text files per message');
        if (att.size > MAX_TEXT_BYTES) throw new Error('file is over 300 KB');
        const buf = await download(att.url, MAX_TEXT_BYTES);
        if (buf.includes(0)) throw new Error('looks like a binary file');
        const CHAR_CAP = 12000;
        let fileText = buf.toString('utf8');
        let capped = false;
        if (fileText.length > CHAR_CAP) {
          fileText = fileText.slice(0, CHAR_CAP);
          capped = true;
        }
        out.files.push({ name, text: fileText });
        if (capped) out.notes.push(name + ': file was large — only the first ~12,000 characters were read');
      } else {
        throw new Error('unsupported type (I can read images and text or code files)');
      }
    } catch (e) {
      out.notes.push(name + ': ' + e.message);
    }
  }
  return out;
}

function buildPromptText(typed, att) {
  let text = String(typed || '');
  if (att) {
    for (const f of att.files) {
      text += '\n\n----- BEGIN FILE: ' + f.name + ' -----\n' + f.text + '\n----- END FILE: ' + f.name + ' -----';
    }
    for (const note of att.notes) text += '\n\n[Note: could not read attachment ' + note + ']';
  }
  return text.trim();
}

module.exports = { readAttachments, buildPromptText, download, MAX_TEXT_BYTES };
