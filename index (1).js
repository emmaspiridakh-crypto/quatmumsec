console.log(">>> GLORIOUS SECURITY BOT LOADED <<<");

const {
  Client, GatewayIntentBits, Partials, Collection,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionsBitField, AuditLogEvent, ActivityType,
} = require("discord.js");
const express = require("express");
const fs = require("fs");

// ══════════════════════════════════════════════════════════════
//  KEEP ALIVE (fake port για Render)
// ══════════════════════════════════════════════════════════════
const app = express();
app.get("/", (_, res) => res.send("🔒 Glorious Security Bot — Online"));
app.get("/health", (_, res) => res.json({ status: "ok", uptime: process.uptime() }));
app.listen(10000, "0.0.0.0", () => console.log("Keep-alive on :10000"));

// ══════════════════════════════════════════════════════════════
//  BOT INIT
// ══════════════════════════════════════════════════════════════
const TOKEN    = process.env.TOKEN;
const GUILD_ID = process.env.GUILD_ID || "1490079978300117212";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
});

// ══════════════════════════════════════════════════════════════
//  ROLE / CHANNEL IDs
// ══════════════════════════════════════════════════════════════
const CEO_ROLE_ID             = process.env.CEO_ROLE_ID   || "1490084094749573151";
const SECURITY_LOG_CHANNEL_ID = process.env.SECURITY_LOG  || "1502328608805486765";

const SERVER_NAME          = "Glorious Shop";
const SERVER_THUMBNAIL_URL = "https://i.imgur.com/F6vMnVL.jpeg";

// ══════════════════════════════════════════════════════════════
//  DATA FILES
// ══════════════════════════════════════════════════════════════
const SECURITY_FILE = "security.json";
const CONFIG_FILE   = "sec_config.json";

