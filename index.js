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
  PermissionFlagsBits: P,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AuditLogEvent,
} = require('discord.js');
const http = require('node:http');
let voiceStuff = null;
try {
  voiceStuff = require('@discordjs/voice');
} catch (_) {}
let ytdlCore = null;
try {
  ytdlCore = require('@distube/ytdl-core');
} catch (_) {}
try {
  require('ffmpeg-static');
  process.env.FFMPEG_PATH = require('ffmpeg-static');
} catch (_) {}
const { createAI } = require('./src/ai');
const { neutralizeMentions, createScrubber } = require('./src/security');
const { chunkText } = require('./src/util');
const { systemFor, LUAU_SYSTEM } = require('./src/prompts');
const { readAttachments, buildPromptText, download, MAX_TEXT_BYTES } = require('./src/attachments');
const { createMod, parseTarget } = require('./src/mod');
const { createBuilder } = require('./src/builder');

const env = (name) => String(process.env[name] || '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
const DISCORD_TOKEN = (env('DISCORD_BOT_TOKEN') || env('DISCORD_TOKEN')).replace(/^Bot\s+/i, '');
const GROQ_API_KEY  = env('GROQ_API_KEY') || env('GROQ_KEY');
const GUILD_ID      = env('GUILD_ID');
// Multi-key pool: GROQ_API_KEYS is a comma-separated list of extra keys (fallbacks on 429).
// GROQ_API_KEY is always included as the primary key.
const GROQ_API_KEYS_EXTRA = env('GROQ_API_KEYS')
  .split(/[,\n\r\t ]+/)
  .map((k) => k.trim())
  .filter(Boolean);
// Only this Discord user ID can make the AI give roles/permissions or ban/kick/timeout.
const OWNER_ID      = env('OWNER_ID') || '1088143400496279552';
// Staff application form webhook/channel.
const MODAPP_CHANNEL_ID = env('MODAPP_CHANNEL_ID') || '1555973537582284831';
const MODAPP_URL        = env('MODAPP_URL') || 'https://sinfultpai.up.railway.app/modapp';
const MODAPP_SECRET     = env('MODAPP_SECRET');
const MODAPP_PORT       = Number(env('MODAPP_PORT') || env('PORT') || 8080);
const MODAPP_STAFF_ROLE_ID = env('MODAPP_STAFF_ROLE_ID');
const MOD_LOG_CHANNEL_ID = env('MOD_LOG_CHANNEL_ID') || '1555984649761722438';
const VERIFY_CHANNEL_ID = env('VERIFY_CHANNEL_ID') || '1556025020671725720';
const VERIFY_ROLE_ID = env('VERIFY_ROLE_ID') || '1556025670608625774';
const FOWA_PAGE = '/fowa';
const TICKET_SUPPORT_IDS = ['1555972937595617280', '1555957115728826408', '1555981671973781634'];
const openTickets = new Map();
const ticketMeta = new Map();
const DISCORD_CLIENT_ID = env('DISCORD_CLIENT_ID');
const DISCORD_CLIENT_SECRET = env('DISCORD_CLIENT_SECRET');
const OAUTH_REDIRECT_URI = env('OAUTH_REDIRECT_URI') || 'https://sinfultpai.up.railway.app/auth/discord/callback';
const MODAPP_REQUIRE_LOGIN = String(env('MODAPP_REQUIRE_LOGIN') || 'false').toLowerCase() === 'true';
const fs = require('fs');
const path = require('path');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
const SESSIONS_FILE = path.join(DATA_DIR, 'modapp_sessions.json');
const SUBMISSIONS_FILE = path.join(DATA_DIR, 'modapp_submissions.json');
const loadJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; } };
const modappSessions = new Map(Object.entries(loadJson(SESSIONS_FILE, {})));
const modappSubmissions = loadJson(SUBMISSIONS_FILE, []);
const VERIFICATIONS_FILE = path.join(DATA_DIR, 'verifications.json');
const verifications = new Map(Object.entries(loadJson(VERIFICATIONS_FILE, {})));
const saveVerifications = () => { try { fs.writeFileSync(VERIFICATIONS_FILE, JSON.stringify(Object.fromEntries(verifications), null, 2)); } catch (_) {} };
const saveModappSessions = () => { try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(modappSessions), null, 2)); } catch (_) {} };
const saveModappSubmissions = () => { try { fs.writeFileSync(SUBMISSIONS_FILE, JSON.stringify(modappSubmissions.slice(0, 100), null, 2)); } catch (_) {} };
const TICKET_SUMMARIES_FILE = path.join(DATA_DIR, 'ticket_summaries.json');
const closedTickets = new Map(Object.entries(loadJson(TICKET_SUMMARIES_FILE, {})));
const saveClosedTickets = () => { try { fs.writeFileSync(TICKET_SUMMARIES_FILE, JSON.stringify(Object.fromEntries(closedTickets), null, 2)); } catch (_) {} };

if (!DISCORD_TOKEN || !GROQ_API_KEY) {
  console.error('Missing DISCORD_BOT_TOKEN or GROQ_API_KEY.');
  process.exit(1);
}

const scrub  = createScrubber([GROQ_API_KEY, DISCORD_TOKEN]);
const clean  = (text) => scrub(neutralizeMentions(text));
const NO_PINGS = { parse: [], repliedUser: false };

const ai = createAI({
  apiKeys:     [GROQ_API_KEY, ...GROQ_API_KEYS_EXTRA],
  baseUrl:     env('GROQ_BASE_URL') || 'https://api.groq.com/openai',
  model:       'openai/gpt-oss-20b',
  scrub,
});

const mod     = createMod({ ownerId: OWNER_ID, clean, noPings: NO_PINGS });
const builder = createBuilder({ ai, ownerId: OWNER_ID, clean });

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

let automodEnabled = false;
let welcomeEnabled = false;
let aiMemoryEnabled = true;
const warnings = new Map();

// ── helpers ───────────────────────────────────────────────────────────────────
async function chatReply(key, userText, userId, att) {
  const history = memory.get(key) || [];
  let promptText = buildPromptText(String(userText || '').slice(0, 4000), att);
  const images = att ? att.images : [];
  if (!promptText) promptText = images.length ? 'Describe this image.' : 'hi';

  const userMsg = { role: 'user', content: promptText };
  const messages = [{ role: 'system', content: systemFor(userId) }, ...(aiMemoryEnabled ? history : []), userMsg];

  const { text: answer } = await ai.chat(messages, { maxTokens: 2000 });
  if (aiMemoryEnabled) {
    remember(key, 'user', promptText.slice(0, 8000));
    remember(key, 'assistant', answer);
  }
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
    .setName('build')
    .setDescription('Tell the AI to build or change channels, categories and more (shows a plan to confirm)')
    .setDMPermission(false)
    .addStringOption((o) => o.setName('request').setDescription('e.g. build a gaming server with voice channels').setRequired(true).setMaxLength(3000))
    .addUserOption((o) => o.setName('user').setDescription('Optional user to include (for ban/role requests)')),

  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Clear my memory of our conversation here'),

  new SlashCommandBuilder()
    .setName('modapp')
    .setDescription('Get the link to the SinfulTpAi staff application form'),
];

// ── command handler ───────────────────────────────────────────────────────────
async function handle(i) {
  const name = i.commandName;

  if (!i.inGuild() && ['ask', 'translate', 'summarize', 'roast', 'explain', 'luau', 'fixcode'].includes(name)) {
    return i.reply({ content: 'AI commands are disabled in DMs.', ...EPHEMERAL });
  }

  // ── /reset ──────────────────────────────────────────────────────────────────
  if (name === 'reset') {
    memory.delete(memKey(i.channelId, i.user.id));
    return i.reply({ content: '🧹 Memory cleared.', ...EPHEMERAL });
  }

  // ── /modapp ───────────────────────────────────────────────────────────────────
  if (name === 'modapp') {
    if (!MODAPP_URL) {
      return i.reply({ content: 'Set `MODAPP_URL` in the bot environment to your staff application form URL.', ...EPHEMERAL });
    }
    return i.reply({ content: `Apply for SinfulTpAi staff here: ${MODAPP_URL}` });
  }

  // ── /build ──────────────────────────────────────────────────────────────────
  if (name === 'build') {
    if (!i.inGuild() || !i.guild) return i.reply({ content: 'Use this inside a server.', ...EPHEMERAL });
    if (!builder.canBuild(i.member)) return i.reply({ content: 'You need the Manage Channels permission to use this.', ...EPHEMERAL });
    const wait = cooldown(i.user.id, 'build', 8000);
    if (wait) return i.reply({ content: `Slow down — try again in ${wait}s.`, ...EPHEMERAL });
    await i.deferReply();
    let text = i.options.getString('request', true);
    const target = i.options.getUser('user');
    if (target) text += ` <@${target.id}>`;
    const result = await builder.plan({ guild: i.guild, text });
    if (!result) return i.editReply({ content: "I couldn't turn that into server actions. Try being more specific." });
    return i.editReply(builder.preview(result, { userId: i.user.id, guildId: i.guildId }));
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

async function handleModappButton(i) {
  const member = i.member;
  const isStaff =
    i.user.id === OWNER_ID ||
    member?.permissions?.has(P.ManageGuild) ||
    (MODAPP_STAFF_ROLE_ID && member?.roles?.cache?.has(MODAPP_STAFF_ROLE_ID));

  if (!isStaff) {
    return i.reply({ content: 'Only staff can review applications.', ...EPHEMERAL });
  }

  const accepted = i.customId === 'modapp_accept';
  const embed = EmbedBuilder.from(i.message.embeds[0]);
  embed
    .setColor(accepted ? 0x22c55e : 0xef4444)
    .setTitle(accepted ? '✅ Staff Application Accepted' : '❌ Staff Application Declined')
    .addFields({ name: 'Reviewed by', value: `<@${i.user.id}>`, inline: true });

  await i.update({ embeds: [embed], components: [] });
}

async function handleTicketOpen(i) {
  try {
    if (!i.inGuild() || !i.guild) return i.reply({ content: 'Use this inside a server.', ...EPHEMERAL });
    const guild = i.guild;
    const member = i.member || (await guild.members.fetch(i.user.id).catch(() => null));
    if (!member) return i.reply({ content: 'Could not read your server permissions.', ...EPHEMERAL });

    const existing = openTickets.get(i.user.id);
    if (existing) {
      const ch = guild.channels.cache.get(existing);
      if (ch) return i.reply({ content: `You already have a ticket open: <#${existing}>`, ...EPHEMERAL });
      openTickets.delete(i.user.id);
    }

    const me = guild.members.me;
    if (!me?.permissions.has(P.ManageChannels)) {
      return i.reply({ content: 'I need Manage Channels to create tickets.', ...EPHEMERAL });
    }

    const safeName = (member.user.username || 'user').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 20) || 'user';
    const channel = await guild.channels.create({
      name: `ticket-${safeName}`,
      type: ChannelType.GuildText,
      parent: i.channel?.parentId || null,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
        { id: i.user.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] },
        { id: me.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] },
      ],
      reason: `Ticket opened by ${i.user.username}`,
    });

    for (const supportId of TICKET_SUPPORT_IDS) {
      try {
        const role = guild.roles.cache.get(supportId);
        await channel.permissionOverwrites.edit(role || supportId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
      } catch (_) {}
    }

    openTickets.set(i.user.id, channel.id);
    ticketMeta.set(channel.id, { ownerId: i.user.id, openedAt: Date.now() });

    const embed = new EmbedBuilder()
      .setColor(0xec4899)
      .setTitle(`Ticket — ${member.user.username}`)
      .setDescription(`Welcome <@${i.user.id}>! Staff will be here shortly.\n\n<@&1555981671973781634> <@&1555957115728826408> <@&1555972937595617280>`)
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket_claim').setLabel('Claim Ticket').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger),
    );

    await channel.send({ embeds: [embed], components: [row], allowedMentions: NO_PINGS });
    await i.reply({ content: `Ticket created: <#${channel.id}>`, ...EPHEMERAL });
  } catch (e) {
    await i.reply({ content: `Could not create ticket: ${clean(e?.message ?? 'unknown error').slice(0, 300)}`, ...EPHEMERAL }).catch(() => {});
  }
}

