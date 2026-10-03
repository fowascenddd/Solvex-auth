const { sleep, capBytes, stripFences } = require('./util');
const { CONTINUE } = require('./prompts');

const STOP_NOTES = {
  size:   'reached the 2 MB size cap',
  rounds: 'reached the round limit',
  time:   'reached the time limit',
  empty:  'the model stopped responding',
};

// ── key pool ──────────────────────────────────────────────────────────────────
// Reads GROQ_API_KEYS (comma-separated) and GROQ_API_KEY from env and dedupes.
// On a 429 the key is cooled down for COOLDOWN_MS before being tried again;
// all other errors are not penalised so one bad key doesn't starve the others.
const COOLDOWN_MS = 60 * 1000;

function createKeyPool(keys) {
  const pool = [...new Set(keys.filter(Boolean))].map((k) => ({
    key:       k,
    coolUntil: 0,
    uses:      0,
    hits429:   0,
  }));
  if (!pool.length) throw new Error('No Groq API keys configured.');

  let idx = 0;

  function pick() {
    const now = Date.now();
    // Try in round-robin order; skip any key that is still cooling down.
    for (let i = 0; i < pool.length; i++) {
      const k = pool[(idx + i) % pool.length];
      if (k.coolUntil <= now) {
        idx = (idx + 1) % pool.length;
        return k;
      }
    }
    // All cooled — return the one whose cooldown expires soonest.
    return pool.reduce((a, b) => (a.coolUntil < b.coolUntil ? a : b));
  }

  function penalise(key) {
    const entry = pool.find((k) => k.key === key);
    if (entry) {
      entry.coolUntil = Date.now() + COOLDOWN_MS;
      entry.hits429++;
    }
  }

  function status() {
    const now = Date.now();
    return pool.map((k, i) => ({
      index:    i,
      uses:     k.uses,
      hits429:  k.hits429,
      cooling:  k.coolUntil > now ? Math.ceil((k.coolUntil - now) / 1000) + 's' : 'ready',
    }));
  }

  return { pick, penalise, status, size: pool.length };
}

