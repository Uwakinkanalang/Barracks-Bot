import { SlashCommandBuilder, ChannelType, MessageFlags, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';

const TZ = 'Asia/Manila';
const KEY = id => `guild:${id}:events`;
const fmt = ms => new Intl.DateTimeFormat('en-PH', { timeZone: TZ, dateStyle: 'full', timeStyle: 'short' }).format(new Date(ms));
const names = { going: 'Going', maybe: 'Maybe', cant: "Can't" };

function card(event, closed = false) {
  const members = event.rsvps || { going: [], maybe: [], cant: [] };
  const list = key => members[key].length ? members[key].map(id => `<@${id}>`).join(', ') : '*Nobody yet*';
  const when = closed ? 'This event has taken place.' : `<t:${Math.floor(event.startsAt / 1000)}:R>`;
  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`# 📅 ${event.title}\n🗓️ **${fmt(event.startsAt)} (PHT)**\n⏳ ${when}`)
  ).addSeparatorComponents(new SeparatorBuilder().setDivider(true)).addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`🟩 **Going (${members.going.length})**\n${list('going')}\n\n🟨 **Maybe (${members.maybe.length})**\n${list('maybe')}\n\n❌ **Can't Make It (${members.cant.length})**\n${list('cant')}`)
  );
  if (!closed) container.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`event:rsvp:going:${event.id}`).setLabel('Going').setEmoji('🟩').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`event:rsvp:maybe:${event.id}`).setLabel('Maybe').setEmoji('🟨').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`event:rsvp:cant:${event.id}`).setLabel("Can't").setEmoji('❌').setStyle(ButtonStyle.Danger)
  ));
  return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

async function save(client, guildId, events) { await client.db.set(KEY(guildId), events); }
export async function refreshEvent(client, event, closed = false) {
  const channel = await client.channels.fetch(event.channelId).catch(() => null);
  const message = channel && await channel.messages.fetch(event.messageId).catch(() => null);
  if (message) await message.edit(card(event, closed));
}
export async function processEvents(client) {
  for (const guild of client.guilds.cache.values()) {
    const events = await client.db.get(KEY(guild.id), []);
    let changed = false;
    for (const event of events) {
      if (event.closed) continue;
      if (!event.reminded && event.startsAt - Date.now() <= 900000 && event.startsAt > Date.now()) {
        const channel = await client.channels.fetch(event.channelId).catch(() => null);
        if (channel) {
          const ids = event.rsvps.going;
          if (ids.length) await channel.send({ content: `⏰ **Reminder:** ${event.title} starts in 15 minutes!\n${ids.map(id => `<@${id}>`).join(' ')}`, allowedMentions: { users: ids } }).catch(() => {});
        }
        event.reminded = true; changed = true;
      }
      if (event.startsAt <= Date.now()) {
        if (event.repeatWeekly) {
          event.startsAt += 7 * 24 * 60 * 60 * 1000;
          event.rsvps = { going: [], maybe: [], cant: [] };
          event.reminded = false;
        } else {
          event.closed = true;
        }
        changed = true;
        await refreshEvent(client, event, event.closed);
      } else {
        await refreshEvent(client, event);
      }
    }
    if (changed) await save(client, guild.id, events);
  }
}

export default {
 data: new SlashCommandBuilder().setName('event').setDescription('Create and view Barracks events')
  .addSubcommand(s => s.setName('create').setDescription('Create an event with RSVPs')
   .addStringOption(o => o.setName('title').setDescription('Event title').setMaxLength(100).setRequired(true))
   .addStringOption(o => o.setName('date').setDescription('Date and time in PHT (YYYY-MM-DD HH:mm)').setRequired(true))
   .addChannelOption(o => o.setName('channel').setDescription('Where to post the event card').addChannelTypes(ChannelType.GuildText).setRequired(true))
   .addBooleanOption(o => o.setName('weekly').setDescription('Repeat every week').setRequired(false)))
  .addSubcommand(s => s.setName('list').setDescription('Show upcoming events')),
 async execute(interaction) {
  if (!interaction.inGuild()) return interaction.reply({ content: 'Use this command in a server.', flags: MessageFlags.Ephemeral });
  const events = await interaction.client.db.get(KEY(interaction.guildId), []);
  if (interaction.options.getSubcommand() === 'list') {
    const upcoming = events.filter(e => !e.closed).sort((a,b) => a.startsAt-b.startsAt);
    return interaction.reply({ content: upcoming.length ? upcoming.map(e => `• **${e.title}** — <t:${Math.floor(e.startsAt/1000)}:F> in <#${e.channelId}>${e.repeatWeekly ? ' 🔁 Weekly' : ''}`).join('\n') : 'There are no upcoming events.', flags: MessageFlags.Ephemeral });
  }
  const title = interaction.options.getString('title');
  const raw = interaction.options.getString('date');
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(raw);
  if (!match) return interaction.reply({ content: 'Use YYYY-MM-DD HH:mm in Philippine Time (24-hour format).', flags: MessageFlags.Ephemeral });
  const [, y, mo, d, h, mi] = match.map(Number);
  const startsAt = Date.UTC(y, mo-1, d, h-8, mi);
  const check = new Date(startsAt);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo-1 || check.getUTCDate() !== d || check.getUTCHours() !== h-8 || check.getUTCMinutes() !== mi || startsAt <= Date.now()) return interaction.reply({ content: 'Please provide a valid future date and time in Philippine Time.', flags: MessageFlags.Ephemeral });
  const channel = interaction.options.getChannel('channel');
  const event = { id: `${Date.now().toString(36)}${interaction.user.id.slice(-4)}`, title, startsAt, channelId: channel.id, repeatWeekly: interaction.options.getBoolean('weekly') || false, reminded: false, closed: false, rsvps: { going: [], maybe: [], cant: [] } };
  const message = await channel.send(card(event));
  event.messageId = message.id;
  events.push(event);
  await save(interaction.client, interaction.guildId, events);
  return interaction.reply({ content: `✅ Event **${title}** created in <#${channel.id}>.${event.repeatWeekly ? ' It will reuse this same card every week.' : ''}`, flags: MessageFlags.Ephemeral });
 }
};