async function handleTicketClaim(i) {
  try {
    const meta = ticketMeta.get(i.channelId);
    if (!meta) return i.reply({ content: 'That is not a ticket channel.', ...EPHEMERAL });
    if (meta.claimedBy && meta.claimedBy !== i.user.id) return i.reply({ content: `Already claimed by <@${meta.claimedBy}>.`, ...EPHEMERAL });
    meta.claimedBy = i.user.id;
    ticketMeta.set(i.channelId, meta);
    await i.reply({ content: `You have claimed this ticket. Please <@${meta.ownerId}>.`, allowedMentions: NO_PINGS });
  } catch (e) {
    await i.reply({ content: `Could not claim ticket: ${clean(e?.message ?? 'unknown error').slice(0, 300)}`, ...EPHEMERAL }).catch(() => {});
  }
}

async function handleTicketClose(i) {
  try {
    const channel = i.channel;
    const meta = ticketMeta.get(channel.id);
    if (!meta) return i.reply({ content: 'That is not a ticket channel.', ...EPHEMERAL });

    const isSupport = TICKET_SUPPORT_IDS.includes(i.user.id) || (i.member?.permissions?.has(P.ManageChannels) ?? false) || i.user.id === OWNER_ID;
    if (i.user.id !== meta.ownerId && !isSupport) {
      return i.reply({ content: 'Only the ticket owner or support can close this.', ...EPHEMERAL });
    }

    const fetched = await channel.messages.fetch({ limit: 100 }).catch(() => new Map());
    const messages = [...fetched.values()].reverse().map((m) => ({
      time: new Date(m.createdTimestamp).toISOString(),
      author: m.author ? m.author.username : 'Unknown',
      avatar: m.author?.displayAvatarURL?.({ size: 64 }) || '',
      content: m.content || '',
      attachments: [...m.attachments.values()].map((a) => ({ url: a.url, name: a.name, contentType: a.contentType || '' })),
      embeds: m.embeds.map((e) => ({ title: e.title, description: e.description, url: e.url })),
    }));

    const hash = require('crypto').createHash('sha256').update(channel.id).digest('hex').slice(0, 16);
    const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const attachmentHtml = (a) => {
      const url = esc(a.url);
      const name = esc(a.name || a.url);
      if (/\.(png|jpe?g|gif|webp)$/i.test(a.name || a.url)) return `<img src="${url}" alt="${name}" style="max-width:100%;border-radius:8px;margin-top:8px">`;
      if (/\.(mp4|webm|mov)$/i.test(a.name || a.url)) return `<video controls src="${url}" style="max-width:100%;border-radius:8px;margin-top:8px"></video>`;
      if (/\.(mp3|wav|ogg|m4a)$/i.test(a.name || a.url)) return `<audio controls src="${url}" style="margin-top:8px"></audio>`;
      return `<a href="${url}" target="_blank">${name}</a>`;
    };
    const html = `<!doctype html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Ticket ${hash}</title><style>body{background:#0f0f16;color:#fff;font-family:system-ui;padding:2rem}.msg{display:flex;gap:12px;padding:12px 0;border-bottom:1px solid #2a2a3d}.avatar{width:40px;height:40px;border-radius:50%}.name{font-weight:800;color:#a78bfa}.time{color:#888;font-size:12px;margin-left:6px}.bubble{background:#171724;border:1px solid #2a2a3d;border-radius:12px;padding:10px 14px;margin-top:4px;max-width:70%}</style></head>
<body>
<h1>Ticket ${hash}</h1>
<p>Owner: ${esc(meta.ownerId)}<br>Closed by: ${esc(i.user.id)}<br>Opened: ${esc(new Date(meta.openedAt).toISOString())}</p>
<h2>Messages</h2>
${messages.map((m) => `<div class="msg"><img class="avatar" src="${esc(m.avatar)}" alt=""><div><span class="name">${esc(m.author)}</span><span class="time">${esc(m.time)}</span><div class="bubble">${esc(m.content).replace(/\n/g, '<br>') || '<i>[no text]</i>'}${m.attachments.map(attachmentHtml).join('')}${m.embeds.map((e) => `<div style="margin-top:8px;border-left:3px solid #ec4899;padding-left:8px"><b>${esc(e.title || '')}</b><br>${esc(e.description || '')}</div>`).join('')}</div></div></div>`).join('') || '<p>No messages.</p>'}
</body>
</html>`;

    closedTickets.set(hash, {
      time: new Date().toISOString(),
      ownerId: meta.ownerId,
      closedBy: i.user.id,
      messages,
      html,
    });
    saveClosedTickets();

    await i.reply({ content: `Ticket closed. Summary: https://sinfultpai.up.railway.app/ticket-${hash}`, allowedMentions: NO_PINGS });

    openTickets.delete(meta.ownerId);
    ticketMeta.delete(channel.id);

    setTimeout(() => channel.delete(`Ticket closed by ${i.user.username}`).catch(() => {}), 5000);
  } catch (e) {
    await i.reply({ content: `Could not close ticket: ${clean(e?.message ?? 'unknown error').slice(0, 300)}`, ...EPHEMERAL }).catch(() => {});
  }
}

async function handleReactionRole(i) {
  try {
    const roleId = i.customId.slice(3);
    const role = i.guild?.roles.cache.get(roleId);
    if (!role) return i.reply({ content: 'Role not found.', ...EPHEMERAL });
    const member = i.member || (await i.guild.members.fetch(i.user.id).catch(() => null));
    if (!member) return i.reply({ content: 'Could not read your server permissions.', ...EPHEMERAL });
    if (member.roles.cache.has(roleId)) {
      await member.roles.remove(roleId);
      return i.reply({ content: `Removed **${role.name}**.`, ...EPHEMERAL });
    }
    await member.roles.add(roleId);
    return i.reply({ content: `Added **${role.name}**.`, ...EPHEMERAL });
  } catch (e) {
    await i.reply({ content: `Could not update role: ${clean(e?.message ?? 'unknown error').slice(0, 300)}`, ...EPHEMERAL }).catch(() => {});
  }
}

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isButton()) {
      if (i.customId === 'modapp_accept' || i.customId === 'modapp_decline') {
        await handleModappButton(i);
        return;
      }
      if (i.customId === 'ticket_open') {
        await handleTicketOpen(i);
        return;
      }
      if (i.customId === 'ticket_claim') {
        await handleTicketClaim(i);
        return;
      }
      if (i.customId.startsWith('rr_')) {
        await handleReactionRole(i);
        return;
      }
      if (i.customId === 'ticket_close') {
        await handleTicketClose(i);
        return;
      }
      await builder.handleButton(i);
      return;
    }
    if (!i.isChatInputCommand()) return;
    await handle(i);
  } catch (e) {
    console.error('[interaction error]', i.commandName || i.customId, scrub(e?.message ?? e));
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
        '`/modapp` — get the staff application form link',
        '`.help` — show this menu',
        '',
        '**Moderation (prefix `?`)**',
        '`?ban @user [reason]` • `?unban id` • `?kick @user [reason]`',
        '`?to @user [10m|2h|1d] [reason]` — timeout • `?untimeout @user`',
        '`?lock` / `?unlock` — lock or unlock the channel you use it in',
        '',
        '**Role creation**',
        '`.createrole <role name> <perms>` — create a role with `all`, `admin`, or `none` permissions',
        '`.giverole <user> <role name>` — give a role to a user',
        '`.leaderboard` / `.invites` — show who has the most invites',
        '`.slowmodeOn` / `.slowmodeOff` — set 5s slowmode or turn it off',
        '`.purge <1-100>` — delete recent messages in this channel',
        '`.verifypanel` — send the verification panel (owner only)',
        '`.forceverify @user` / `.unverify @user` — manage verification (owner only)',
        '`.ticketpanel` — send a ticket panel for help/support',
        '`.deleteticket` / `.deleteticket #channel` — delete a ticket channel',
        '`.servermembers` — show how many members are in the server',
        '',
        '**AI server builder**',
        '`?build <what you want>` or `/build` — I make a plan, you press Run it',
        'Roles, permissions, bans and kicks through the AI are owner-only.',
      ].join('\n'),
    )
    .setFooter({ text: 'sinfultp ai' });
}

