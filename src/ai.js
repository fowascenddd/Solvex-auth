const { sleep, capBytes, stripFences } = require('./util');
const { CONTINUE } = require('./prompts');

const STOP_NOTES = {
  size:   'reached the 2 MB size cap',
  rounds: 'reached the round limit',
  time:   'reached the time limit',
  empty:  'the model stopped responding',
};

function createAI({
  apiKey,
  baseUrl = 'https://api.groq.com/openai',
  model   = 'openai/gpt-oss-20b',
  scrub   = (s) => s,
}) {
  const base = String(baseUrl).replace(/\/+$/, '');

  async function request(path, { method = 'GET', body, timeoutMs = 60000 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res, text;
      try {
        res  = await fetch(base + path, {
          method,
          headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
          signal: ctrl.signal,
        });
        text = await res.text();
      } catch (e) {
        lastErr = new Error(e?.name === 'AbortError' ? 'Request timed out — try a shorter input.' : 'Could not reach the AI service.');
        await sleep(1200 * (attempt + 1));
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

      // Retry on rate-limit or server errors
      if (res.status === 429 || res.status >= 500) {
        lastErr = err;
        await sleep(2000 * (attempt + 1));
        continue;
      }

      // Context too long — surface a helpful error immediately
      if (res.status === 400 && String(detail).toLowerCase().includes('context')) {
        throw new Error('That input is too long for me to process. Try summarising or splitting it.');
      }

      throw err;
    }
    throw lastErr || new Error('AI request failed after 3 attempts.');
  }

  // Core chat — trims message history if the context is too long, then retries.
  async function chat(messages, { maxTokens = 2000, temperature } = {}) {
    const body = { model, messages, max_tokens: maxTokens, stream: false };
    if (temperature !== undefined) body.temperature = temperature;

    for (let trim = 0; trim <= 3; trim++) {
      // Each trim pass removes the 2 oldest non-system messages from history
      const trimmed = trim === 0
        ? messages
        : (() => {
            const sys  = messages.filter((m) => m.role === 'system');
            const rest = messages.filter((m) => m.role !== 'system');
            // Drop oldest pairs first; keep at least the last user message
            const drop = Math.min(trim * 2, Math.max(0, rest.length - 1));
            return [...sys, ...rest.slice(drop)];
          })();

      try {
        const data   = await request('/v1/chat/completions', { method: 'POST', body: { ...body, messages: trimmed } });
        const choice = data.choices?.[0];
        if (!choice) throw new Error('The AI returned an empty response.');

        const text   = (choice.message?.content ?? '').trim();
        const finish = choice.finish_reason || 'stop';

        // Empty reply — retry once with a nudge rather than giving up
        if (!text) {
          if (trim < 3) continue;
          return { text: "I couldn't come up with a response for that. Try rephrasing or breaking it into smaller parts.", finish: 'stop' };
        }

        return { text, finish };
      } catch (e) {
        // If context_length error, trim and retry; otherwise rethrow
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

  // Long code generation — continues across multiple rounds until done or capped
  async function generateCode({
    system,
    prompt,
    maxBytes   = 2 * 1024 * 1024,
    maxRounds  = 60,
    chunkTokens = 8000,
    deadlineMs = 13 * 60 * 1000,
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
      if (!text)            { reason = 'empty';  break; }
      if (bytes >= maxBytes){ reason = 'size';   break; }
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
