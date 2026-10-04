const { PermissionFlagsBits: P } = require('discord.js');

const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
const UNITS = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };

// "10m", "2h", "1d", "30" (minutes). Returns ms or null.
function parseDuration(str) {
  const mm = /^(\d{1,6})\s*([smhdw])?$/i.exec(String(str || '').trim());
  if (!mm) return null;
  return Number(mm[1]) * UNITS[(mm[2] || 'm').toLowerCase()];
}

// "<@123>", "<@!123>" or a raw ID -> "123"
function parseTarget(arg) {
  const mm = /^<@!?(\d{17,20})>$|^(\d{17,20})$/.exec(String(arg || ''));
  return mm ? mm[1] || mm[2] : null;
}

function createMod({ ownerId, clean, noPings }) {
  const ALIASES = { timeout: 'to', mute: 'to', uto: 'untimeout', unmute: 'untimeout' };
  const PERMS = {
    ban: P.BanMembers,
    unban: P.BanMembers,
    kick: P.KickMembers,
    to: P.ModerateMembers,
    untimeout: P.ModerateMembers,
    lock: P.ManageChannels,
    unlock: P.ManageChannels,
  };
  const LOCK_PERMS = ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads'];

  const isOwner = (id) => id === ownerId;
  const resolveName = (cmd) => ALIASES[cmd] || cmd;
  const has = (cmd) => Boolean(PERMS[resolveName(cmd)]);

  async function fetchMember(guild, id) {
    return guild.members.fetch(id).catch(() => null);
  }

  // Ranks: owner of the bot and server owner can always act; everyone else must outrank the target.
  function outranks(invoker, target) {
    if (isOwner(invoker.id) || invoker.id === invoker.guild.ownerId) return true;
    return invoker.roles.highest.comparePositionTo(target.roles.highest) > 0;
  }

  async function run(m, rawCmd, args) {
    const cmd = resolveName(rawCmd.toLowerCase());
    const say = (text) => m.reply({ content: clean(text).slice(0, 1900), allowedMentions: noPings });
    const invoker = m.member || (await fetchMember(m.guild, m.author.id));
    if (!invoker) return say('Could not read your server permissions.');

    if (!isOwner(invoker.id) && !invoker.permissions.has(PERMS[cmd])) {
      return say("You don't have permission to use that command.");
    }

    const botId = m.client.user.id;
    const reasonFor = (text) => `${m.author.username}: ${text || 'No reason given'}`.slice(0, 500);

    try {
      // ── lock / unlock ──
      if (cmd === 'lock' || cmd === 'unlock') {
        const ch = m.channel;
        if (!ch.permissionOverwrites) return say("I can't lock this kind of channel.");
        const locking = cmd === 'lock';
        const edits = Object.fromEntries(LOCK_PERMS.map((p) => [p, locking ? false : null]));
        await ch.permissionOverwrites.edit(m.guild.roles.everyone, edits, {
          reason: reasonFor(args.join(' ') || (locking ? 'Channel locked' : 'Channel unlocked')),
        });
        return say(locking ? '🔒 Channel locked. Use `?unlock` to open it again.' : '🔓 Channel unlocked.');
      }

      // ── everything below needs a target ──
      const id = parseTarget(args[0]);
      if (!id) return say(`Usage: \`?${cmd} @user${cmd === 'to' ? ' [10m|2h|1d] [reason]' : ' [reason]'}\``);
      if (id === botId) return say("I'm not doing that to myself.");
      if (id === m.author.id && cmd !== 'unban') return say("You can't do that to yourself.");

      const rest = args.slice(1);
      const member = await fetchMember(m.guild, id);

      const guard = (flag, verb) => {
        if (!member) return 'That user is not in this server.';
        if (!outranks(invoker, member)) return 'Their top role is equal to or higher than yours.';
        if (!member[flag]) return `I can't ${verb} them. Their role is above mine, or they own the server. Move my role higher.`;
        return null;
      };

      const label = async () => member?.user.username || (await m.client.users.fetch(id).catch(() => null))?.username || id;

      if (cmd === 'ban') {
        if (member) {
          const bad = guard('bannable', 'ban');
          if (bad) return say(bad);
        }
        await m.guild.members.ban(id, { reason: reasonFor(rest.join(' ')) });
        return say(`🔨 Banned **${await label()}**.`);
      }

      if (cmd === 'unban') {
        await m.guild.members.unban(id, reasonFor(rest.join(' ')));
        return say(`✅ Unbanned **${await label()}**.`);
      }

      if (cmd === 'kick') {
        const bad = guard('kickable', 'kick');
        if (bad) return say(bad);
        await member.kick(reasonFor(rest.join(' ')));
        return say(`👢 Kicked **${await label()}**.`);
      }

      if (cmd === 'to') {
        const bad = guard('moderatable', 'timeout');
        if (bad) return say(bad);
        let ms = parseDuration(rest[0]);
        let reasonParts = rest.slice(1);
        if (ms === null) {
          ms = 10 * 60000; // default 10 minutes
          reasonParts = rest;
        }
        if (ms < 1000) return say('Timeout must be at least 1 second.');
        if (ms > MAX_TIMEOUT_MS) return say('Discord timeouts max out at 28 days.');
        await member.timeout(ms, reasonFor(reasonParts.join(' ')));
        return say(`⏳ Timed out **${await label()}** for ${formatMs(ms)}.`);
      }

      if (cmd === 'untimeout') {
        const bad = guard('moderatable', 'untimeout');
        if (bad) return say(bad);
        await member.timeout(null, reasonFor(rest.join(' ')));
        return say(`✅ Removed the timeout from **${await label()}**.`);
      }
    } catch (e) {
      const msg = String(e?.message || e);
      if (/missing (permissions|access)/i.test(msg)) {
        return say("Discord blocked that. I'm missing a permission, or my role is below the target's role.");
      }
      return say('That failed: ' + msg.slice(0, 200));
    }
  }

  return { run, has };
}

function formatMs(ms) {
  const parts = [];
  let left = Math.round(ms / 1000);
  for (const [label, size] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]) {
    const n = Math.floor(left / size);
    if (n) parts.push(n + label);
    left -= n * size;
  }
  return parts.join(' ') || '0s';
}

module.exports = { createMod, parseDuration, parseTarget };