const BUILD_HINT =
  /\b(creat|make|build|set\s?up|add|delet|remov|renam|mov|edit|chang|organi[sz]|revamp|give|grant|assign|lock)\w*\b[\s\S]*\b(channels?|categor(y|ies)|server|roles?|perms?|permissions?|vc|voice)\b|\b(ban|kick|time\s?out)\b\s*<@!?\d+>/i;

// Plans a server change from plain text and shows the confirm buttons.
// With fallback=true (mention flow) it stays quiet and returns false so normal chat can answer.
async function runBuild(m, text, fallback) {
  const member = m.member || (await m.guild.members.fetch(m.author.id).catch(() => null));
  if (!builder.canBuild(member)) {
    if (!fallback) await m.reply({ content: 'You need the Manage Channels permission to use `?build`.', allowedMentions: NO_PINGS });
    return false;
  }
  if (!text.trim()) {
    if (!fallback) await m.reply({ content: 'Tell me what to build, e.g. `?build a gaming server with voice channels`.', allowedMentions: NO_PINGS });
    return false;
  }
  const wait = cooldown(m.author.id, 'build', 8000);
  if (wait) {
    if (!fallback) await m.reply({ content: `Slow down — try again in ${wait}s.`, allowedMentions: NO_PINGS });
    return false;
  }
  await m.channel.sendTyping();
  const result = await builder.plan({ guild: m.guild, text });
  if (!result) {
    if (!fallback) await m.reply({ content: "I couldn't turn that into server actions. Try being more specific.", allowedMentions: NO_PINGS });
    return false;
  }
  await m.reply(builder.preview(result, { userId: m.author.id, guildId: m.guildId }));
  return true;
}

