import { MessageFlags } from 'discord.js';
import { refreshEvent } from '../../../commands/Community/event.js';

export default {
 name: 'event',
 async execute(interaction, client, args) {
  const [action, status, eventId] = args;
  if (action !== 'rsvp' || !['going','maybe','cant'].includes(status) || !interaction.guildId) return;
  const events = await client.db.get(`guild:${interaction.guildId}:events`, []);
  const event = events.find(e => e.id === eventId);
  if (!event || event.closed || event.startsAt <= Date.now()) {
   return interaction.reply({ content: 'This event is already closed.', flags: MessageFlags.Ephemeral });
  }
  for (const key of ['going','maybe','cant']) event.rsvps[key] = (event.rsvps[key] || []).filter(id => id !== interaction.user.id);
  event.rsvps[status].push(interaction.user.id);
  await client.db.set(`guild:${interaction.guildId}:events`, events);
  await refreshEvent(client, event);
  return interaction.reply({ content: `Your RSVP has been changed to **${status === 'cant' ? "Can't" : status[0].toUpperCase()+status.slice(1)}**.`, flags: MessageFlags.Ephemeral });
 }
};
