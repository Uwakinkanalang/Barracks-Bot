import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits,
  StringSelectMenuBuilder
} from 'discord.js';

const TZ = 'Asia/Manila';
const key = (guildId) => `guild:${guildId}:calendar:events`;
const configKey = (guildId) => `guild:${guildId}:calendar:config`;

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
function partsInManila(value) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(value));
  return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
}
function monthKey(date) {
  const p = partsInManila(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}
function parseMonth(value) {
  if (!/^\d{4}-\d{2}$/.test(value || '')) return new Date();
  const [year, month] = value.split('-').map(Number);
  if (month < 1 || month > 12) return new Date();
  return new Date(Date.UTC(year, month - 1, 1, 12));
}
function monthLabel(date) {
  return new Intl.DateTimeFormat('en-PH', { timeZone: TZ, month: 'long', year: 'numeric' }).format(date);
}
function eventDateKey(event) {
  const p = partsInManila(event.startsAt);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
function dateLabel(value) {
  return new Intl.DateTimeFormat('en-PH', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
function buildCalendarEmbed(guild, events, date = new Date()) {
  const keyForMonth = monthKey(date);
  const [year, month] = keyForMonth.split('-').map(Number);
  const monthEvents = events.filter(e => !e.cancelled && eventDateKey(e).startsWith(keyForMonth))
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
  const eventDays = new Set(monthEvents.map(eventDateKey));
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells = Array(firstWeekday).fill('  ');
  for (let day = 1; day <= daysInMonth; day++) {
    const dayKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    cells.push(`${String(day).padStart(2, '0')}${eventDays.has(dayKey) ? '•' : ' '}`);
  }
  while (cells.length % 7) cells.push('  ');
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7).join(' '));
  const grid = ['Su Mo Tu We Th Fr Sa', ...weeks].join('\n');
  const agenda = monthEvents.slice(0, 12).map(e => {
    const p = partsInManila(e.startsAt);
    const clock = new Intl.DateTimeFormat('en-PH', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(e.startsAt));
    return `**${String(p.day).padStart(2, '0')}** ${e.emoji || '📌'} **${e.title}** · ${clock}`;
  });
  const embed = new EmbedBuilder()
    .setColor(0x243B53)
    .setAuthor({ name: 'BARRACKS • OPERATIONS CALENDAR', iconURL: guild.iconURL() || undefined })
    .setTitle(`📅 ${monthLabel(date)}`)
    .setDescription(`\`\`\`\n${grid}\n\`\`\`\n**• Scheduled event**\n\n${agenda.length ? agenda.join('\n') : 'No operations scheduled this month. Enjoy the downtime, soldiers!'}`)
    .setFooter({ text: 'Use the arrows to change months • Select an event for details • Asia/Manila time' })
    .setTimestamp();
  return { embed, monthEvents };
}
export function buildCalendarPayload(guild, events, date = new Date()) {
  const { embed, monthEvents } = buildCalendarEmbed(guild, events, date);
  const guildId = guild.id;
  const month = monthKey(date);
  const navigation = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`bcal:prev:${guildId}:${month}`).setLabel('Previous').setEmoji('◀️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`bcal:today:${guildId}:${month}`).setLabel('Today').setEmoji('📍').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`bcal:next:${guildId}:${month}`).setLabel('Next').setEmoji('▶️').setStyle(ButtonStyle.Secondary)
  );
  const components = [navigation];
  if (monthEvents.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`bcal:event:${guildId}`)
      .setPlaceholder('View event details…')
      .addOptions(monthEvents.slice(0, 25).map(e => ({
        label: e.title.slice(0, 100),
        description: `${dateLabel(e.startsAt)} · ${e.category || 'Event'}`.slice(0, 100),
        value: e.id,
        emoji: e.emoji || '📌'
      })));
    components.push(new ActionRowBuilder().addComponents(menu));
  }
  return { embeds: [embed], components };
}
export async function publishCalendar(client, guild) {
  const config = await getCalendarConfig(client, guild.id);
  if (!config.channelId) return false;
  const channel = await guild.channels.fetch(config.channelId).catch(() => null);
  if (!channel?.isTextBased() || !channel.send) return false;
  const events = await getCalendarEvents(client, guild.id);
  const payload = buildCalendarPayload(guild, events, new Date());
  const existing = config.messageId ? await channel.messages.fetch(config.messageId).catch(() => null) : null;
  const message = existing ? await existing.edit(payload) : await channel.send(payload);
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
export function parseCalendarMonth(value) {
  return parseMonth(value);
}
export function formatCalendarEvent(event) {
  return [
    `📅 **${event.title}**`,
    `🕒 ${dateLabel(event.startsAt)}`,
    `🏷️ ${event.category || 'Event'}`,
    event.location ? `📍 ${event.location}` : null,
    event.description || 'No additional details provided.',
    `🆔 \`${event.id}\``,
    event.createdBy ? `Hosted by <@${event.createdBy}>` : null
  ].filter(Boolean).join('\n');
}
