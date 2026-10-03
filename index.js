require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder,
  EmbedBuilder,
  Events,
  ChannelType,
  MessageFlags,
  ActivityType,
} = require('discord.js');
const { createAI } = require('./src/ai');
const { neutralizeMentions, createScrubber } = require('./src/security');
const { chunkText } = require('./src/util');
const { systemFor, LUAU_SYSTEM } = require('./src/prompts');
const { readAttachments, buildPromptText, download, MAX_TEXT_BYTES } = require('./src/attachments');

const env = (name) => String(process.env[name] || '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
const DISCORD_TOKEN = (env('DISCORD_BOT_TOKEN') || env('DISCORD_TOKEN')).replace(/^Bot\s+/i, '');
const GROQ_API_KEY  = env('GROQ_API_KEY') || env('GROQ_KEY');
const GUILD_ID      = env('GUILD_ID');

if (!DISCORD_TOKEN || !GROQ_API_KEY) {
  console.error('Missing DISCORD_BOT_TOKEN or GROQ_API_KEY.');
  process.exit(1);
}

const scrub  = createScrubber([GROQ_API_KEY, DISCORD_TOKEN]);
const clean  = (text) => scrub(neutralizeMentions(text));
const NO_PINGS = { parse: [], repliedUser: false };

const ai = createAI({
  apiKey:      GROQ_API_KEY,
  baseUrl:     env('GROQ_BASE_URL') || 'https://api.groq.com/openai',
  model:       env('GROQ_MODEL')    || 'openai/gpt-oss-20b',
  scrub,
});

const MAX_FILE_BYTES      = 2 * 1024 * 1024;
const MAX_INPUT_FILE_BYTES = 300 * 1024;
const EPHEMERAL = { flags: MessageFlags.Ephemeral };

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
  allowedMentions: NO_PINGS,
});

// ── memory & cooldowns ────────────────────────────────────────────────────────
const memory = new Map();
const MAX_HISTORY     = 20;
const MAX_MEMORY_KEYS = 500;
const memKey = (channelId, userId) => channelId + ':' + userId;

function remember(key, role, content) {
  const history = memory.get(key) || [];
  history.push({ role, content });
  while (history.length > MAX_HISTORY) history.shift();
  memory.delete(key);
  memory.set(key, history);
  if (memory.size > MAX_MEMORY_KEYS) memory.delete(memory.keys().next().value);
}

const cooldowns = new Map();
function cooldown(userId, bucket, ms) {
  const key  = userId + ':' + bucket;
  const now  = Date.now();
  const last = cooldowns.get(key) || 0;
  if (now - last < ms) return Math.ceil((ms - (now - last)) / 1000);
  cooldowns.set(key, now);
  return 0;
}

const busyLuau = new Set();

// ── helpers ───────────────────────────────────────────────────────────────────
async function chatReply(key, userText, userId, att) {
  const history = memory.get(key) || [];
  let promptText = buildPromptText(String(userText || '').slice(0, 4000), att);
  const images = att ? att.images : [];
  if (!promptText) promptText = images.length ? 'Describe this image.' : 'hi';

  const userMsg = { role: 'user', content: promptText };
  const messages = [{ role: 'system', content: systemFor(userId) }, ...history, userMsg];

  const { text: answer } = await ai.chat(messages, { maxTokens: 2000 });
  remember(key, 'user', promptText.slice(0, 8000));
  remember(key, 'assistant', answer);
  return clean(answer).trim() || '(no response)';
}

async function sendInteractionText(i, text, ephemeral) {
  const extra = ephemeral ? EPHEMERAL : {};
  if (text.length > 5700) {
    const file = new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: 'reply.txt' });
    await i.editReply({ content: 'Reply was too long — attached as a file.', files: [file] });
    return;
  }
  const chunks = chunkText(text);
  await i.editReply({ content: chunks[0] });
  for (const chunk of chunks.slice(1)) await i.followUp({ content: chunk, ...extra });
}

async function fetchAttachmentText(att) {
  if (att.size > MAX_TEXT_BYTES) throw new Error('That file is too big. Max is 300 KB.');
  const buf = await download(att.url, MAX_TEXT_BYTES);
  return buf.toString('utf8');
}