client.on(Events.MessageCreate, async (m) => {
  try {
    if (m.author.bot) return;

    if (automodEnabled && m.guild && m.channel?.type !== ChannelType.DM) {
      const text = m.content || '';
      const looksLikeLink = /(https?:\/\/|www\.|discord\.gg|t\.me)/i.test(text);
      const looksLikeSpam = /(.)\1{9,}/.test(text);
      if (looksLikeLink || looksLikeSpam) {
        await m.delete().catch(() => {});
        const msg = await m.channel.send({ content: `⚠️ ${m.author} do not post links or spam.`, allowedMentions: NO_PINGS }).catch(() => null);
        if (msg) setTimeout(() => msg.delete().catch(() => {}), 5000);
        return;
      }
    }

    if (/^[.?]help\s*$/i.test(m.content.trim())) {
      await m.reply({ embeds: [helpEmbed()], allowedMentions: NO_PINGS });
      return;
    }

    // ── .createrole: create a role with a permission preset ──
    if (m.guild && /^\.createrole\b/i.test(m.content.trim())) {
      const rest = m.content.trim().replace(/^\.createrole\b/i, '').trim();
      const parts = rest.split(/\s+/).filter(Boolean);
      if (parts.length < 2) {
        await m.reply({ content: 'Usage: `.createrole <role name> <perms> all|admin|none`', allowedMentions: NO_PINGS });
        return;
      }
      const permKind = parts.pop().toLowerCase();
      const roleName = parts.join(' ').trim();
      if (!roleName || roleName.length > 100) {
        await m.reply({ content: 'Role name must be 1–100 characters.', allowedMentions: NO_PINGS });
        return;
      }
      if (!['all', 'admin', 'none'].includes(permKind)) {
        await m.reply({ content: 'Perms must be `all`, `admin`, or `none`.', allowedMentions: NO_PINGS });
        return;
      }

      const member = m.member || (await m.guild.members.fetch(m.author.id).catch(() => null));
      if (!member) {
        await m.reply({ content: 'Could not read your server permissions.', allowedMentions: NO_PINGS });
        return;
      }
      const canManage = m.author.id === OWNER_ID || m.author.id === m.guild.ownerId || member.permissions.has(P.ManageRoles);
      if (!canManage) {
        await m.reply({ content: 'You need the Manage Roles permission to create roles.', allowedMentions: NO_PINGS });
        return;
      }
      const me = m.guild.members.me;
      if (!me?.permissions.has(P.ManageRoles)) {
        await m.reply({ content: "I need the Manage Roles permission to do that.", allowedMentions: NO_PINGS });
        return;
      }

      let permissions;
      if (permKind === 'none') permissions = [];
      else if (permKind === 'admin') permissions = [P.Administrator];
      else permissions = Object.values(P).filter((v) => typeof v === 'bigint');

      try {
        const role = await m.guild.roles.create({
          name: roleName,
          permissions,
          reason: `${m.author.username}: .createrole ${roleName} (${permKind})`,
        });
        await m.reply({ content: `Created role **${role.name}** with \`${permKind}\` permissions.`, allowedMentions: NO_PINGS });
      } catch (e) {
        await m.reply({ content: `Could not create that role: ${clean(e?.message ?? 'unknown error').slice(0, 300)}`, allowedMentions: NO_PINGS });
      }
      return;
    }

    // ── .leaderboard / .invites: top inviters ──
    if (m.guild && /^\.(leaderboard|invites)\b/i.test(m.content.trim())) {
      try {
        const invites = await m.guild.invites.fetch();
        const counts = new Map();
        for (const invite of invites.values()) {
          const inviter = invite.inviter;
          if (!inviter) continue;
          const key = inviter.id;
          const prev = counts.get(key) || { user: inviter, uses: 0, invites: 0 };
          prev.uses += invite.uses ?? 0;
          prev.invites += 1;
          counts.set(key, prev);
        }
        const top = [...counts.values()].sort((a, b) => b.uses - a.uses).slice(0, 10);
        if (!top.length) {
          return m.reply({ content: 'No invite data found yet.', allowedMentions: NO_PINGS });
        }
        const lines = top.map((entry, index) => `**${index + 1}.** ${entry.user.username} — ${entry.uses} invite${entry.uses === 1 ? '' : 's'} (${entry.invites} link${entry.invites === 1 ? '' : 's'})`);
        return m.reply({ content: `🏆 **Invite Leaderboard**\n${lines.join('\n')}`, allowedMentions: NO_PINGS });
      } catch (e) {
        return m.reply({ content: `I could not fetch invites. I may need Manage Server permission. (${clean(e?.message ?? 'unknown error').slice(0, 120)})`, allowedMentions: NO_PINGS });
      }
    }

    // ── .giverole <user> <role name> ──
    if (m.guild && /^\.giverole\b/i.test(m.content.trim())) {
      const rest = m.content.trim().replace(/^\.giverole\b/i, '').trim();
      const match = /^<@!?(\d{17,20})>\s+(.+)$|^(\d{17,20})\s+(.+)$/.exec(rest);
      if (!match) {
        return m.reply({ content: 'Usage: `.giverole <user> <role name>`', allowedMentions: NO_PINGS });
      }
      const userId = match[1] || match[3];
      const roleName = (match[2] || match[4] || '').trim();
      if (!roleName) return m.reply({ content: 'Usage: `.giverole <user> <role name>`', allowedMentions: NO_PINGS });

      const member = m.member || (await m.guild.members.fetch(m.author.id).catch(() => null));
      if (!member) return m.reply({ content: 'Could not read your server permissions.', allowedMentions: NO_PINGS });
      const canManage = m.author.id === OWNER_ID || m.author.id === m.guild.ownerId || member.permissions.has(P.ManageRoles);
      if (!canManage) return m.reply({ content: 'You need the Manage Roles permission to give roles.', allowedMentions: NO_PINGS });

      const target = await m.guild.members.fetch(userId).catch(() => null);
      if (!target) return m.reply({ content: 'That user is not in this server.', allowedMentions: NO_PINGS });

      const role = m.guild.roles.cache.find((r) => r.name.toLowerCase() === roleName.toLowerCase());
      if (!role) return m.reply({ content: `I could not find a role named **${roleName}**.`, allowedMentions: NO_PINGS });

      const me = m.guild.members.me;
      if (!me?.permissions.has(P.ManageRoles)) return m.reply({ content: 'I need the Manage Roles permission for that.', allowedMentions: NO_PINGS });
      if (me.roles.highest.comparePositionTo(role) <= 0) return m.reply({ content: "That role is above my highest role. Move my role higher.", allowedMentions: NO_PINGS });

      try {
        await target.roles.add(role, `${m.author.username}: .giverole ${target.user.username} ${role.name}`);
        return m.reply({ content: `Gave **${role.name}** to **${target.user.username}**.`, allowedMentions: NO_PINGS });
      } catch (e) {
        return m.reply({ content: `Could not give that role: ${clean(e?.message ?? 'unknown error').slice(0, 300)}`, allowedMentions: NO_PINGS });
      }
    }

    // ── .purge <message count> ──
    if (m.guild && /^\.purge\b/i.test(m.content.trim())) {
      const amountText = m.content.trim().split(/\s+/)[1];
      const amount = Number(amountText);
      if (!Number.isInteger(amount) || amount < 1 || amount > 100) {
        return m.reply({ content: 'Usage: `.purge <1-100>`', allowedMentions: NO_PINGS });
      }
      const member = m.member || (await m.guild.members.fetch(m.author.id).catch(() => null));
      if (!member) return m.reply({ content: 'Could not read your server permissions.', allowedMentions: NO_PINGS });
      const canManage = m.author.id === OWNER_ID || m.author.id === m.guild.ownerId || member.permissions.has(P.ManageMessages);
      if (!canManage) return m.reply({ content: 'You need the Manage Messages permission to purge.', allowedMentions: NO_PINGS });
      if (typeof m.channel.bulkDelete !== 'function') return m.reply({ content: 'I can only purge in a normal text channel.', allowedMentions: NO_PINGS });
      try {
        await m.channel.bulkDelete(amount, true);
        const msg = await m.channel.send({ content: `🧹 Deleted ${amount} message${amount === 1 ? '' : 's'}.`, allowedMentions: NO_PINGS });
        setTimeout(() => msg.delete().catch(() => {}), 5000);
        return;
      } catch (e) {
        return m.reply({ content: `Could not purge: ${clean(e?.message ?? 'unknown error').slice(0, 300)}`, allowedMentions: NO_PINGS });
      }
    }

    // ── .slowmodeOn / .slowmodeOff ──
    if (m.guild && /^\.(slowmodeon|slowmodeoff)\b/i.test(m.content.trim())) {
      const cmd = m.content.trim().split(/\s+/)[0].slice(1).toLowerCase();
      const member = m.member || (await m.guild.members.fetch(m.author.id).catch(() => null));
      if (!member) return m.reply({ content: 'Could not read your server permissions.', allowedMentions: NO_PINGS });
      const canManage = m.author.id === OWNER_ID || m.author.id === m.guild.ownerId || member.permissions.has(P.ManageChannels);
      if (!canManage) return m.reply({ content: 'You need the Manage Channels permission to change slowmode.', allowedMentions: NO_PINGS });

      const ch = m.channel;
      if (typeof ch.setRateLimitPerUser !== 'function') {
        return m.reply({ content: 'I can only set slowmode in a text channel.', allowedMentions: NO_PINGS });
      }

      try {
        if (cmd === 'slowmodeon') {
          await ch.setRateLimitPerUser(5, `${m.author.username}: .slowmodeOn`);
          return m.reply({ content: '🐢 Slowmode is on: 5 seconds.', allowedMentions: NO_PINGS });
        }
        await ch.setRateLimitPerUser(0, `${m.author.username}: .slowmodeOff`);
        return m.reply({ content: '🐇 Slowmode is off.', allowedMentions: NO_PINGS });
      } catch (e) {
        return m.reply({ content: `Could not change slowmode: ${clean(e?.message ?? 'unknown error').slice(0, 300)}`, allowedMentions: NO_PINGS });
      }
    }

    // ── .verifypanel / .forceverify / .unverify ──
    if (m.guild && /^\.(verifypanel|forceverify|unverify)\b/i.test(m.content.trim())) {
      const cmd = m.content.trim().split(/\s+/)[0].slice(1).toLowerCase();
      if (m.author.id !== OWNER_ID) {
        return m.reply({ content: 'Only fowascend can use that.', allowedMentions: NO_PINGS });
      }

      if (cmd === 'verifypanel') {
        const channel = await m.guild.channels.fetch(VERIFY_CHANNEL_ID).catch(() => null);
        if (!channel) return m.reply({ content: 'Verification channel is missing.', allowedMentions: NO_PINGS });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel('Verify').setStyle(ButtonStyle.Link).setURL('https://sinfultpai.up.railway.app/verify'),
        );
        const embed = new EmbedBuilder()
          .setColor(0xec4899)
          .setTitle('Server Verification')
          .setDescription('Click the button below to verify and unlock the server.')
          .setTimestamp();
        await channel.send({ embeds: [embed], components: [row], allowedMentions: NO_PINGS });
        await hideUnverifiedChannels(m.guild).catch(() => {});
        return m.reply({ content: 'Verification panel sent and channel permissions updated.', allowedMentions: NO_PINGS });
      }

      const id = parseTarget(m.content.trim().split(/\s+/)[1] || '');
      if (!id) return m.reply({ content: `Usage: \`?${cmd} @user\``, allowedMentions: NO_PINGS });
      const member = await m.guild.members.fetch(id).catch(() => null);
      if (!member) return m.reply({ content: 'That user is not in this server.', allowedMentions: NO_PINGS });

      if (cmd === 'forceverify') {
        await member.roles.add(VERIFY_ROLE_ID, `${m.author.username}: .forceverify`);
        verifications.set(id, {
          discordUsername: member.user.username,
          discordId: id,
          email: '',
          verified: null,
          ip: '',
          age: '',
          verifiedAt: new Date().toISOString(),
        });
        saveVerifications();
        return m.reply({ content: `Force verified **${member.user.username}**.`, allowedMentions: NO_PINGS });
      }

      await member.roles.remove(VERIFY_ROLE_ID, `${m.author.username}: .unverify`);
      verifications.delete(id);
      saveVerifications();
      return m.reply({ content: `Removed verification from **${member.user.username}**.`, allowedMentions: NO_PINGS });
    }

    // ── .claim / .close (in ticket channels) ──
    if (m.guild && /^\.(claim|close)\b/i.test(m.content.trim())) {
      const cmd = m.content.trim().split(/\s+/)[0].slice(1).toLowerCase();
      if (!m.channel?.name?.startsWith('ticket-')) {
        return m.reply({ content: 'Run this inside a ticket channel.', allowedMentions: NO_PINGS });
      }
      if (cmd === 'claim') {
        const meta = ticketMeta.get(m.channel.id);
        if (!meta) return m.reply({ content: 'That is not a ticket channel.', allowedMentions: NO_PINGS });
        meta.claimedBy = m.author.id;
        ticketMeta.set(m.channel.id, meta);
        return m.reply({ content: `You have claimed this ticket, <@${meta.ownerId}>.`, allowedMentions: NO_PINGS });
      }
      const meta = ticketMeta.get(m.channel.id);
      if (!meta) return m.reply({ content: 'That is not a ticket channel.', allowedMentions: NO_PINGS });
      const isSupport = TICKET_SUPPORT_IDS.includes(m.author.id) || m.author.id === OWNER_ID;
      if (m.author.id !== meta.ownerId && !isSupport) return m.reply({ content: 'Only the ticket owner or support can close this.', allowedMentions: NO_PINGS });
      const fetched = await m.channel.messages.fetch({ limit: 100 }).catch(() => new Map());
      const messages = [...fetched.values()].reverse().map((m) => ({
        time: new Date(m.createdTimestamp).toISOString(),
        author: m.author ? m.author.username : 'Unknown',
        avatar: m.author?.displayAvatarURL?.({ size: 64 }) || '',
        content: m.content || '',
        attachments: [...m.attachments.values()].map((a) => ({ url: a.url, name: a.name, contentType: a.contentType || '' })),
        embeds: m.embeds.map((e) => ({ title: e.title, description: e.description, url: e.url })),
      }));
      const hash = require('crypto').createHash('sha256').update(m.channel.id).digest('hex').slice(0, 16);
      const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const attachmentHtml = (a) => {
        const url = esc(a.url);
        const name = esc(a.name || a.url);
        if (/\.(png|jpe?g|gif|webp)$/i.test(a.name || a.url)) return `<img src="${url}" alt="${name}" style="max-width:100%;border-radius:8px;margin-top:8px">`;
        if (/\.(mp4|webm|mov)$/i.test(a.name || a.url)) return `<video controls src="${url}" style="max-width:100%;border-radius:8px;margin-top:8px"></video>`;
        if (/\.(mp3|wav|ogg|m4a)$/i.test(a.name || a.url)) return `<audio controls src="${url}" style="margin-top:8px"></audio>`;
        return `<a href="${url}" target="_blank">${name}</a>`;
      };
      const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Ticket ${hash}</title><style>body{background:#0f0f16;color:#fff;font-family:system-ui;padding:2rem}.msg{display:flex;gap:12px;padding:12px 0;border-bottom:1px solid #2a2a3d}.avatar{width:40px;height:40px;border-radius:50%}.name{font-weight:800;color:#a78bfa}.time{color:#888;font-size:12px;margin-left:6px}.bubble{background:#171724;border:1px solid #2a2a3d;border-radius:12px;padding:10px 14px;margin-top:4px;max-width:70%}</style></head><body><h1>Ticket ${hash}</h1><p>Owner: ${esc(meta.ownerId)}<br>Closed by: ${esc(m.author.id)}<br>Opened: ${esc(new Date(meta.openedAt).toISOString())}</p><h2>Messages</h2>${messages.map((m) => `<div class="msg"><img class="avatar" src="${esc(m.avatar)}" alt=""><div><span class="name">${esc(m.author)}</span><span class="time">${esc(m.time)}</span><div class="bubble">${esc(m.content).replace(/\n/g, '<br>') || '<i>[no text]</i>'}${m.attachments.map(attachmentHtml).join('')}${m.embeds.map((e) => `<div style="margin-top:8px;border-left:3px solid #ec4899;padding-left:8px"><b>${esc(e.title || '')}</b><br>${esc(e.description || '')}</div>`).join('')}</div></div></div>`).join('') || '<p>No messages.</p>'}</body></html>`;
      closedTickets.set(hash, { time: new Date().toISOString(), ownerId: meta.ownerId, closedBy: m.author.id, messages, html });
      saveClosedTickets();
      await m.reply({ content: `Ticket closed. Summary: https://sinfultpai.up.railway.app/ticket-${hash}`, allowedMentions: NO_PINGS });
      openTickets.delete(meta.ownerId);
      ticketMeta.delete(m.channel.id);
      setTimeout(() => m.channel.delete(`Ticket closed by ${m.author.username}`).catch(() => {}), 5000);
      return;
    }

    // ── .deleteticket ──
    if (m.guild && /^\.deleteticket\b/i.test(m.content.trim())) {
      const member = m.member || (await m.guild.members.fetch(m.author.id).catch(() => null));
      if (!member) return m.reply({ content: 'Could not read your server permissions.', allowedMentions: NO_PINGS });
      const TICKET_DELETE_IDS = ['1555957115728826408', '1555972937595617280', '1555972804648898650'];
      if (!TICKET_DELETE_IDS.includes(m.author.id)) {
        return m.reply({ content: 'Only these IDs can use `.deleteticket`.', allowedMentions: NO_PINGS });
      }

      let channel = null;
      const arg = m.content.trim().split(/\s+/)[1];
      if (arg) {
        const id = arg.replace(/[<#>]/g, '');
        channel = m.guild.channels.cache.get(id) || null;
      } else if (m.channel?.name?.startsWith('ticket-')) {
        channel = m.channel;
      }

      if (!channel || !channel.name.startsWith('ticket-')) {
        return m.reply({ content: 'Run this inside a ticket channel, or use `.deleteticket #channel`.', allowedMentions: NO_PINGS });
      }

      try {
        await channel.delete(`Ticket deleted by ${m.author.username}`);
        const meta = ticketMeta.get(channel.id);
        if (meta) openTickets.delete(meta.ownerId);
        ticketMeta.delete(channel.id);
        return;
      } catch (e) {
        return m.reply({ content: `Could not delete ticket: ${clean(e?.message ?? 'unknown error').slice(0, 300)}`, allowedMentions: NO_PINGS });
      }
    }

    // ── .ticketpanel ──
    if (m.guild && /^\.ticketpanel\b/i.test(m.content.trim())) {
      const member = m.member || (await m.guild.members.fetch(m.author.id).catch(() => null));
      if (!member) return m.reply({ content: 'Could not read your server permissions.', allowedMentions: NO_PINGS });
      const canManage = m.author.id === OWNER_ID || m.author.id === m.guild.ownerId || member.permissions.has(P.ManageChannels);
      if (!canManage) return m.reply({ content: 'You need the Manage Channels permission to use `.ticketpanel`.', allowedMentions: NO_PINGS });

      const embed = new EmbedBuilder()
        .setColor(0xec4899)
        .setTitle('Need Help or Support?')
        .setDescription('Press the button below to open a support ticket. A private channel will be created for you.')
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket_open').setLabel('Open Ticket').setStyle(ButtonStyle.Primary),
      );

      await m.channel.send({ embeds: [embed], components: [row], allowedMentions: NO_PINGS });
      return;
    }

    // ── .servermembers ──
    if (m.guild && /^\.servermembers\b/i.test(m.content.trim())) {
      const embed = new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setTitle('Server Members')
        .setDescription(`👥 **${m.guild.memberCount}** members in ${m.guild.name}`)
        .setTimestamp();
      return m.reply({ embeds: [embed], allowedMentions: NO_PINGS });
    }

    // ── .afk / .userinfo ──
    if (m.guild && /^\.(afk|userinfo)\b/i.test(m.content.trim())) {
      const args = m.content.trim().split(/\s+/).slice(1);
      const id = args[0] ? (args[0].replace(/[<@!>]/g, '').match(/\d{17,20}/)?.[0]) : m.author.id;
      const member = id ? await m.guild.members.fetch(id).catch(() => null) : null;
      if (!member) return m.reply({ content: 'User not found.', allowedMentions: NO_PINGS });
      const roles = member.roles.cache.filter((r) => r.id !== m.guild.id).map((r) => r.name).slice(0, 10);
      const embed = new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setTitle(`${member.user.username}`)
        .addFields(
          { name: 'ID', value: member.id, inline: true },
          { name: 'Joined', value: member.joinedAt ? new Date(member.joinedAt).toLocaleString() : 'unknown', inline: true },
          { name: 'Roles', value: roles.join(', ') || 'none' },
          { name: 'Status', value: member.presence?.status || 'offline' },
        )
        .setTimestamp();
      return m.reply({ embeds: [embed], allowedMentions: NO_PINGS });
    }

    // ── .roleinfo <role> ──
    if (m.guild && /^\.roleinfo\b/i.test(m.content.trim())) {
      const roleName = m.content.trim().split(/\s+/).slice(1).join(' ');
      const role = m.guild.roles.cache.find((r) => r.name.toLowerCase() === roleName.toLowerCase()) || m.mentions.roles.first();
      if (!role) return m.reply({ content: 'Usage: `.roleinfo <role name>`', allowedMentions: NO_PINGS });
      const perms = role.permissions.toArray().slice(0, 10);
      const embed = new EmbedBuilder()
        .setColor(role.color || 0x8b5cf6)
        .setTitle(`Role: ${role.name}`)
        .addFields(
          { name: 'ID', value: role.id, inline: true },
          { name: 'Color', value: `#${role.color.toString(16).padStart(6, '0')}`, inline: true },
          { name: 'Members', value: String(role.members.size), inline: true },
          { name: 'Permissions', value: perms.join(', ') || 'none' },
        )
        .setTimestamp();
      return m.reply({ embeds: [embed], allowedMentions: NO_PINGS });
    }

    // ── .serverinfo ──
    if (m.guild && /^\.serverinfo\b/i.test(m.content.trim())) {
      const g = m.guild;
      const embed = new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setTitle(g.name)
        .addFields(
          { name: 'Owner', value: `<@${g.ownerId}>`, inline: true },
          { name: 'Members', value: String(g.memberCount), inline: true },
          { name: 'Boosts', value: String(g.premiumSubscriptionCount || 0), inline: true },
          { name: 'Channels', value: String(g.channels.cache.size), inline: true },
          { name: 'Roles', value: String(g.roles.cache.size), inline: true },
        )
        .setTimestamp();
      return m.reply({ embeds: [embed], allowedMentions: NO_PINGS });
    }

    // ── .warnings / .warn ──
    if (m.guild && /^\.(warnings|warn)\b/i.test(m.content.trim())) {
      const cmd = m.content.trim().split(/\s+/)[0].slice(1).toLowerCase();
      const args = m.content.trim().split(/\s+/).slice(1);
      const id = args[0] ? (args[0].replace(/[<@!>]/g, '').match(/\d{17,20}/)?.[0]) : m.author.id;
      if (!id) return m.reply({ content: `Usage: \`.${cmd} <user> [reason]\``, allowedMentions: NO_PINGS });
      if (cmd === 'warnings') {
        const list = warnings.get(id) || [];
        const text = list.length ? list.map((w, i) => `${i + 1}. ${w.reason} — ${new Date(w.at).toLocaleString()}`).join('\n') : 'No warnings.';
        return m.reply({ content: `⚠️ Warnings for <@${id}>:\n${text}`, allowedMentions: NO_PINGS });
      }
      const reason = args.slice(1).join(' ') || 'No reason';
      const list = warnings.get(id) || [];
      list.push({ reason, at: Date.now(), by: m.author.id });
      warnings.set(id, list);
      return m.reply({ content: `Warned <@${id}>: ${reason}`, allowedMentions: NO_PINGS });
    }

    // ── .suggest <text> ──
    if (m.guild && /^\.suggest\b/i.test(m.content.trim())) {
      const text = m.content.trim().split(/\s+/).slice(1).join(' ');
      if (!text) return m.reply({ content: 'Usage: `.suggest <text>`', allowedMentions: NO_PINGS });
      const channel = env('SUGGEST_CHANNEL_ID') ? m.guild.channels.cache.get(env('SUGGEST_CHANNEL_ID')) : m.channel;
      const embed = new EmbedBuilder().setColor(0xf59e0b).setTitle('Suggestion').setDescription(text.slice(0, 4000)).setFooter({ text: `From ${m.author.username}` });
      await (channel || m.channel).send({ embeds: [embed], allowedMentions: NO_PINGS });
      return m.reply({ content: 'Suggestion sent.', allowedMentions: NO_PINGS });
    }

    // ── .giveaway <time> <prize> ──
    if (m.guild && /^\.giveaway\b/i.test(m.content.trim())) {
      const args = m.content.trim().split(/\s+/).slice(1);
      const time = args[0];
      const prize = args.slice(1).join(' ');
      if (!time || !prize) return m.reply({ content: 'Usage: `.giveaway <10m|1h|1d> <prize>`', allowedMentions: NO_PINGS });
      const units = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
      const parsed = /(\d+)([smhd])/i.exec(time);
      if (!parsed) return m.reply({ content: 'Usage: `.giveaway <10m|1h|1d> <prize>`', allowedMentions: NO_PINGS });
      const ms = Number(parsed[1]) * units[parsed[2].toLowerCase()];
      const embed = new EmbedBuilder().setColor(0xec4899).setTitle('🎉 Giveaway').setDescription(`**${prize}**\nEnds in ${time}`).setFooter({ text: `Started by ${m.author.username}` });
      const msg = await m.reply({ embeds: [embed], fetchReply: true, allowedMentions: NO_PINGS });
      await msg.react('🎉').catch(() => {});
      setTimeout(async () => {
        const reactions = await msg.reactions.cache.get('🎉')?.fetch().catch(() => null);
        const users = reactions ? await reactions.users.fetch() : new Map();
        const candidates = [...users.values()].filter((u) => !u.bot);
        const winner = candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : null;
        await m.channel.send({ content: winner ? `🎉 Winner: ${winner}! Prize: **${prize}**` : 'No valid entries, no winner.', allowedMentions: NO_PINGS });
      }, ms);
      return;
    }

    // ── .remind <time> <message> ──
    if (m.guild && /^\.remind\b/i.test(m.content.trim())) {
      const args = m.content.trim().split(/\s+/).slice(1);
      const time = args[0];
      const message = args.slice(1).join(' ');
      if (!time || !message) return m.reply({ content: 'Usage: `.remind <10m|1h|1d> <message>`', allowedMentions: NO_PINGS });
      const units = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
      const parsed = /(\d+)([smhd])/i.exec(time);
      if (!parsed) return m.reply({ content: 'Usage: `.remind <10m|1h|1d> <message>`', allowedMentions: NO_PINGS });
      const ms = Number(parsed[1]) * units[parsed[2].toLowerCase()];
      await m.reply({ content: `Reminder set for ${time}.`, allowedMentions: NO_PINGS });
      setTimeout(() => m.author.send(`⏰ Reminder: ${message}`).catch(() => {}), ms);
      return;
    }

    // ── .reactionroles <role> ──
    if (m.guild && /^\.reactionroles\b/i.test(m.content.trim())) {
      const roleName = m.content.trim().split(/\s+/).slice(1).join(' ') || m.mentions.roles.first()?.name;
      const role = m.mentions.roles.first() || m.guild.roles.cache.find((r) => r.name.toLowerCase() === roleName.toLowerCase());
      if (!role) return m.reply({ content: 'Usage: `.reactionroles <role>`', allowedMentions: NO_PINGS });
      const embed = new EmbedBuilder().setColor(0x22c55e).setTitle('Reaction Role').setDescription(`Press the button to toggle **${role.name}**.`);
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`rr_${role.id}`).setLabel(role.name).setStyle(ButtonStyle.Primary));
      await m.channel.send({ embeds: [embed], components: [row], allowedMentions: NO_PINGS });
      return;
    }

    // ── .automod / .welcome / .ai-memory ──
    if (/^\.(automod|welcome|ai-memory)\b/i.test(m.content.trim())) {
      const cmd = m.content.trim().split(/\s+/)[0].slice(1).toLowerCase();
      const mode = m.content.trim().split(/\s+/)[1]?.toLowerCase();
      const set = (current) => mode === 'on' ? true : mode === 'off' ? false : !current;
      if (cmd === 'automod') automodEnabled = set(automodEnabled);
      if (cmd === 'welcome') welcomeEnabled = set(welcomeEnabled);
      if (cmd === 'ai-memory') aiMemoryEnabled = set(aiMemoryEnabled);
      return m.reply({ content: `${cmd}: ${ (cmd === 'automod' ? automodEnabled : cmd === 'welcome' ? welcomeEnabled : aiMemoryEnabled) ? 'on' : 'off' }`, allowedMentions: NO_PINGS });
    }

    // ── .music ──
    if (m.guild && /^\.music\b/i.test(m.content.trim())) {
      const args = m.content.trim().split(/\s+/).slice(1);
      const sub = (args[0] || 'help').toLowerCase();

      if (!voiceStuff || !ytdlCore) {
        return m.reply({ content: 'Music package is not installed. Run `npm install` first.', allowedMentions: NO_PINGS });
      }

      if (sub === 'stop' || sub === 'leave') {
        const conn = voiceStuff.getVoiceConnection(m.guild.id);
        if (conn) conn.destroy();
        return m.reply({ content: 'Stopped music and left voice.', allowedMentions: NO_PINGS });
      }

      const url = args[0];
      if (!url || sub === 'help') {
        return m.reply({ content: 'Usage: `.music <YouTube URL>` or `.music stop`', allowedMentions: NO_PINGS });
      }

      const member = m.member || (await m.guild.members.fetch(m.author.id).catch(() => null));
      const voiceChannel = member?.voice?.channel;
      if (!voiceChannel) return m.reply({ content: 'Join a voice channel first.', allowedMentions: NO_PINGS });

      try {
        const connection = voiceStuff.joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: m.guild.id,
          adapterCreator: m.guild.voiceAdapterCreator,
        });
        const player = voiceStuff.createAudioPlayer();
        const stream = ytdlCore(url, { filter: 'audioonly', highWaterMark: 1 << 25 });
        const resource = voiceStuff.createAudioResource(stream);
        player.play(resource);
        connection.subscribe(player);
        await voiceStuff.entersState(connection, voiceStuff.VoiceConnectionStatus.Ready, 20000).catch(() => {});
        return m.reply({ content: `🎵 Playing: ${url}`, allowedMentions: NO_PINGS });
      } catch (e) {
        return m.reply({ content: `Could not play music: ${clean(e?.message ?? 'unknown error').slice(0, 300)}`, allowedMentions: NO_PINGS });
      }
    }

    // ── dot aliases for moderation commands: .ban, .kick, .lock, etc. ──
    if (m.guild && /^\.(ban|unban|kick|to|timeout|mute|uto|unmute|untimeout|lock|unlock)\b/i.test(m.content.trim())) {
      const [rawCmd, ...rest] = m.content.trim().slice(1).split(/\s+/);
      const cmd = (rawCmd || '').toLowerCase();
      if (mod.has(cmd)) {
        await mod.run(m, cmd, rest);
        return;
      }
    }

    // ── ? prefix: moderation + AI builder ──
    if (m.guild && m.content.startsWith('?')) {
      const [rawCmd, ...rest] = m.content.slice(1).trim().split(/\s+/);
      const cmd = (rawCmd || '').toLowerCase();
      if (cmd === 'build') {
        await runBuild(m, rest.join(' '), false);
        return;
      }
      if (mod.has(cmd)) {
        await mod.run(m, cmd, rest);
        return;
      }
    }

    const isDM     = m.channel.type === ChannelType.DM;
    const botRole  = m.guild?.members?.me?.roles?.botRole ?? null;
    const mentioned =
      m.mentions.users.has(client.user.id) ||
      (botRole && m.mentions.roles.has(botRole.id)) ||
      new RegExp('<@!?' + client.user.id + '>').test(m.content);
    if (isDM) return;
    if (!mentioned) return;

    let text = m.content.replace(new RegExp('<@!?' + client.user.id + '>', 'g'), '');
    if (botRole) text = text.replace(new RegExp('<@&' + botRole.id + '>', 'g'), '');
    text = text.trim();

    // Mention + something that sounds like building/moderating -> try the builder first.
    if (m.guild && text && BUILD_HINT.test(text)) {
      if (await runBuild(m, text, true)) return;
    }

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

