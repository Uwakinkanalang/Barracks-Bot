import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { randomUUID } from 'node:crypto';
import {
  getCalendarConfig, getCalendarEvents, saveCalendarEvents, publishCalendar, canManageCalendar
} from '../../services/calendarService.js';

const data = new SlashCommandBuilder()
  .setName('calendar')
  .setDescription('View and manage the Barracks event calendar')
  .addSubcommand(s => s.setName('view').setDescription('Show this month\'s calendar'))
  .addSubcommand(s => s.setName('list').setDescription('List upcoming events'))
  .addSubcommand(s => s.setName('today').setDescription('Show today\'s events'))
  .addSubcommand(s => s.setName('setup').setDescription('Set the channel for the monthly calendar').addChannelOption(o => o.setName('channel').setDescription('Calendar announcement channel').setRequired(true)))
  .addSubcommand(s => s.setName('add').setDescription('Schedule a new event')
    .addStringOption(o => o.setName('title').setDescription('Event title').setMaxLength(100).setRequired(true))
    .addStringOption(o => o.setName('date').setDescription('Date in YYYY-MM-DD format (Manila time)').setRequired(true))
    .addStringOption(o => o.setName('time').setDescription('Time in 24-hour HH:MM format (Manila time)').setRequired(true))
    .addStringOption(o => o.setName('description').setDescription('Event details').setMaxLength(500))
    .addStringOption(o => o.setName('location').setDescription('Channel or location').setMaxLength(100))
    .addStringOption(o => o.setName('category').setDescription('Event category').addChoices(
      { name: 'Festivities', value: '🎉 Festivities' }, { name: 'Giveaway', value: '🎁 Giveaway' },
      { name: 'Meeting', value: '📋 Meeting' }, { name: 'Training', value: '🎖️ Training' },
      { name: 'Community', value: '🤝 Community' })))
  .addSubcommand(s => s.setName('edit').setDescription('Edit a scheduled event')
    .addStringOption(o => o.setName('id').setDescription('Event ID').setRequired(true))
    .addStringOption(o => o.setName('title').setDescription('New title').setMaxLength(100))
    .addStringOption(o => o.setName('date').setDescription('New date YYYY-MM-DD'))
    .addStringOption(o => o.setName('time').setDescription('New time HH:MM'))
    .addStringOption(o => o.setName('description').setDescription('New details').setMaxLength(500))
    .addStringOption(o => o.setName('location').setDescription('New location').setMaxLength(100)))
  .addSubcommand(s => s.setName('delete').setDescription('Delete a scheduled event')
    .addStringOption(o => o.setName('id').setDescription('Event ID').setRequired(true)));

function parseManilaDate(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const value = new Date(`${date}T${time}:00+08:00`);
  if (Number.isNaN(value.getTime()) || value.toISOString().slice(0,10) !== date) return null;
  return value.toISOString();
}
function upcoming(events) {
  return events.filter(e => !e.cancelled && new Date(e.startsAt).getTime() >= Date.now()).sort((a,b) => new Date(a.startsAt)-new Date(b.startsAt));
}
export default {
  data,
  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    if (['setup','add','edit','delete'].includes(sub) && !canManageCalendar(interaction)) {
      return interaction.reply({ content: '⛔ Only server administrators or members with Manage Server can manage the calendar.', ephemeral: true });
    }
    if (sub === 'setup') {
      const channel = interaction.options.getChannel('channel');
      if (!channel.isTextBased()) return interaction.reply({ content: 'Please choose a text channel.', ephemeral: true });
      const old = await getCalendarConfig(client, interaction.guildId);
      await client.db.set(`guild:${interaction.guildId}:calendar:config`, { channelId: channel.id, messageId: old.messageId || null });
      await publishCalendar(client, interaction.guild);
      return interaction.reply({ content: `✅ Barracks Calendar is now published in ${channel} and will update automatically.`, ephemeral: true });
    }
    const events = await getCalendarEvents(client, interaction.guildId);
    if (sub === 'add') {
      const startsAt = parseManilaDate(interaction.options.getString('date'), interaction.options.getString('time'));
      if (!startsAt || new Date(startsAt).getTime() <= Date.now()) return interaction.reply({ content: 'Enter a valid future date and time in Manila time.', ephemeral: true });
      const category = interaction.options.getString('category') || '📌 Event';
      const event = {
        id: randomUUID().slice(0,8), title: interaction.options.getString('title'),
        description: interaction.options.getString('description') || '', location: interaction.options.getString('location') || '',
        emoji: category.split(' ')[0], category, startsAt, createdBy: interaction.user.id,
        reminded1440: false, reminded60: false, reminded15: false, createdAt: new Date().toISOString()
      };
      events.push(event);
      await saveCalendarEvents(client, interaction.guildId, events);
      await publishCalendar(client, interaction.guild);
      return interaction.reply({ content: `✅ Added **${event.title}** to the Barracks Calendar. Event ID: \`${event.id}\` • <t:${Math.floor(new Date(startsAt).getTime()/1000)}:F>`, ephemeral: true });
    }
    if (sub === 'edit') {
      const id = interaction.options.getString('id');
      const event = events.find(e => e.id === id);
      if (!event) return interaction.reply({ content: 'Event ID not found.', ephemeral: true });
      const title = interaction.options.getString('title');
      const date = interaction.options.getString('date');
      const time = interaction.options.getString('time');
      if (date || time) {
        const current = new Date(event.startsAt);
        const currentDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year:'numeric', month:'2-digit', day:'2-digit' }).format(current);
        const currentTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).format(current);
        const parsed = parseManilaDate(date || currentDate, time || currentTime);
        if (!parsed || new Date(parsed).getTime() <= Date.now()) return interaction.reply({ content: 'Enter a valid future date and time in Manila time.', ephemeral: true });
        event.startsAt = parsed;
        event.reminded1440 = event.reminded60 = event.reminded15 = false;
      }
      if (title) event.title = title;
      for (const field of ['description','location']) {
        const value = interaction.options.getString(field);
        if (value !== null) event[field] = value;
      }
      event.updatedAt = new Date().toISOString();
      await saveCalendarEvents(client, interaction.guildId, events);
      await publishCalendar(client, interaction.guild);
      return interaction.reply({ content: `✅ Updated **${event.title}** (${id}).`, ephemeral: true });
    }
    if (sub === 'delete') {
      const id = interaction.options.getString('id');
      const next = events.filter(e => e.id !== id);
      if (next.length === events.length) return interaction.reply({ content: 'Event ID not found.', ephemeral: true });
      await saveCalendarEvents(client, interaction.guildId, next);
      await publishCalendar(client, interaction.guild);
      return interaction.reply({ content: `🗑️ Removed event \`${id}\` and updated the calendar.`, ephemeral: true });
    }
    const items = upcoming(events);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Manila', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
    const filtered = sub === 'today' ? items.filter(e => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(e.startsAt)) === today) : items;
    const lines = filtered.slice(0, 15).map(e => `• <t:${Math.floor(new Date(e.startsAt).getTime()/1000)}:F> — **${e.title}** \`ID: ${e.id}\``);
    return interaction.reply({ content: lines.length ? lines.join('\n') : 'No upcoming Barracks events found.', ephemeral: true });
  }
};