// ── slash commands ─────────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask sinfultp ai anything')
    .addStringOption((o) => o.setName('prompt').setDescription('Your question or request').setRequired(true).setMaxLength(4000))
    .addBooleanOption((o) => o.setName('private').setDescription('Only you can see the reply'))
    .addAttachmentOption((o) => o.setName('file').setDescription('Optional text or code file to read')),

  new SlashCommandBuilder()
    .setName('luau')
    .setDescription('Generate Luau code and get it back as a .txt file (up to 2 MB)')
    .addStringOption((o) => o.setName('prompt').setDescription('What should the code do?').setRequired(true).setMaxLength(4000))
    .addStringOption((o) => o.setName('filename').setDescription('Name for the .txt file').setMaxLength(40)),

  new SlashCommandBuilder()
    .setName('fixcode')
    .setDescription('Upload a Luau/Lua file and get a fixed or updated version back')
    .addAttachmentOption((o) => o.setName('file').setDescription('.lua, .luau or .txt (max 300 KB)').setRequired(true))
    .addStringOption((o) => o.setName('instructions').setDescription('What to fix or change').setMaxLength(2000)),

  new SlashCommandBuilder()
    .setName('roast')
    .setDescription('Roast a user with sinfultp ai')
    .addUserOption((o) => o.setName('user').setDescription('Who to roast').setRequired(true))
    .addStringOption((o) => o.setName('extra').setDescription('Any extra context to spice it up').setMaxLength(500)),

  new SlashCommandBuilder()
    .setName('translate')
    .setDescription('Translate text into another language')
    .addStringOption((o) => o.setName('text').setDescription('Text to translate').setRequired(true).setMaxLength(3000))
    .addStringOption((o) => o.setName('language').setDescription('Target language, e.g. Spanish').setRequired(true).setMaxLength(40)),

  new SlashCommandBuilder()
    .setName('summarize')
    .setDescription('Summarize the latest messages in this channel')
    .addIntegerOption((o) => o.setName('count').setDescription('How many messages (5–100, default 30)').setMinValue(5).setMaxValue(100)),

  new SlashCommandBuilder()
    .setName('explain')
    .setDescription('Explain a piece of code or a concept in plain English')
    .addStringOption((o) => o.setName('input').setDescription('Paste code or describe the concept').setRequired(true).setMaxLength(4000))
    .addStringOption((o) =>
      o.setName('level').setDescription('Explanation level').addChoices(
        { name: 'Simple (beginner)', value: 'simple' },
        { name: 'Detailed (intermediate)', value: 'detailed' },
        { name: 'Technical (expert)', value: 'technical' },
      ),
    ),

  new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Create a quick poll with up to 4 options')
    .addStringOption((o) => o.setName('question').setDescription('The poll question').setRequired(true).setMaxLength(200))
    .addStringOption((o) => o.setName('option1').setDescription('Option 1').setRequired(true).setMaxLength(80))
    .addStringOption((o) => o.setName('option2').setDescription('Option 2').setRequired(true).setMaxLength(80))
    .addStringOption((o) => o.setName('option3').setDescription('Option 3 (optional)').setMaxLength(80))
    .addStringOption((o) => o.setName('option4').setDescription('Option 4 (optional)').setMaxLength(80)),

  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Clear my memory of our conversation here'),
];