async function hideUnverifiedChannels(guild) {
  return;
}

async function sendModLog(guild, embed) {
  const channel = await client.channels.fetch(MOD_LOG_CHANNEL_ID).catch(() => null);
  if (!channel || typeof channel.send !== 'function') return;
  await channel.send({ embeds: [embed], allowedMentions: NO_PINGS }).catch(() => {});
}

client.on(Events.MessageDelete, async (msg) => {
  try {
    if (!msg.guild || msg.author?.bot) return;
    const guild = msg.guild;
    let executor = 'Unknown';
    try {
      const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 5 });
      const entry = logs.entries.find((e) => (e.target?.id === msg.author?.id || e.targetId === msg.author?.id) && (e.extra?.channel?.id === msg.channelId || e.channel?.id === msg.channelId || !e.extra));
      if (entry?.executor) executor = `${entry.executor.username} (${entry.executor.id})`;
    } catch (_) {}

    const embed = new EmbedBuilder()
      .setColor(0xef4444)
      .setTitle('🗑️ Message Deleted')
      .addFields(
        { name: 'Deleted by', value: executor.slice(0, 1024), inline: true },
        { name: 'Author', value: msg.author ? `${msg.author.username} (${msg.author.id})`.slice(0, 1024) : 'Unknown', inline: true },
        { name: 'Channel', value: `<#${msg.channelId}>`, inline: true },
        { name: 'Content', value: (msg.content || '(no cached content)').slice(0, 1024) },
      )
      .setTimestamp();
    await sendModLog(guild, embed);
  } catch (e) {
    console.error('[modlog delete error]', scrub(e?.message ?? e));
  }
});

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  try {
    if (!newMember.guild) return;
    const oldRoles = oldMember.roles?.cache ?? new Map();
    const newRoles = newMember.roles?.cache ?? new Map();
    const added = [...newRoles.values()].filter((role) => role.id !== newMember.guild.id && !oldRoles.has(role.id));
    const removed = [...oldRoles.values()].filter((role) => role.id !== newMember.guild.id && !newRoles.has(role.id));
    if (!added.length && !removed.length) return;

    let logs = null;
    try {
      logs = await newMember.guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 5 });
    } catch (_) {}

    for (const role of added) {
      const entry = logs?.entries?.find((e) => e.target?.id === newMember.id && e.changes?.some((c) => c.key === '$add' && (c.new_value || []).some((r) => r.id === role.id)));
      const embed = new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle('➕ Role Added')
        .addFields(
          { name: 'Member', value: `${newMember.user.username} (${newMember.id})`.slice(0, 1024), inline: true },
          { name: 'Role', value: `${role.name} (${role.id})`.slice(0, 1024), inline: true },
          { name: 'Added by', value: entry?.executor ? `${entry.executor.username} (${entry.executor.id})`.slice(0, 1024) : 'Unknown', inline: true },
        )
        .setTimestamp();
      await sendModLog(newMember.guild, embed);
    }

    for (const role of removed) {
      const entry = logs?.entries?.find((e) => e.target?.id === newMember.id && e.changes?.some((c) => c.key === '$remove' && (c.new_value || []).some((r) => r.id === role.id)));
      const embed = new EmbedBuilder()
        .setColor(0xef4444)
        .setTitle('➖ Role Removed')
        .addFields(
          { name: 'Member', value: `${newMember.user.username} (${newMember.id})`.slice(0, 1024), inline: true },
          { name: 'Role', value: `${role.name} (${role.id})`.slice(0, 1024), inline: true },
          { name: 'Removed by', value: entry?.executor ? `${entry.executor.username} (${entry.executor.id})`.slice(0, 1024) : 'Unknown', inline: true },
        )
        .setTimestamp();
      await sendModLog(newMember.guild, embed);
    }
  } catch (e) {
    console.error('[modlog role error]', scrub(e?.message ?? e));
  }
});