function loadJSON(file, def = {}) {
  try {
    if (!fs.existsSync(file)) { fs.writeFileSync(file, JSON.stringify(def, null, 2)); return def; }
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { return def; }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── Default config ───────────────────────────────────────────
const DEFAULT_CONFIG = {
  alt_age_days:        30,
  alt_auto_kick:       true,
  link_filter:         true,
  token_filter:        true,
  spam_filter:         true,
  spam_threshold:      5,
  spam_window_secs:    5,
  spam_timeout_mins:   10,
  link_timeout_mins:   60,
  mass_action_limit:   3,
  mass_action_window:  10,
  whitelisted_bots:    [],
  disabled_modules:    [],   // "alt","link","token","spam","mass_action","bot_verify"
};

let config       = loadJSON(CONFIG_FILE, DEFAULT_CONFIG);
let securityData = loadJSON(SECURITY_FILE, { events: [] });

function saveConfig() { saveJSON(CONFIG_FILE, config); }
function logEvent(type, data) {
  securityData.events = securityData.events || [];
  securityData.events.unshift({ type, ...data, ts: Date.now() });
  if (securityData.events.length > 500) securityData.events = securityData.events.slice(0, 500);
  saveJSON(SECURITY_FILE, securityData);
}

// ══════════════════════════════════════════════════════════════
//  PERMISSION HELPERS
// ══════════════════════════════════════════════════════════════
const isCeo          = m => m?.roles?.cache?.has(CEO_ROLE_ID);
const isOwnerOrAbove = m => m?.roles?.cache?.has(CEO_ROLE_ID) || m?.roles?.cache?.has(OWNER_ROLE_ID);
const moduleEnabled  = name => !config.disabled_modules?.includes(name);

// ══════════════════════════════════════════════════════════════
//  PATTERNS
// ══════════════════════════════════════════════════════════════
const URL_PATTERN   = /(https?:\/\/|www\.)\S+|discord\.gg\/\S+/gi;
const TOKEN_PATTERN = /[MNO][a-zA-Z0-9_-]{23,25}\.[a-zA-Z0-9_-]{6}\.[a-zA-Z0-9_-]{27,38}/;

const spamTracker    = {};
const banKickTracker = {};
const pendingBots    = {};

// ══════════════════════════════════════════════════════════════
//  SECURITY ALERT HELPER
// ══════════════════════════════════════════════════════════════
async function sendSecurityAlert(guild, embed, ping = false) {
  const ch = guild.channels.cache.get(SECURITY_LOG_CHANNEL_ID);
  if (!ch) return;
  const ceoRole = guild.roles.cache.get(CEO_ROLE_ID);
  const content = ping && ceoRole ? ceoRole.toString() : null;
  await ch.send({ content, embeds: [embed] }).catch(() => {});
}

// ══════════════════════════════════════════════════════════════
//  MASS BAN/KICK TRACKER
// ══════════════════════════════════════════════════════════════
async function trackMassAction(guild, moderator, actionType) {
  if (!moduleEnabled("mass_action")) return;
  if (!moderator) return;
  const uid = moderator.id;
  const now = Date.now() / 1000;
  if (!banKickTracker[uid]) banKickTracker[uid] = [];
  banKickTracker[uid].push(now);
  banKickTracker[uid] = banKickTracker[uid].filter(t => now - t < config.mass_action_window);
  if (banKickTracker[uid].length >= config.mass_action_limit) {
    banKickTracker[uid] = [];
    const mm     = guild.members.cache.get(uid);
    const exempt = [CEO_ROLE_ID, OWNER_ROLE_ID];
    const isEx   = mm && exempt.some(r => mm.roles.cache.has(r));
    if (mm && !isEx) {
      await mm.timeout(7 * 24 * 60 * 60 * 1000, `Mass ${actionType}`).catch(() => {});
      const e = new EmbedBuilder()
        .setTitle(`⚠️ Mass ${actionType.toUpperCase()} Detected!`)
        .setDescription(`${mm} performed mass ${actionType}.\n**1 week timeout** applied.`)
        .setColor(0x8B0000)
        .setTimestamp();
      logEvent("mass_action", { user: mm.user.tag, uid: mm.id, action: actionType });
      await sendSecurityAlert(guild, e, true);
    }
  }
}

// ══════════════════════════════════════════════════════════════
//  MEMBER JOIN — Alt detection + Bot verification
// ══════════════════════════════════════════════════════════════
client.on("guildMemberAdd", async member => {
  const guild = member.guild;

  // ── Bot verification ──────────────────────────────────────
  if (member.user.bot) {
    if (!moduleEnabled("bot_verify")) return;
    if (config.whitelisted_bots?.includes(member.id)) return;

    for (const [, ch] of guild.channels.cache) {
      await ch.permissionOverwrites.create(member, {
        SendMessages: false, ViewChannel: false, Connect: false, Speak: false,
      }, { reason: "Bot pending verification" }).catch(() => {});
    }

    const isVerified = member.user.flags?.has("VerifiedBot") ?? false;
    const bt    = isVerified ? "✅ Verified Bot" : "⚠️ Unverified / Custom Bot";
    const color = isVerified ? 0xffff00 : 0x8B0000;

    const e = new EmbedBuilder()
      .setTitle(`🤖 New Bot ${!isVerified ? "(UNVERIFIED ⚠️)" : "(Verified)"}`)
      .setDescription(
        `**${member.user.tag}** (${member}) joined.\n\n` +
        `**Type:** ${bt}\n**ID:** \`${member.id}\`\n` +
        `**Created:** <t:${Math.floor(member.user.createdTimestamp / 1000)}:F>\n\n` +
        `⚠️ Zero permissions until accepted.`
      )
      .setColor(color)
      .setThumbnail(member.user.displayAvatarURL())
      .setFooter({ text: `${SERVER_NAME} • Security Log` })
      .setTimestamp();

    const sl = guild.channels.cache.get(SECURITY_LOG_CHANNEL_ID);
    if (sl) {
      const ownerRole = guild.roles.cache.get(OWNER_ROLE_ID);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`bot_accept_${member.id}`).setLabel("✅ Accept Bot").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`bot_deny_${member.id}`).setLabel("❌ Deny Bot (Kick)").setStyle(ButtonStyle.Danger),
      );
      const msg = await sl.send({ content: ownerRole?.toString() ?? null, embeds: [e], components: [row] });
      pendingBots[member.id] = msg.id;
      logEvent("bot_join", { bot: member.user.tag, id: member.id, verified: isVerified });
    }
    return;
  }

  // ── Alt detection ─────────────────────────────────────────
  if (!moduleEnabled("alt")) return;
  const ageDays = Math.floor((Date.now() - member.user.createdTimestamp) / 86400000);
  if (ageDays < config.alt_age_days) {
    const e = new EmbedBuilder()
      .setTitle("🚨 ALT ACCOUNT DETECTED!").setColor(0x8B0000)
      .setThumbnail(member.user.displayAvatarURL())
      .addFields(
        { name: "👤 User",    value: `${member} (\`${member.id}\`)`, inline: false },
        { name: "📅 Age",     value: `**${ageDays} days**`,          inline: true },
        { name: "📆 Created", value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:F>`, inline: true },
      )
      .setFooter({ text: `${SERVER_NAME} • Security Log` })
      .setTimestamp();

    if (config.alt_auto_kick) {
      await member.kick(`Alt account — age: ${ageDays} days`)
        .then(() => e.addFields({ name: "⚡ Action", value: "✅ **Auto-kicked**", inline: false }))
        .catch(err => e.addFields({ name: "⚡ Action", value: `❌ Failed: ${err}`, inline: false }));
    } else {
      e.addFields({ name: "⚡ Action", value: "⚠️ Alert only (kick disabled)", inline: false });
    }

    logEvent("alt_detected", { user: member.user.tag, id: member.id, ageDays, kicked: config.alt_auto_kick });
    await sendSecurityAlert(guild, e, true);
  }
});

// ══════════════════════════════════════════════════════════════
//  MESSAGE HANDLER — Token / Link / Spam
// ══════════════════════════════════════════════════════════════
client.on("messageCreate", async message => {
  if (!message.guild) return;
  const author = message.author;
  const guild  = message.guild;
  const member = message.member;

  // ── Token detection ───────────────────────────────────────
  if (!author.bot && moduleEnabled("token") && config.token_filter && TOKEN_PATTERN.test(message.content)) {
    await message.delete().catch(() => {});
    const e = new EmbedBuilder()
      .setTitle("🔑 TOKEN DETECTED & DELETED!")
      .setDescription(
        `${author} sent something that looks like a **Bot Token**!\n` +
        `The message has been deleted.\n\n` +
        `⚠️ **If it's your token, regenerate it IMMEDIATELY!**`
      )
      .setColor(0x8B0000)
      .setThumbnail(author.displayAvatarURL())
      .addFields(
        { name: "👤 User",    value: `${author} (\`${author.id}\`)`, inline: true },
        { name: "📢 Channel", value: `${message.channel}`,           inline: true },
      )
      .setFooter({ text: `${SERVER_NAME} • Security Log` })
      .setTimestamp();
    logEvent("token_detected", { user: author.tag, id: author.id, channel: message.channel.name });
    await sendSecurityAlert(guild, e, true);
    return;
  }

  // ── Link detection ────────────────────────────────────────
  if (!author.bot && moduleEnabled("link") && config.link_filter && URL_PATTERN.test(message.content)) {
    URL_PATTERN.lastIndex = 0;
    const exempt = [CEO_ROLE_ID, OWNER_ROLE_ID];
    const isEx   = exempt.some(r => member?.roles.cache.has(r));
    if (!isEx && !member?.permissions.has(PermissionsBitField.Flags.Administrator)) {
      await message.delete().catch(() => {});
      await member?.timeout(config.link_timeout_mins * 60 * 1000, "Link detected").catch(() => {});
      const e = new EmbedBuilder()
        .setTitle("🔗 Link Detected & Deleted")
        .setDescription(`${author} sent a link and received a **${config.link_timeout_mins} minute timeout**.`)
        .setColor(0xffa500)
        .setThumbnail(author.displayAvatarURL())
        .addFields(
          { name: "👤 User",    value: `${author} (\`${author.id}\`)`, inline: true },
          { name: "📢 Channel", value: `${message.channel}`,           inline: true },
        )
        .setFooter({ text: `${SERVER_NAME} • Security Log` })
        .setTimestamp();
      logEvent("link_detected", { user: author.tag, id: author.id, channel: message.channel.name });
      await sendSecurityAlert(guild, e, false);
      return;
    }
  }
  URL_PATTERN.lastIndex = 0;

  // ── Spam detection ────────────────────────────────────────
  if (!author.bot && moduleEnabled("spam") && config.spam_filter) {
    const uid = author.id;
    const now = Date.now() / 1000;
    if (!spamTracker[uid]) spamTracker[uid] = [];
    spamTracker[uid].push(now);
    spamTracker[uid] = spamTracker[uid].filter(t => now - t < config.spam_window_secs);
    if (spamTracker[uid].length >= config.spam_threshold) {
      spamTracker[uid] = [];
      if (!member?.permissions.has(PermissionsBitField.Flags.Administrator)) {
        await member?.timeout(config.spam_timeout_mins * 60 * 1000, "Spam").catch(() => {});
        const e = new EmbedBuilder()
          .setTitle("🚫 Spam Detected")
          .setDescription(`${author} was spamming and received a **${config.spam_timeout_mins} minute timeout**.`)
          .setColor(0xff0000)
          .setThumbnail(author.displayAvatarURL())
          .addFields(
            { name: "👤 User",    value: `${author} (\`${author.id}\`)`, inline: true },
            { name: "📢 Channel", value: `${message.channel}`,           inline: true },
          )
          .setFooter({ text: `${SERVER_NAME} • Security Log` })
          .setTimestamp();
        logEvent("spam_detected", { user: author.tag, id: author.id, channel: message.channel.name });
        await sendSecurityAlert(guild, e, false);
      }
    }
  }

  // ── Commands ──────────────────────────────────────────────
  if (!message.content.startsWith("!")) return;
  const args    = message.content.slice(1).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // ── CEO ONLY ─────────────────────────────────────────────
  if (!isCeo(member)) {
    if (["secpanel","secconfig","secdisable","secenable","secstatus","seclogs","secwhitelist","secunwhitelist"].includes(command)) {
      return message.reply("❌ CEO only.");
    }
    return;
  }

  // ────────────────────────────────────────────────────────
  //  !secpanel  —  Αποστολή CEO Security Panel
  // ────────────────────────────────────────────────────────
  if (command === "secpanel") {
    const modules = [
      { name: "🛡️ ALT Detection",     key: "alt",           desc: "Auto-detect & kick alt accounts" },
      { name: "🔗 Link Filter",        key: "link",          desc: "Delete links & timeout senders"  },
      { name: "🔑 Token Filter",       key: "token",         desc: "Detect & delete bot tokens"      },
      { name: "🚫 Spam Filter",        key: "spam",          desc: "Timeout spammers automatically"  },
      { name: "⚡ Mass Action Guard",  key: "mass_action",   desc: "Detect mass bans/kicks"          },
      { name: "🤖 Bot Verification",   key: "bot_verify",    desc: "Quarantine bots on join"         },
    ];

    const statusLines = modules.map(m => {
      const on = moduleEnabled(m.key);
      return `${on ? "✅" : "❌"} **${m.name}** — ${m.desc}`;
    }).join("\n");

    const e = new EmbedBuilder()
      .setTitle("🔒 Security Control Panel")
      .setDescription(
        `**CEO-only security controls for ${SERVER_NAME}**\n\n` +
        `${statusLines}\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `**Current Settings:**\n` +
        `📅 Alt threshold: **${config.alt_age_days} days**\n` +
        `🦵 Alt auto-kick: **${config.alt_auto_kick ? "✅ On" : "❌ Off"}**\n` +
        `🔗 Link timeout: **${config.link_timeout_mins} min**\n` +
        `🚫 Spam threshold: **${config.spam_threshold} msgs / ${config.spam_window_secs}s**\n` +
        `⏳ Spam timeout: **${config.spam_timeout_mins} min**\n` +
        `⚡ Mass action limit: **${config.mass_action_limit} in ${config.mass_action_window}s**`
      )
      .setColor(0x8B0000)
      .setThumbnail(SERVER_THUMBNAIL_URL)
      .setFooter({ text: `${SERVER_NAME} • CEO Security Panel` })
      .setTimestamp();

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("sec_toggle_alt").setLabel("Toggle ALT").setStyle(moduleEnabled("alt") ? ButtonStyle.Success : ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("sec_toggle_link").setLabel("Toggle Links").setStyle(moduleEnabled("link") ? ButtonStyle.Success : ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("sec_toggle_token").setLabel("Toggle Tokens").setStyle(moduleEnabled("token") ? ButtonStyle.Success : ButtonStyle.Danger),
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("sec_toggle_spam").setLabel("Toggle Spam").setStyle(moduleEnabled("spam") ? ButtonStyle.Success : ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("sec_toggle_mass").setLabel("Toggle Mass Action").setStyle(moduleEnabled("mass_action") ? ButtonStyle.Success : ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("sec_toggle_botverify").setLabel("Toggle Bot Verify").setStyle(moduleEnabled("bot_verify") ? ButtonStyle.Success : ButtonStyle.Danger),
    );
    const row3 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("sec_toggle_altkick").setLabel("ALT Auto-Kick").setStyle(config.alt_auto_kick ? ButtonStyle.Success : ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("sec_status").setLabel("📊 Status").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("sec_logs_btn").setLabel("📋 Recent Logs").setStyle(ButtonStyle.Secondary),
    );

    await message.channel.send({ embeds: [e], components: [row1, row2, row3] });
    const m = await message.reply("✅ Security Panel sent.");
    setTimeout(() => m.delete().catch(() => {}), 2000);
    return;
  }

  // ────────────────────────────────────────────────────────
  //  !secconfig <key> <value>
  // ────────────────────────────────────────────────────────
  if (command === "secconfig") {
    const key   = args[0];
    const value = args[1];

    const allowed = {
      alt_age_days:       v => { config.alt_age_days = parseInt(v);       return `Alt age threshold → **${config.alt_age_days} days**`; },
      alt_auto_kick:      v => { config.alt_auto_kick = v === "true";     return `Alt auto-kick → **${config.alt_auto_kick}**`; },
      link_filter:        v => { config.link_filter = v === "true";       return `Link filter → **${config.link_filter}**`; },
      token_filter:       v => { config.token_filter = v === "true";      return `Token filter → **${config.token_filter}**`; },
      spam_filter:        v => { config.spam_filter = v === "true";       return `Spam filter → **${config.spam_filter}**`; },
      spam_threshold:     v => { config.spam_threshold = parseInt(v);     return `Spam threshold → **${config.spam_threshold} msgs**`; },
      spam_window_secs:   v => { config.spam_window_secs = parseInt(v);   return `Spam window → **${config.spam_window_secs}s**`; },
      spam_timeout_mins:  v => { config.spam_timeout_mins = parseInt(v);  return `Spam timeout → **${config.spam_timeout_mins} min**`; },
      link_timeout_mins:  v => { config.link_timeout_mins = parseInt(v);  return `Link timeout → **${config.link_timeout_mins} min**`; },
      mass_action_limit:  v => { config.mass_action_limit = parseInt(v);  return `Mass action limit → **${config.mass_action_limit}**`; },
      mass_action_window: v => { config.mass_action_window = parseInt(v); return `Mass action window → **${config.mass_action_window}s**`; },
    };

    if (!key) {
      const lines = Object.entries(config)
        .filter(([k]) => k !== "whitelisted_bots" && k !== "disabled_modules")
        .map(([k, v]) => `\`${k}\` = **${v}**`)
        .join("\n");
      return message.reply(`📋 **Current Config:**\n${lines}\n\nUsage: \`!secconfig <key> <value>\``);
    }

    if (!allowed[key]) return message.reply(`❌ Unknown key: \`${key}\`\nValid: ${Object.keys(allowed).map(k => `\`${k}\``).join(", ")}`);
    const result = allowed[key](value);
    saveConfig();
    return message.reply(`✅ ${result}`);
  }

  // ────────────────────────────────────────────────────────
  //  !secdisable <module>  /  !secenable <module>
  // ────────────────────────────────────────────────────────
  if (command === "secdisable") {
    const mod = args[0];
    if (!mod) return message.reply("Usage: `!secdisable <module>`\nModules: `alt` `link` `token` `spam` `mass_action` `bot_verify`");
    if (!config.disabled_modules.includes(mod)) {
      config.disabled_modules.push(mod);
      saveConfig();
    }
    return message.reply(`🔴 Module **${mod}** disabled.`);
  }

  if (command === "secenable") {
    const mod = args[0];
    if (!mod) return message.reply("Usage: `!secenable <module>`\nModules: `alt` `link` `token` `spam` `mass_action` `bot_verify`");
    config.disabled_modules = config.disabled_modules.filter(m => m !== mod);
    saveConfig();
    return message.reply(`🟢 Module **${mod}** enabled.`);
  }

  // ────────────────────────────────────────────────────────
  //  !secstatus
  // ────────────────────────────────────────────────────────
  if (command === "secstatus") {
    const modules = ["alt", "link", "token", "spam", "mass_action", "bot_verify"];
    const lines = modules.map(m => `${moduleEnabled(m) ? "✅" : "❌"} \`${m}\``).join(" | ");
    const e = new EmbedBuilder()
      .setTitle("📊 Security Status").setColor(0x5865f2)
      .addFields(
        { name: "🔌 Modules",        value: lines, inline: false },
        { name: "📅 Alt threshold",  value: `${config.alt_age_days} days`, inline: true },
        { name: "🦵 Alt auto-kick",  value: config.alt_auto_kick ? "✅" : "❌", inline: true },
        { name: "🔗 Link timeout",   value: `${config.link_timeout_mins} min`, inline: true },
        { name: "🚫 Spam threshold", value: `${config.spam_threshold} / ${config.spam_window_secs}s`, inline: true },
        { name: "⏳ Spam timeout",   value: `${config.spam_timeout_mins} min`, inline: true },
        { name: "⚡ Mass limit",     value: `${config.mass_action_limit} / ${config.mass_action_window}s`, inline: true },
        { name: "🤖 Whitelisted bots", value: config.whitelisted_bots?.length > 0 ? config.whitelisted_bots.join(", ") : "None", inline: false },
      )
      .setFooter({ text: `${SERVER_NAME} • Security Status` })
      .setTimestamp();
    return message.reply({ embeds: [e] });
  }

  // ────────────────────────────────────────────────────────
  //  !seclogs [amount]
  // ────────────────────────────────────────────────────────
  if (command === "seclogs") {
    const amount = Math.min(parseInt(args[0]) || 10, 20);
    const events = (securityData.events || []).slice(0, amount);
    if (!events.length) return message.reply("📋 No security events logged yet.");

    const typeEmoji = { token_detected: "🔑", link_detected: "🔗", spam_detected: "🚫", alt_detected: "🚨", bot_join: "🤖", mass_action: "⚡" };
    const lines = events.map(ev => {
      const d = new Date(ev.ts);
      const ts = `<t:${Math.floor(ev.ts / 1000)}:R>`;
      return `${typeEmoji[ev.type] || "📌"} **${ev.type}** — ${ev.user || ev.bot || "?"} ${ts}`;
    }).join("\n");

    const e = new EmbedBuilder()
      .setTitle(`📋 Security Log (last ${amount})`)
      .setDescription(lines)
      .setColor(0x8B0000)
      .setFooter({ text: `${SERVER_NAME} • Security Logs` })
      .setTimestamp();
    return message.reply({ embeds: [e] });
  }

  // ────────────────────────────────────────────────────────
  //  !secwhitelist <botId>  /  !secunwhitelist <botId>
  // ────────────────────────────────────────────────────────
  if (command === "secwhitelist") {
    const id = args[0];
    if (!id) return message.reply("Usage: `!secwhitelist <botId>`");
    if (!config.whitelisted_bots) config.whitelisted_bots = [];
    if (!config.whitelisted_bots.includes(id)) {
      config.whitelisted_bots.push(id);
      saveConfig();
    }
    return message.reply(`✅ Bot \`${id}\` whitelisted — won't require verification.`);
  }

  if (command === "secunwhitelist") {
    const id = args[0];
    if (!id) return message.reply("Usage: `!secunwhitelist <botId>`");
    config.whitelisted_bots = (config.whitelisted_bots || []).filter(b => b !== id);
    saveConfig();
    return message.reply(`🔴 Bot \`${id}\` removed from whitelist.`);
  }

  // ────────────────────────────────────────────────────────
  //  !sechelp
  // ────────────────────────────────────────────────────────
  if (command === "sechelp") {
    if (!isCeo(member)) return;
    const e = new EmbedBuilder()
      .setTitle(`🔒 ${SERVER_NAME} — Security Bot Help`).setColor(0x8B0000)
      .setThumbnail(SERVER_THUMBNAIL_URL)
      .addFields(
        { name: "📋 Panels & Status", value:
          "`!secpanel` — Interactive CEO security panel\n" +
          "`!secstatus` — Quick module & config overview\n" +
          "`!seclogs [n]` — Show last n security events", inline: false },
        { name: "⚙️ Configuration", value:
          "`!secconfig` — Show all settings\n" +
          "`!secconfig <key> <value>` — Change a setting\n" +
          "Keys: `alt_age_days` `alt_auto_kick` `link_filter` `token_filter`\n" +
          "`spam_filter` `spam_threshold` `spam_window_secs` `spam_timeout_mins`\n" +
          "`link_timeout_mins` `mass_action_limit` `mass_action_window`", inline: false },
        { name: "🔌 Modules", value:
          "`!secenable <module>` — Enable a module\n" +
          "`!secdisable <module>` — Disable a module\n" +
          "Modules: `alt` `link` `token` `spam` `mass_action` `bot_verify`", inline: false },
        { name: "🤖 Bot Whitelist", value:
          "`!secwhitelist <botId>` — Skip verification for bot\n" +
          "`!secunwhitelist <botId>` — Remove from whitelist", inline: false },
      )
      .setFooter({ text: `${SERVER_NAME} • CEO Only` })
      .setTimestamp();
    return message.reply({ embeds: [e] });
  }
});

