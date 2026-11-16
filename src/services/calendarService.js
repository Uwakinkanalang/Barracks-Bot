import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';

const TZ = 'Asia/Manila';
const key = (guildId) => `guild:${guildId}:calendar:events`;
const configKey = (guildId) => `guild:${guildId}:calendar:config';

export async function getCalendarConfig(client, guildId) {
  return client.db.get(configKey(guildId), { channelId: null, messageId: null });
}
export async function getCalendarEvents(client, guildId) {
  const value = await client.db.get(key(guildId), []);
  return Array.isArray(value) ? value : [];
}
export async function saveCalendarEvents(client, guildId, events) {
  await client.db.set(key(guildId), events);
}
function dateLabel(value) {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: TZ, dateStyle: 'medium', timeStyle: 'short'
  }).format(new Date(value));
}
function monthLabel(date) {
  return new Intl.DateTimeFormat('en-PH', { timeZone: TZ, month: 'long', year: 'numeric' }).format(date);
}
export function buildCalendarEmbed(guild, events, date = new Date()) {
  const month = date.toLocaleString('en-US', { timeZone: TZ, month: '2-digit' });
  const year = Number(new Intl.DateTimeFormat('en', { timeZone: TZ, year: 'numeric' }).format(date));
  const monthNum = Number(month);
  const inMonth = events.filter(e => {
    const d = new Date(e.startsAt);
    return d.getFullYear() === year && d.getMonth() + 1 === monthNum;
  }).sort((a,b) => new Date(a.startsAt) - new Date(b.startsAt));
  const embed = new EmbedBuilder()
    .setColor(0x336699)
    .setAuthor({ name: 'BARRACKS • OPERATIONS CALENDAR', iconURL: guild.iconURL() || undefined })
    .setTitle(`📅 ${monthLabel(date)}`)
    .setDescription(inMonth.length
      ? inMonth.map(e => `**${dateLabel(e.startsAt)}** • ${e.emoji || '📌'} **${e.title}**\n${e.description || 'No additional details.'}\n${e.location ? `📍 ${e.location}\n` : ''}🆔 \`${e.id}\``).join('\n\n').slice(0, 4000)
      : 'No operations scheduled this month. Enjoy the downtime, soldiers!')
    .setFooter({ text: 'Barracks • Stay ready, stay on schedule' })
    .setTimestamp();
  return embed;
}
export async function publishCalendar(client, guild) {
  const config = await getCalendarConfig(client, guild.id);
  if (!config.channelId) return false;
  const channel = await guild.channels.fetch(config.channelId).catch(() => null);
  if (!channel?.isTextBased() || !channel.send) return false;
  const events = await getCalendarEvents(client, guild.id);
  const embed = buildCalendarEmbed(guild, events);
  const existing = config.messageId ? await channel.messages.fetch(config.messageId).catch(() => null) : null;
  const message = existing
    ? await existing.edit({ embeds: [embed] })
    : await channel.send({ embeds: [embed] });
  await client.db.set(configKey(guild.id), { ...config, messageId: message.id });
  return true;
}
export async function refreshCalendars(client) {
  for (const guild of client.guilds.cache.values()) {
    try { await publishCalendar(client, guild); }
    catch (error) { client.logger?.error?.('Calendar refresh failed', { guildId: guild.id, error: error.message }); }
  }
}
export async function processCalendarReminders(client) {
  const now = Date.now();
  for (const guild of client.guilds.cache.values()) {
    const events = await getCalendarEvents(client, guild.id);
    let changed = false;
    for (const event of events) {
      if (event.cancelled) continue;
      for (const minutes of [1440, 60, 15]) {
        const flag = `reminded${minutes}`;
        const dueAt = new Date(event.startsAt).getTime() - minutes * 60000;
        if (!event[flag] && dueAt <= now && dueAt > now - 60000) {
          const config = await getCalendarConfig(client, guild.id);
          const channel = config.channelId ? await guild.channels.fetch(config.channelId).catch(() => null) : null;
          if (channel?.isTextBased()) {
            await channel.send(`⏰ **Barracks Reminder:** **${event.title}** starts ${minutes === 1440 ? 'in 24 hours' : `in ${minutes} minutes`} • <t:${Math.floor(new Date(event.startsAt).getTime()/1000)}:F>`);
          }
          event[flag] = true;
          changed = true;
        }
      }
    }
    if (changed) await saveCalendarEvents(client, guild.id, events);
  }
}
export function canManageCalendar(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) || interaction.guild?.ownerId === interaction.user.id);
}