client.on(Events.GuildRoleCreate, async (role) => {
  try {
    const embed = new EmbedBuilder()
      .setColor(0x22c55e)
      .setTitle('➕ Role Created')
      .addFields({ name: 'Role', value: `${role.name} (${role.id})`.slice(0, 1024) })
      .setTimestamp();
    await sendModLog(role.guild, embed);
  } catch (e) { console.error('[modlog role create]', scrub(e?.message ?? e)); }
});

client.on(Events.GuildRoleDelete, async (role) => {
  try {
    const embed = new EmbedBuilder()
      .setColor(0xef4444)
      .setTitle('➖ Role Deleted')
      .addFields({ name: 'Role', value: `${role.name} (${role.id})`.slice(0, 1024) })
      .setTimestamp();
    await sendModLog(role.guild, embed);
  } catch (e) { console.error('[modlog role delete]', scrub(e?.message ?? e)); }
});

client.on(Events.GuildRoleUpdate, async (oldRole, newRole) => {
  try {
    const changes = [];
    if (oldRole.name !== newRole.name) changes.push(`Name: ${oldRole.name} → ${newRole.name}`);
    if (oldRole.color !== newRole.color) changes.push(`Color: ${oldRole.color.toString(16)} → ${newRole.color.toString(16)}`);
    if (oldRole.hoist !== newRole.hoist) changes.push(`Hoisted: ${oldRole.hoist} → ${newRole.hoist}`);
    if (oldRole.mentionable !== newRole.mentionable) changes.push(`Mentionable: ${oldRole.mentionable} → ${newRole.mentionable}`);
    const oldPerms = new Set(oldRole.permissions.toArray());
    const newPerms = new Set(newRole.permissions.toArray());
    const addedPerms = [...newPerms].filter((p) => !oldPerms.has(p));
    const removedPerms = [...oldPerms].filter((p) => !newPerms.has(p));
    if (addedPerms.length) changes.push(`Added perms: ${addedPerms.join(', ')}`);
    if (removedPerms.length) changes.push(`Removed perms: ${removedPerms.join(', ')}`);
    if (!changes.length) return;

    const embed = new EmbedBuilder()
      .setColor(0xf59e0b)
      .setTitle('✏️ Role Updated')
      .addFields(
        { name: 'Role', value: `${newRole.name} (${newRole.id})`.slice(0, 1024), inline: true },
        { name: 'Changes', value: changes.join('\n').slice(0, 1024) },
      )
      .setTimestamp();
    await sendModLog(newRole.guild, embed);
  } catch (e) { console.error('[modlog role update]', scrub(e?.message ?? e)); }
});