// ══════════════════════════════════════════════════════════════
//  INTERACTIONS (buttons)
// ══════════════════════════════════════════════════════════════
client.on("interactionCreate", async interaction => {
  try {
    if (!interaction.isButton()) return;
    const member = interaction.member;

    // ── Bot Accept / Deny ──────────────────────────────────
    if (interaction.customId.startsWith("bot_accept_")) {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator))
        return interaction.reply({ content: "❌ Admins only.", ephemeral: true });
      const botId = interaction.customId.replace("bot_accept_", "");
      delete pendingBots[botId];
      const botMember = interaction.guild.members.cache.get(botId);
      if (botMember) {
        for (const [, ch] of interaction.guild.channels.cache) {
          await ch.permissionOverwrites.delete(botMember, "Bot accepted").catch(() => {});
        }
      }
      const e = new EmbedBuilder()
        .setTitle("✅ Bot Accepted")
        .setDescription(`**${botMember?.user?.tag ?? botId}** was accepted by ${interaction.user}.`)
        .setColor(0x00ff00).setTimestamp();
      await interaction.message.edit({ embeds: [e], components: [] });
      return interaction.reply({ content: "✅ Bot accepted!", ephemeral: true });
    }

    if (interaction.customId.startsWith("bot_deny_")) {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator))
        return interaction.reply({ content: "❌ Admins only.", ephemeral: true });
      const botId     = interaction.customId.replace("bot_deny_", "");
      const botMember = interaction.guild.members.cache.get(botId);
      let kicked = false;
      if (botMember) await botMember.kick(`Bot denied by ${interaction.user.tag}`).then(() => kicked = true).catch(() => {});
      delete pendingBots[botId];
      const e = new EmbedBuilder()
        .setTitle("❌ Bot Denied & Kicked")
        .setDescription(`**${botMember?.user?.tag ?? botId}** kicked by ${interaction.user}.\nKick: ${kicked ? "✅" : "❌"}`)
        .setColor(0xff0000).setTimestamp();
      await interaction.message.edit({ embeds: [e], components: [] });
      return interaction.reply({ content: "❌ Bot denied and kicked.", ephemeral: true });
    }

    // ── Security Panel Buttons (CEO only) ─────────────────
    if (!isCeo(member)) return interaction.reply({ content: "❌ CEO only.", ephemeral: true });

    const toggleMap = {
      sec_toggle_alt:       "alt",
      sec_toggle_link:      "link",
      sec_toggle_token:     "token",
      sec_toggle_spam:      "spam",
      sec_toggle_mass:      "mass_action",
      sec_toggle_botverify: "bot_verify",
    };

    if (toggleMap[interaction.customId]) {
      const mod = toggleMap[interaction.customId];
      if (moduleEnabled(mod)) {
        config.disabled_modules.push(mod);
      } else {
        config.disabled_modules = config.disabled_modules.filter(m => m !== mod);
      }
      saveConfig();
      const now = moduleEnabled(mod);
      return interaction.reply({ content: `${now ? "🟢" : "🔴"} Module **${mod}** ${now ? "enabled" : "disabled"}.`, ephemeral: true });
    }

    if (interaction.customId === "sec_toggle_altkick") {
      config.alt_auto_kick = !config.alt_auto_kick;
      saveConfig();
      return interaction.reply({ content: `Alt auto-kick: ${config.alt_auto_kick ? "✅ Enabled" : "❌ Disabled"}`, ephemeral: true });
    }

    if (interaction.customId === "sec_status") {
      const modules = ["alt", "link", "token", "spam", "mass_action", "bot_verify"];
      const lines = modules.map(m => `${moduleEnabled(m) ? "✅" : "❌"} \`${m}\``).join(" | ");
      const e = new EmbedBuilder()
        .setTitle("📊 Security Status").setColor(0x5865f2)
        .addFields(
          { name: "🔌 Modules", value: lines, inline: false },
          { name: "📅 Alt threshold", value: `${config.alt_age_days} days`, inline: true },
          { name: "🦵 Auto-kick", value: config.alt_auto_kick ? "✅" : "❌", inline: true },
          { name: "🔗 Link timeout", value: `${config.link_timeout_mins} min`, inline: true },
          { name: "🚫 Spam", value: `${config.spam_threshold}/${config.spam_window_secs}s → ${config.spam_timeout_mins}min`, inline: true },
          { name: "⚡ Mass limit", value: `${config.mass_action_limit}/${config.mass_action_window}s`, inline: true },
        )
        .setFooter({ text: `${SERVER_NAME} • Security Status` })
        .setTimestamp();
      return interaction.reply({ embeds: [e], ephemeral: true });
    }

    if (interaction.customId === "sec_logs_btn") {
      const events = (securityData.events || []).slice(0, 10);
      if (!events.length) return interaction.reply({ content: "📋 No events logged yet.", ephemeral: true });
      const typeEmoji = { token_detected: "🔑", link_detected: "🔗", spam_detected: "🚫", alt_detected: "🚨", bot_join: "🤖", mass_action: "⚡" };
      const lines = events.map(ev => `${typeEmoji[ev.type] || "📌"} **${ev.type}** — ${ev.user || ev.bot || "?"} <t:${Math.floor(ev.ts / 1000)}:R>`).join("\n");
      const e = new EmbedBuilder()
        .setTitle("📋 Recent Security Events").setDescription(lines).setColor(0x8B0000).setTimestamp();
      return interaction.reply({ embeds: [e], ephemeral: true });
    }

  } catch (err) {
    console.error("Interaction error:", err);
    try {
      if (!interaction.replied && !interaction.deferred)
        await interaction.reply({ content: "❌ An error occurred.", ephemeral: true });
    } catch {}
  }
});