// ── factory ───────────────────────────────────────────────────────────────────
function createAI({
  apiKey,           // single key (legacy / env GROQ_API_KEY)
  apiKeys,          // array of keys (env GROQ_API_KEYS or explicit list)
  baseUrl = 'https://api.groq.com/openai',
  model   = 'openai/gpt-oss-120b',
  scrub   = (s) => s,
}) {
  const allKeys = [...(apiKeys || []), ...(apiKey ? [apiKey] : [])];
  const pool    = createKeyPool(allKeys);
  const base    = String(baseUrl).replace(/\/+$/, '');

  console.log(`[ai] Loaded ${pool.size} Groq API key(s).`);

  async function request(path, { method = 'GET', body, timeoutMs = 60000 } = {}) {
    let lastErr;

    // Up to 3 attempts; on 429 we switch key and retry immediately.
    for (let attempt = 0; attempt < pool.size * 2 + 3; attempt++) {
      const entry = pool.pick();
      entry.uses++;

      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res, text;
      try {
        res  = await fetch(base + path, {
          method,
          headers: { Authorization: 'Bearer ' + entry.key, 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
          signal: ctrl.signal,
        });
        text = await res.text();
      } catch (e) {
        lastErr = new Error(e?.name === 'AbortError' ? 'Request timed out — try a shorter input.' : 'Could not reach the AI service.');
        await sleep(1200 * Math.min(attempt + 1, 3));
        continue;
      } finally {
        clearTimeout(timer);
      }

      let json = null;
      try { json = JSON.parse(text); } catch (_) {}
      if (res.ok) return json || {};

      const detail = (json?.error?.message ?? json?.error ?? json?.message) || text || res.statusText;
      const err    = new Error('AI error ' + res.status + ': ' + scrub(String(detail)).slice(0, 200));
      err.status   = res.status;

      if (res.status === 429) {
        // Cool this key down and immediately try another key on the next loop pass.
        pool.penalise(entry.key);
        lastErr = err;
        // Only sleep if we're running out of keys.
        const allCooling = pool.status().every((s) => s.cooling !== 'ready');
        if (allCooling) await sleep(2000);
        continue;
      }

      if (res.status >= 500) {
        lastErr = err;
        await sleep(2000 * Math.min(attempt + 1, 3));
        continue;
      }

      if (res.status === 400 && String(detail).toLowerCase().includes('context')) {
        throw new Error('That input is too long for me to process. Try summarising or splitting it.');
      }

      throw err;
    }
    throw lastErr || new Error('AI request failed — all keys may be rate-limited.');
  }

  async function chat(messages, { maxTokens = 2000, temperature } = {}) {
    const body = { model, messages, max_tokens: maxTokens, stream: false };
    if (temperature !== undefined) body.temperature = temperature;

    for (let trim = 0; trim <= 3; trim++) {
      const trimmed = trim === 0
        ? messages
        : (() => {
            const sys  = messages.filter((m) => m.role === 'system');
            const rest = messages.filter((m) => m.role !== 'system');
            const drop = Math.min(trim * 2, Math.max(0, rest.length - 1));
            return [...sys, ...rest.slice(drop)];
          })();

      try {
        const data   = await request('/v1/chat/completions', { method: 'POST', body: { ...body, messages: trimmed } });
        const choice = data.choices?.[0];
        if (!choice) throw new Error('The AI returned an empty response.');

        const text   = (choice.message?.content ?? '').trim();
        const finish = choice.finish_reason || 'stop';

        if (!text) {
          if (trim < 3) continue;
          return { text: "I couldn't come up with a response for that. Try rephrasing or breaking it into smaller parts.", finish: 'stop' };
        }

        return { text, finish };
      } catch (e) {
        const msg = (e?.message ?? '').toLowerCase();
        if ((msg.includes('context') || msg.includes('token') || msg.includes('length')) && trim < 3) {
          await sleep(500);
          continue;
        }
        throw e;
      }
    }

    return { text: "I couldn't process that — the input may be too large. Try breaking it into smaller parts.", finish: 'stop' };
  }

  async function generateCode({
    system,
    prompt,
    maxBytes    = 2 * 1024 * 1024,
    maxRounds   = 60,
    chunkTokens = 8000,
    deadlineMs  = 13 * 60 * 1000,
    onProgress,
  }) {
    const started = Date.now();
    let out    = '';
    let rounds = 0;
    let reason = 'done';
    let messages = [{ role: 'system', content: system }, { role: 'user', content: prompt }];

    for (;;) {
      rounds++;
      const { text, finish } = await chat(messages, { maxTokens: chunkTokens });
      out += text;
      const bytes = Buffer.byteLength(out);
      if (onProgress) onProgress({ rounds, bytes });
      if (finish !== 'length') break;
      if (!text)              { reason = 'empty';  break; }
      if (bytes >= maxBytes)  { reason = 'size';   break; }
      if (rounds >= maxRounds){ reason = 'rounds'; break; }
      if (Date.now() - started > deadlineMs){ reason = 'time'; break; }
      messages = [
        { role: 'system',    content: system },
        { role: 'user',      content: prompt + '\n\n(Your answer is long, so it is delivered in several parts.)' },
        { role: 'assistant', content: out.slice(-8000) },
        { role: 'user',      content: CONTINUE },
      ];
    }

    let code      = stripFences(out);
    let truncated = reason !== 'done';
    if (Buffer.byteLength(code) > maxBytes) {
      code      = capBytes(code, maxBytes - 160);
      truncated = true;
      reason    = 'size';
    }
    if (truncated) code += '\n-- [output stopped: ' + STOP_NOTES[reason] + ']\n';
    return { code, rounds, truncated, reason };
  }

  return { chat, generateCode };
}

module.exports = { createAI };