// ── command handler ───────────────────────────────────────────────────────────
async function handle(i) {
  const name = i.commandName;

  // ── /reset ──────────────────────────────────────────────────────────────────
  if (name === 'reset') {
    memory.delete(memKey(i.channelId, i.user.id));
    return i.reply({ content: '🧹 Memory cleared.', ...EPHEMERAL });
  }

  // ── /ask ────────────────────────────────────────────────────────────────────
  if (name === 'ask') {
    const wait = cooldown(i.user.id, 'ai', 3000);
    if (wait) return i.reply({ content: `Slow down — try again in ${wait}s.`, ...EPHEMERAL });
    const priv = i.options.getBoolean('private') || false;
    await i.deferReply(priv ? EPHEMERAL : {});
    const file = i.options.getAttachment('file');
    const att  = file ? await readAttachments([file]) : null;
    const reply = await chatReply(memKey(i.channelId, i.user.id), i.options.getString('prompt', true), i.user.id, att);
    return sendInteractionText(i, reply, priv);
  }

  // ── /translate ──────────────────────────────────────────────────────────────
  if (name === 'translate') {
    const wait = cooldown(i.user.id, 'ai', 3000);
    if (wait) return i.reply({ content: `Slow down — try again in ${wait}s.`, ...EPHEMERAL });
    await i.deferReply();
    const text = i.options.getString('text', true);
    const lang = i.options.getString('language', true);
    const { text: out } = await ai.chat(
      [
        { role: 'system', content: 'You are a translator. Output only the translation, nothing else.' },
        { role: 'user',   content: `Translate into ${lang}:\n\n${text}` },
      ],
      { maxTokens: 2000, temperature: 0.2 },
    );
    const embed = new EmbedBuilder()
      .setColor(0x8b5cf6)
      .setTitle(`🌐 Translated to ${lang}`)
      .setDescription(clean(out).trim().slice(0, 4000) || '(no response)')
      .setFooter({ text: 'sinfultp ai • /translate' });
    return i.editReply({ embeds: [embed] });
  }

  // ── /summarize ──────────────────────────────────────────────────────────────
  if (name === 'summarize') {
    const wait = cooldown(i.user.id, 'ai', 8000);
    if (wait) return i.reply({ content: `Slow down — try again in ${wait}s.`, ...EPHEMERAL });
    await i.deferReply();
    const count   = i.options.getInteger('count') || 30;
    const fetched = await i.channel.messages.fetch({ limit: count });
    const lines   = [...fetched.values()]
      .reverse()
      .filter((m) => m.content)
      .map((m) => `${m.author.username}: ${m.content}`);
    if (!lines.length) return i.editReply({ content: 'No text messages to summarize here.' });
    const transcript = lines.join('\n').slice(-14000);
    const { text: out } = await ai.chat(
      [
        { role: 'system', content: 'Summarize the Discord conversation clearly in short bullet points. Mention who said what only when relevant.' },
        { role: 'user',   content: transcript },
      ],
      { maxTokens: 1200, temperature: 0.3 },
    );
    const embed = new EmbedBuilder()
      .setColor(0x8b5cf6)
      .setTitle(`📋 Summary of last ${count} messages`)
      .setDescription(clean(out).trim().slice(0, 4000) || '(no response)')
      .setFooter({ text: 'sinfultp ai • /summarize' });
    return i.editReply({ embeds: [embed] });
  }

  // ── /roast ──────────────────────────────────────────────────────────────────
  if (name === 'roast') {
    const wait = cooldown(i.user.id, 'ai', 5000);
    if (wait) return i.reply({ content: `Slow down — try again in ${wait}s.`, ...EPHEMERAL });
    await i.deferReply();
    const target = i.options.getUser('user', true);
    const extra  = i.options.getString('extra') || '';
    const { text: out } = await ai.chat(
      [
        { role: 'system', content: 'You are a savage but funny roast comedian. Keep it under 300 characters, punchy, witty, no slurs.' },
        { role: 'user',   content: `Roast Discord user "${target.username}"${extra ? `. Context: ${extra}` : ''}.` },
      ],
      { maxTokens: 300, temperature: 0.95 },
    );
    const embed = new EmbedBuilder()
      .setColor(0xef4444)
      .setTitle(`🔥 Roasting ${target.username}`)
      .setDescription(clean(out).trim().slice(0, 500) || '(no response)')
      .setFooter({ text: `Requested by ${i.user.username} • sinfultp ai` });
    return i.editReply({ embeds: [embed] });
  }

  // ── /explain ─────────────────────────────────────────────────────────────────
  if (name === 'explain') {
    const wait = cooldown(i.user.id, 'ai', 4000);
    if (wait) return i.reply({ content: `Slow down — try again in ${wait}s.`, ...EPHEMERAL });
    await i.deferReply();
    const input = i.options.getString('input', true);
    const level = i.options.getString('level') || 'detailed';
    const levelMap = {
      simple:   'Explain this in very simple terms a beginner can understand. No jargon.',
      detailed: 'Explain this clearly with enough detail for an intermediate developer.',
      technical:'Give a deep technical explanation with implementation details.',
    };
    const { text: out } = await ai.chat(
      [
        { role: 'system', content: levelMap[level] + ' Use Discord markdown. Keep it concise.' },
        { role: 'user',   content: input },
      ],
      { maxTokens: 1500, temperature: 0.3 },
    );
    const levelEmoji = { simple: '🟢', detailed: '🟡', technical: '🔴' };
    const embed = new EmbedBuilder()
      .setColor(0x8b5cf6)
      .setTitle(`${levelEmoji[level]} Explanation (${level})`)
      .setDescription(clean(out).trim().slice(0, 4000) || '(no response)')
      .setFooter({ text: 'sinfultp ai • /explain' });
    return i.editReply({ embeds: [embed] });
  }

  // ── /poll ────────────────────────────────────────────────────────────────────
  if (name === 'poll') {
    const question = i.options.getString('question', true);
    const opts = [
      i.options.getString('option1'),
      i.options.getString('option2'),
      i.options.getString('option3'),
      i.options.getString('option4'),
    ].filter(Boolean);
    const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
    const lines  = opts.map((o, idx) => `${emojis[idx]} ${o}`);
    const embed  = new EmbedBuilder()
      .setColor(0x8b5cf6)
      .setTitle(`📊 ${question}`)
      .setDescription(lines.join('\n'))
      .setFooter({ text: `Poll by ${i.user.username}` });
    await i.reply({ embeds: [embed] });
    const msg = await i.fetchReply();
    for (let idx = 0; idx < opts.length; idx++) await msg.react(emojis[idx]);
    return;
  }

  // ── /luau & /fixcode ─────────────────────────────────────────────────────────
  if (name === 'luau' || name === 'fixcode') {
    const wait = cooldown(i.user.id, 'luau', 20000);
    if (wait) return i.reply({ content: `Slow down — try again in ${wait}s.`, ...EPHEMERAL });
    if (busyLuau.has(i.user.id)) return i.reply({ content: 'You already have a script generating.', ...EPHEMERAL });
    await i.deferReply();

    let prompt, baseName;
    if (name === 'luau') {
      prompt   = i.options.getString('prompt', true);
      baseName = i.options.getString('filename') || 'script';
    } else {
      const att      = i.options.getAttachment('file', true);
      const source   = await fetchAttachmentText(att);
      const instruct = i.options.getString('instructions') || 'Find and fix all bugs and errors, and improve the code where clearly weak.';
      prompt   = `Here is an existing script:\n\n${source}\n\nTask: ${instruct}\n\nReturn the full updated script.`;
      baseName = att.name.replace(/\.[^.]+$/, '') + '_fixed';
    }

    const fileName = baseName.replace(/[^a-z0-9_-]/gi, '_').slice(0, 40) || 'script';
    busyLuau.add(i.user.id);
    let lastEdit = 0;
    try {
      const result = await ai.generateCode({
        system: LUAU_SYSTEM,
        prompt,
        maxBytes: MAX_FILE_BYTES,
        onProgress: ({ rounds, bytes }) => {
          const now = Date.now();
          if (now - lastEdit < 4000) return;
          lastEdit = now;
          i.editReply({ content: `Writing your code... part ${rounds} (${(bytes / 1024).toFixed(1)} KB so far)` }).catch(() => {});
        },
      });
      const code = scrub(result.code);
      const file = new AttachmentBuilder(Buffer.from(code, 'utf8'), { name: fileName + '.txt' });
      const lines = code.split('\n').length;
      const kb    = (Buffer.byteLength(code) / 1024).toFixed(1);
      let msg = `✅ Done — ${lines} lines, ${kb} KB, ${result.rounds} part(s).`;
      if (result.truncated) msg += ` Stopped early: ${result.reason}.`;
      await i.editReply({ content: msg, files: [file] });
    } finally {
      busyLuau.delete(i.user.id);
    }
  }
}

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return;
  try {
    await handle(i);
  } catch (e) {
    console.error('[command error]', i.commandName, scrub(e?.message ?? e));
    const msg = clean('Something went wrong: ' + (e?.message ?? 'unknown error')).slice(0, 300);
    if (i.deferred || i.replied) await i.editReply({ content: msg }).catch(() => {});
    else await i.reply({ content: msg, ...EPHEMERAL }).catch(() => {});
  }
});