// ══════════════════════════════════════════════════════════════
//  MASS BAN / KICK EVENTS
// ══════════════════════════════════════════════════════════════
client.on("guildBanAdd", async ban => {
  const logs = await ban.guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.MemberBan }).catch(() => null);
  const mod  = logs?.entries.first()?.executor;
  if (mod) await trackMassAction(ban.guild, mod, "ban");
});

client.on("guildMemberRemove", async member => {
  await new Promise(r => setTimeout(r, 1000));
  const logs = await member.guild.fetchAuditLogs({ limit: 3, type: AuditLogEvent.MemberKick }).catch(() => null);
  if (logs) {
    for (const [, entry] of logs.entries) {
      if (entry.target?.id === member.id && (Date.now() - entry.createdTimestamp) < 5000) {
        await trackMassAction(member.guild, entry.executor, "kick");
        break;
      }
    }
  }
});

// ══════════════════════════════════════════════════════════════
//  READY
// ══════════════════════════════════════════════════════════════
client.once("ready", async () => {
  console.log(`✅ Security Bot logged in as ${client.user.tag}`);
  client.user.setActivity(`🔒 ${SERVER_NAME} Security`, { type: ActivityType.Watching });
  console.log(`🔒 ${SERVER_NAME} Security Bot is fully online!`);
});

// ══════════════════════════════════════════════════════════════
//  ERROR HANDLING
// ══════════════════════════════════════════════════════════════
client.on("error", err => console.error("Client error:", err));
process.on("unhandledRejection", err => console.error("Unhandled rejection:", err));

if (!TOKEN) {
  console.error("❌ TOKEN env variable is missing!");
  process.exit(1);
}
client.login(TOKEN);