client.on(Events.MessageUpdate, async (oldMsg, newMsg) => {
  try {
    if (!newMsg.guild || newMsg.author?.bot) return;
    if (oldMsg.content === newMsg.content) return;
    const embed = new EmbedBuilder()
      .setColor(0x3b82f6)
      .setTitle('✏️ Message Edited')
      .addFields(
        { name: 'Author', value: newMsg.author ? `${newMsg.author.username} (${newMsg.author.id})`.slice(0, 1024) : 'Unknown', inline: true },
        { name: 'Channel', value: `<#${newMsg.channelId}>`, inline: true },
        { name: 'Before', value: (oldMsg.content || '(no cached content)').slice(0, 1024) },
        { name: 'After', value: (newMsg.content || '(no content)').slice(0, 1024) },
      )
      .setTimestamp();
    await sendModLog(newMsg.guild, embed);
  } catch (e) { console.error('[modlog message edit]', scrub(e?.message ?? e)); }
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    if (!welcomeEnabled) return;
    const channel = member.guild.systemChannel || member.guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.permissionsFor(member.guild.members.me)?.has(P.SendMessages));
    if (!channel) return;
    await channel.send({ content: `Welcome to the server, ${member}!`, allowedMentions: NO_PINGS });
  } catch (_) {}
});

client.on(Events.ChannelCreate, async (channel) => {
  try {
    if (channel.guild) await hideUnverifiedChannels(channel.guild);
  } catch (e) {
    console.error('[verify channel create error]', scrub(e?.message ?? e));
  }
});

client.once(Events.ClientReady, async (c) => {
  console.log('Logged in as ' + c.user.tag);
  for (const guild of c.guilds.cache.values()) {
    await hideUnverifiedChannels(guild).catch((e) => console.error('[verify hide error]', scrub(e?.message ?? e)));
  }
  c.user.setPresence({ activities: [{ name: 'calling babyboo fowa 😏', type: ActivityType.Playing }], status: 'dnd' });
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

function modappEmbed(data) {
  const f = (name, value) => ({ name, value: (String(value ?? '').trim() || '—').slice(0, 1024) });
  return new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle(`📝 New Staff Application — ${(String(data.discordUsername || 'Unknown')).slice(0, 100)}`)
    .addFields(
      f('Discord Username', data.discordUsername),
      f('Discord ID', data.discordId),
      f('Age', data.age),
      f('Timezone', data.timezone),
      f('Applying For', data.applyingFor),
      f('How long have you been in SinfulTpAi?', data.memberDuration),
      f('Daily Availability', data.dailyAvailability),
      f('Previous staff experience', data.previousExperience),
      f('Why do you want to join the SinfulTpAi staff team?', data.whyJoin),
      f('Why should we choose you?', data.whyChooseYou),
      f('Two members are arguing. How would you handle it?', data.arguingScenario),
      f('Your friend breaks a server rule. What do you do?', data.friendBreaksRule),
      f('You see another staff member abusing permissions. What do you do?', data.abusingStaff),
      f('Anything else we should know?', data.anythingElse),
    )
    .setTimestamp();
}

function getCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return ['', ''];
    return [part.slice(0, idx).trim(), decodeURIComponent(part.slice(idx + 1).trim())];
  }).filter(([k]) => k));
}

function getModappSession(req) {
  const token = getCookies(req).modapp_session;
  return token ? modappSessions.get(token) : null;
}

function requireModappLogin(req, res) {
  if (!MODAPP_REQUIRE_LOGIN) return true;
  const session = getModappSession(req);
  if (session) return true;
  res.writeHead(302, { Location: '/auth/discord' });
  res.end();
  return false;
}

const modappServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Modapp-Secret');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/') {
    const session = getModappSession(req);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SinfulTpAi Login</title>
  <style>
    body { margin: 0; min-height: 100vh; background: #0f0f16; color: white; font-family: system-ui, sans-serif; }
    .topbar { display:flex; justify-content:flex-end; align-items:center; padding:16px 24px; border-top:2px solid #ec4899; border-bottom:1px solid #2a2a3d; background:#0b0b12; }
    .topbar h1 { display:none; }
    .topbar a { background: #ec4899; color: white; text-decoration: none; padding: 12px 24px; border-radius: 999px; font-weight: 800; box-shadow: 0 8px 24px rgba(236,72,153,.35); }
    .content { padding: 32px 24px; }
  </style>
</head>
<body>
  <nav class="topbar">
    ${session ? '<a href="/modapp">Open Application</a>' : '<a href="/auth/discord">Login with Discord</a>'}
  </nav>
  <main class="content">
    <h2>Welcome</h2>
    <p>Use the pink button at the top to login with Discord.</p>
  </main>
</body>
</html>`);
  }

  if (req.method === 'GET' && url.pathname === '/auth/discord') {
    if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET in Railway variables.');
    }
    const state = url.searchParams.get('state');
    const params = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      redirect_uri: OAUTH_REDIRECT_URI,
      response_type: 'code',
      scope: 'identify email',
    });
    if (state) params.set('state', state);
    res.writeHead(302, { Location: `https://discord.com/oauth2/authorize?${params.toString()}` });
    return res.end();
  }

  if (req.method === 'GET' && url.pathname === '/auth/discord/callback') {
    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Missing code');
    }
    try {
      const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: DISCORD_CLIENT_ID,
          client_secret: DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: OAUTH_REDIRECT_URI,
        }).toString(),
      });
      const tokenJson = await tokenRes.json();
      if (!tokenRes.ok) throw new Error(tokenJson.error_description || tokenJson.error || 'OAuth failed');

      const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokenJson.access_token}` },
      });
      const user = await userRes.json();
      if (!userRes.ok) throw new Error(user.message || 'Could not fetch Discord user');

      const modappSessionToken = require('crypto').randomBytes(32).toString('hex');
      const loginIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
      modappSessions.set(modappSessionToken, {
        id: user.id,
        username: user.username,
        global_name: user.global_name,
        email: user.email || null,
        verified: user.verified ?? null,
        createdAt: Date.now(),
        ip: loginIp,
      });
      const sessionToken = modappSessionToken;
      saveModappSessions();
      const state = url.searchParams.get('state');
      const redirectTarget = state === 'verify' ? '/verify' : state === 'fowa' ? '/fowa' : state === 'admin' ? '/admin' : '/modapp';
      res.writeHead(302, {
        Location: redirectTarget,
        'Set-Cookie': `modapp_session=${encodeURIComponent(sessionToken)}; HttpOnly; Path=/; SameSite=Lax`,
      });
      return res.end();
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(clean(e?.message ?? 'OAuth failed').slice(0, 300));
    }
  }

  if (req.method === 'GET' && url.pathname === '/logout') {
    const token = getCookies(req).modapp_session;
    if (token) modappSessions.delete(token);
    saveModappSessions();
    res.writeHead(302, {
      Location: '/modapp',
      'Set-Cookie': 'modapp_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0',
    });
    return res.end();
  }

  if (req.method === 'GET' && url.pathname.startsWith('/ticket-')) {
    const hash = url.pathname.slice('/ticket-'.length);
    const ticket = closedTickets.get(hash);
    if (!ticket) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Ticket not found');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(ticket.html);
  }

  if (req.method === 'GET' && url.pathname === '/verify') {
    const session = getModappSession(req);
    if (!session) {
      res.writeHead(302, { Location: '/auth/discord?state=verify' });
      return res.end();
    }
    const record = verifications.get(session.id);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Verify</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f0f16;color:#fff;font-family:system-ui}.card{background:#171724;border:1px solid #2a2a3d;border-radius:18px;padding:28px;max-width:420px;width:calc(100% - 48px)}input{width:100%;box-sizing:border-box;background:#0f0f16;color:#fff;border:1px solid #33334a;border-radius:10px;padding:12px}button{margin-top:16px;width:100%;background:#ec4899;color:#fff;border:0;border-radius:999px;padding:14px;font-weight:800}</style></head><body><main class="card"><h1>Verify</h1><p>Logged in as <b>${session.username}</b></p>${record ? '<p>You are already verified.</p>' : '<form method="POST" action="/verify/claim"><label>Age (optional)</label><input name="age" placeholder="18"><button type="submit">Verify</button></form>'}</main></body></html>`);
  }

  if (req.method === 'POST' && url.pathname === '/verify/claim') {
    const session = getModappSession(req);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Login with Discord first.' }));
    }
    let body = '';
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 10000) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Payload too large' }));
        }
      }
      let data = {};
      try { data = JSON.parse(body || '{}'); } catch (_) {
        data = Object.fromEntries(new URLSearchParams(body));
      }
      const age = String(data.age || '').trim() || 'not provided';
      const record = {
        discordUsername: session.username,
        discordId: session.id,
        email: session.email || '',
        verified: session.verified ?? null,
        ip: session.ip || '',
        age,
        verifiedAt: new Date().toISOString(),
      };
      verifications.set(session.id, record);
      saveVerifications();
      for (const guild of client.guilds.cache.values()) {
        const member = await guild.members.fetch(session.id).catch(() => null);
        if (member && !member.roles.cache.has(VERIFY_ROLE_ID)) {
          await member.roles.add(VERIFY_ROLE_ID, 'Web verification').catch(() => {});
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: clean(e?.message ?? 'Verification failed').slice(0, 300) }));
    }
  }

  if (req.method === 'GET' && url.pathname === FOWA_PAGE) {
    const session = getModappSession(req);
    if (!session) {
      res.writeHead(302, { Location: '/auth/discord?state=fowa' });
      return res.end();
    }
    if (String(session.id) !== String(env('OWNER_ID') || '1088143400496279552')) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>403 — Fowa only</h1>');
    }
    const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const list = [...verifications.values()].map((v) => `<details open><summary><b>${esc(v.verifiedAt || '')}</b> — ${esc(v.discordUsername)} (${esc(v.discordId)})</summary><p>Discord Username: ${esc(v.discordUsername)}</p><p>Discord ID: <code>${esc(v.discordId)}</code></p><p>Email: ${esc(v.email)}</p><p>Verified Email: ${v.verified === true ? 'yes' : v.verified === false ? 'no' : 'unknown'}</p><p>IP Address: ${esc(v.ip)}</p><p>Age: ${esc(v.age)}</p></details>`).join('') || '<p>No verified users yet.</p>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Fowa</title><style>body{background:#111;color:#fff;font-family:system-ui;padding:2rem}details{border:1px solid #333;border-radius:10px;padding:12px;margin:12px 0}summary{cursor:pointer}</style></head><body><h1>Fowa verified users</h1>${list}<a style="color:#a78bfa" href="/modapp">Back</a></body></html>`);
  }

  if (req.method === 'GET' && url.pathname === '/admin') {
    const session = getModappSession(req);
    if (!session) {
      res.writeHead(302, { Location: '/auth/discord?state=admin' });
      return res.end();
    }
    if (String(session.id) !== String(env('OWNER_ID') || '1088143400496279552')) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>403 — Owner only</h1>');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const appList = modappSubmissions.map((a, i) => `
      <details ${i === 0 ? 'open' : ''}>
        <summary><b>${esc(a.time)}</b> — ${esc(a.discordUsername)} (${esc(a.discordId)})</summary>
        <p>Discord Username: ${esc(a.discordUsername)}</p>
        <p>Discord ID: <code>${esc(a.discordId)}</code></p>
        <p>Email: ${esc(a.email)}</p>
        <p>Verified Email: ${a.verified === true ? 'yes' : a.verified === false ? 'no' : 'unknown'}</p>
        <p>IP Address: ${esc(a.ip)}</p>
        <p>Age: ${esc(a.age)}</p>
        <p>Timezone: ${esc(a.timezone)}</p>
        <p>Applying For: ${esc(a.applyingFor)}</p>
        <p>How long have you been in SinfulTpAi? ${esc(a.memberDuration)}</p>
        <p>Daily Availability: ${esc(a.dailyAvailability)}</p>
        <p>Previous staff experience: ${esc(a.previousExperience)}</p>
        <p>Why join: ${esc(a.whyJoin)}</p>
        <p>Why choose you: ${esc(a.whyChooseYou)}</p>
        <p>Arguing scenario: ${esc(a.arguingScenario)}</p>
        <p>Friend breaks rule: ${esc(a.friendBreaksRule)}</p>
        <p>Staff abusing permissions: ${esc(a.abusingStaff)}</p>
        <p>Anything else: ${esc(a.anythingElse)}</p>
      </details>
    `).join('') || '<p>No applications submitted yet.</p>';
    return res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Admin</title><style>body{background:#111;color:#fff;font-family:system-ui;padding:2rem} details{border:1px solid #333;border-radius:10px;padding:12px;margin:12px 0} summary{cursor:pointer}</style></head><body><h1>Admin check</h1><p>Discord Username: <b>${esc(session.username)}</b></p><p>Discord ID: <code>${esc(session.id)}</code></p><p>Email: ${esc(session.email || 'Not authorized / unavailable')}</p><p>Verified Email: ${session.verified === true ? 'yes' : session.verified === false ? 'no' : 'unknown'}</p><p>IP Address: ${esc(session.ip || 'unknown')}</p><h2>Application Submissions</h2>${appList}<p>This page is owner-only. Do not share access to it.</p><a style="color:#a78bfa" href="/modapp">Back to application</a></body></html>`);
  }

  if (req.method === 'GET' && url.pathname === '/modapp') {
    if (!requireModappLogin(req, res)) return;
    const session = getModappSession(req);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SinfulTpAi Staff Application</title>
  <style>
    body { margin: 0; min-height: 100vh; background: #0f0f16; color: #fff; font-family: system-ui, sans-serif; padding: 32px 16px; }
    .wrap { max-width: 760px; margin: 0 auto; }
    .card { background: #171724; border: 1px solid #2a2a3d; border-radius: 18px; padding: 28px; box-shadow: 0 20px 60px rgba(0,0,0,.35); }
    h1 { margin-top: 0; } label { display: block; margin: 16px 0 6px; font-weight: 700; }
    input, select, textarea { width: 100%; box-sizing: border-box; background: #0f0f16; color: white; border: 1px solid #33334a; border-radius: 10px; padding: 12px; }
    textarea { min-height: 90px; resize: vertical; }
    button { margin-top: 20px; width: 100%; background: #7c3aed; color: white; border: 0; border-radius: 12px; padding: 14px 18px; font-weight: 800; cursor: pointer; }
    button:disabled { opacity: .6; cursor: not-allowed; }
    .small { color: #a8a8bd; font-size: 14px; margin-top: 12px; }
    .top { display:flex; justify-content:space-between; gap:12px; align-items:center; }
    a { color: #a78bfa; }
  </style>
</head>
<body>
  <main class="wrap">
    <div class="card">
      <div class="top">
        <h1>SinfulTpAi Staff Application</h1>
        ${session ? '<a href="/logout">Logout</a>' : '<a href="/auth/discord">Login with Discord</a>'}
      </div>
      ${session ? `<p class="small">Logged in as <b>${session.username}</b></p>` : '<p class="small">You can login with Discord, but login is not required here.</p>'}
      <form id="modapp-form">
        <label>Discord Username *</label><input name="discordUsername" placeholder="username" value="${session?.username || ''}" ${session ? 'readonly' : ''} required />
        <input type="hidden" name="discordId" value="${session?.id || ''}" />
        ${session ? `<p class="small">Discord ID: <code>${session.id}</code></p>` : ''}
        <label>Age *</label><input name="age" placeholder="18" required />
        <label>Timezone *</label><input name="timezone" placeholder="PST / EST / GMT" required />
        <label>Applying For *</label>
        <select name="applyingFor" required>
          <option value="">Choose...</option>
          <option>Moderator</option>
          <option>Helper</option>
          <option>Admin</option>
          <option>Other</option>
        </select>
        <label>How long have you been in SinfulTpAi? *</label><input name="memberDuration" placeholder="Example: 3 months" required />
        <label>Daily Availability *</label><input name="dailyAvailability" placeholder="Example: 3-5 hours" required />
        <label>Previous staff experience *</label><textarea name="previousExperience" placeholder="Tell us about previous moderation or staff experience." required></textarea>
        <label>Why do you want to join the SinfulTpAi staff team? *</label><textarea name="whyJoin" required></textarea>
        <label>Why should we choose you? *</label><textarea name="whyChooseYou" required></textarea>
        <label>Two members are arguing. How would you handle it? *</label><textarea name="arguingScenario" required></textarea>
        <label>Your friend breaks a server rule. What do you do? *</label><textarea name="friendBreaksRule" required></textarea>
        <label>You see another staff member abusing permissions. What do you do? *</label><textarea name="abusingStaff" required></textarea>
        <label>Anything else we should know?</label><textarea name="anythingElse"></textarea>
        <button type="submit">Submit Staff Application</button>
        <p class="small">By submitting, you confirm the information you provided is accurate and understand that staff permissions may be removed for abuse or rule violations.</p>
      </form>
    </div>
  </main>
  <script>
    const form = document.getElementById('modapp-form');
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      const button = form.querySelector('button');
      button.disabled = true;
      button.textContent = 'Submitting...';
      const data = Object.fromEntries(new FormData(form).entries());
      try {
        const res = await fetch('/modapp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        const result = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error(result.error || 'Submission failed');
        form.innerHTML = '<h2>✅ Application submitted. Thanks — SinfulTpAi staff will review it soon.</h2>';
      } catch (e) {
        alert(e.message);
        button.disabled = false;
        button.textContent = 'Submit Staff Application';
      }
    });
  </script>
</body>
</html>`);
  }

  if (req.method !== 'POST' || url.pathname !== '/modapp') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Not found' }));
  }

  if (MODAPP_REQUIRE_LOGIN && !getModappSession(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Login with Discord first.' }));
  }

  let body = '';
  try {
    const requestIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    console.log(`[modapp] POST /modapp from ${requestIp}`);
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 2_000_000) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Payload too large' }));
      }
    }

    const data = JSON.parse(body || '{}');
    const session = getModappSession(req);
    if (MODAPP_REQUIRE_LOGIN && !session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Login with Discord first.' }));
    }
    if (session) {
      data.discordUsername = session.username;
      data.discordId = session.id;
      data.email = session.email || '';
      data.verified = session.verified;
    }
    const secret = data.secret || req.headers['x-modapp-secret'];
    if (MODAPP_SECRET && secret !== MODAPP_SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }

    const required = [
      'discordUsername', 'age', 'timezone', 'applyingFor', 'memberDuration',
      'dailyAvailability', 'previousExperience', 'whyJoin', 'whyChooseYou',
      'arguingScenario', 'friendBreaksRule', 'abusingStaff',
    ];
    const missing = required.filter((key) => !String(data[key] ?? '').trim());
    if (missing.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing fields', missing }));
    }

    modappSubmissions.unshift({
      time: new Date().toISOString(),
      discordUsername: data.discordUsername,
      discordId: data.discordId || '',
      email: data.email || '',
      verified: data.verified ?? null,
      ip: session?.ip || '',
      age: data.age,
      timezone: data.timezone,
      applyingFor: data.applyingFor,
      memberDuration: data.memberDuration,
      dailyAvailability: data.dailyAvailability,
      previousExperience: data.previousExperience,
      whyJoin: data.whyJoin,
      whyChooseYou: data.whyChooseYou,
      arguingScenario: data.arguingScenario,
      friendBreaksRule: data.friendBreaksRule,
      abusingStaff: data.abusingStaff,
      anythingElse: data.anythingElse,
    });
    while (modappSubmissions.length > 100) modappSubmissions.pop();
    saveModappSubmissions();

    const channel = await client.channels.fetch(MODAPP_CHANNEL_ID);
    if (!channel || typeof channel.send !== 'function') throw new Error('Application channel is not available.');

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('modapp_accept').setLabel('Accept').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('modapp_decline').setLabel('Decline').setStyle(ButtonStyle.Danger),
    );

    await channel.send({ embeds: [modappEmbed(data)], components: [row], allowedMentions: NO_PINGS });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: clean(e?.message ?? 'Bad request').slice(0, 300) }));
  }
});

modappServer.listen(MODAPP_PORT, () => {
  console.log(`Modapp webhook listening on port ${MODAPP_PORT}`);
});

client.login(DISCORD_TOKEN).catch((e) => {
  console.error('Discord login failed:', scrub(e?.message ?? e));
  process.exit(1);
});