// ── .help + mention/DM chat ───────────────────────────────────────────────────
function helpEmbed() {
  return new EmbedBuilder()
    .setTitle('sinfultp ai')
    .setColor(0x8b5cf6)
    .setDescription(
      [
        '**Chat:** mention me or DM me. I remember the last 20 messages of your conversation.',
        '',
        '`/ask` — ask anything (optional file)',
        '`/luau` — generate Luau code as a .txt file (up to 2 MB)',
        '`/fixcode` — upload a script and get it fixed',
        '`/roast` — roast any user',
        '`/explain` — explain code or a concept (beginner / detailed / technical)',
        '`/translate` — translate text to any language',
        '`/summarize` — summarize recent messages in this channel',
        '`/poll` — create a quick reaction poll with up to 4 options',
        '`/reset` — clear my memory of our chat',
        '`.help` — show this menu',
      ].join('\n'),
    )
    .setFooter({ text: 'sinfultp ai • powered by Groq' });
}

client.on(Events.MessageCreate, async (m) => {
  try {
    if (m.author.bot) return;

    if (/^\.help\s*$/i.test(m.content.trim())) {
      await m.reply({ embeds: [helpEmbed()], allowedMentions: NO_PINGS });
      return;
    }

    const isDM     = m.channel.type === ChannelType.DM;
    const botRole  = m.guild?.members?.me?.roles?.botRole ?? null;
    const mentioned =
      m.mentions.users.has(client.user.id) ||
      (botRole && m.mentions.roles.has(botRole.id)) ||
      new RegExp('<@!?' + client.user.id + '>').test(m.content);
    if (!isDM && !mentioned) return;

    let text = m.content.replace(new RegExp('<@!?' + client.user.id + '>', 'g'), '');
    if (botRole) text = text.replace(new RegExp('<@&' + botRole.id + '>', 'g'), '');
    text = text.trim();

    const attachments = [...m.attachments.values()];
    let quoted = '';
    if (m.reference?.messageId) {
      try {
        const ref = await m.fetchReference();
        attachments.push(...ref.attachments.values());
        if (ref.content) quoted = `[Replying to ${ref.author.username}: ${ref.content.slice(0, 2000)}]\n\n`;
      } catch (_) {}
    }

    if (!text && !attachments.length && !quoted) {
      await m.reply({ content: 'Ask me anything, or type `.help`.', allowedMentions: NO_PINGS });
      return;
    }
    if (cooldown(m.author.id, 'ai', 3000)) return;

    await m.channel.sendTyping();
    const att   = attachments.length ? await readAttachments(attachments) : null;
    const reply = await chatReply(memKey(m.channelId, m.author.id), quoted + text, m.author.id, att);

    if (reply.length > 5700) {
      const file = new AttachmentBuilder(Buffer.from(reply, 'utf8'), { name: 'reply.txt' });
      await m.reply({ content: 'Reply was too long — attached as a file.', files: [file], allowedMentions: NO_PINGS });
      return;
    }
    const chunks = chunkText(reply);
    await m.reply({ content: chunks[0], allowedMentions: NO_PINGS });
    for (const chunk of chunks.slice(1)) await m.channel.send({ content: chunk, allowedMentions: NO_PINGS });
  } catch (e) {
    console.error('[message error]', scrub(e?.message ?? e));
    await m.reply({ content: clean('Something went wrong: ' + (e?.message ?? 'unknown error')).slice(0, 300), allowedMentions: NO_PINGS })
      .catch((err) => console.error('[reply error]', scrub(err?.message ?? err)));
  }
});

client.once(Events.ClientReady, async (c) => {
  console.log('Logged in as ' + c.user.tag);
  c.user.setActivity('.help | sinfultp ai', { type: ActivityType.Playing });
  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    const body = commands.map((cmd) => cmd.toJSON());
    if (GUILD_ID) await rest.put(Routes.applicationGuildCommands(c.application.id, GUILD_ID), { body });
    else          await rest.put(Routes.applicationCommands(c.application.id), { body });
    console.log('Registered ' + body.length + ' slash commands' + (GUILD_ID ? ' in guild ' + GUILD_ID : ' globally'));
  } catch (e) {
    console.error('Failed to register commands:', scrub(e?.message ?? e));
  }
});

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', scrub(e?.message ?? e)));
process.on('uncaughtException',  (e) => console.error('[uncaughtException]',  scrub(e?.message ?? e)));

if (/[^\x21-\x7E]/.test(DISCORD_TOKEN)) {
  console.error('DISCORD_BOT_TOKEN contains spaces or invalid characters.');
  process.exit(1);
}

client.login(DISCORD_TOKEN).catch((e) => {
  console.error('Discord login failed:', scrub(e?.message ?? e));
  process.exit(1);
});
