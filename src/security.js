const ZWSP = '\u200b';

// Breaks @everyone / @here / @verified and any role mention so they can never ping.
function neutralizeMentions(text) {
  return String(text == null ? '' : text)
    .replace(/@(everyone|here|verified)/gi, (_m, word) => '@' + ZWSP + word)
    .replace(/<@&\d+>/g, '@' + ZWSP + 'role');
}

// Removes secrets (API key, bot token) from anything that is about to be sent to Discord.
function createScrubber(secrets) {
  const list = secrets.filter((s) => typeof s === 'string' && s.length >= 8);
  const tokenRe = /[MNO][A-Za-z\d_-]{23,25}\.[\w-]{6}\.[\w-]{27,}/g;
  const bearerRe = /Bearer\s+[A-Za-z0-9._~+\/-]{16,}/g;
  return function scrub(text) {
    let out = String(text == null ? '' : text);
    for (const secret of list) out = out.split(secret).join('[redacted]');
    return out.replace(tokenRe, '[redacted]').replace(bearerRe, 'Bearer [redacted]');
  };
}

module.exports = { neutralizeMentions, createScrubber };
