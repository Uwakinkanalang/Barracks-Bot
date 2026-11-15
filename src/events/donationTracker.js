import { EmbedBuilder, Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getDonationExpiryDate } from '../services/donationExpiryService.js';

const DONATION_KEY = (guildId) => `guild:${guildId}:donations:records`;
const PESO = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', maximumFractionDigits: 2 });

export default {
  name: Events.MessageCreate,
  async execute(message, client) {
    if (!message.guild || message.author.bot) return;
    const match = message.content.trim().match(/^bdonate(?:\s+([\s\S]*))?$/i);
    if (!match) return;

    const args = (match[1] || '').trim().split(/\s+/).filter(Boolean);
    const action = (args.shift() || 'help').toLowerCase();

    try {
      if (['add', 'remove'].includes(action) && !message.member.permissions.has('ManageGuild') && !message.member.permissions.has('Administrator')) {
        await message.reply('❌ You need **Manage Server** permission to manage donation records.');
        return;
      }

      const records = await readRecords(client, message.guild.id);

      if (action === 'add') {
        const targetToken = args.shift();
        const amountToken = args.shift();
        const userId = targetToken?.match(/^<@!?(\d+)>$/)?.[1] || (targetToken && /^\d{17,20}$/.test(targetToken) ? targetToken : null);
        const amount = Number(String(amountToken || '').replace(/[₱,]/g, ''));
        const durationToken = args[0];
        const durationMonths = /^\\d+$/.test(durationToken || '') ? Number(args.shift()) : 1;
        const note = args.join(' ').slice(0, 300);

        if (!userId || !Number.isFinite(amount) || amount <= 0 || amount > 1000000000 || !Number.isInteger(durationMonths) || durationMonths < 1 || durationMonths > 120) {
          await message.reply('Usage: `bdonate add @member amount [note]`\nExample: `bdonate add @Soldier 5000 Server support`');
          return;
        }

        const member = await message.guild.members.fetch(userId).catch(() => null);
        if (!member) {
          await message.reply('❌ I could not find that member in this server.');
          return;
        }

        const record = {
          id: `D${Date.now().toString(36).toUpperCase()}`,
          userId,
          amount: Math.round(amount * 100) / 100,
          note,
          recordedBy: message.author.id,
          createdAt: createdAt.toISOString(),
          durationMonths,
          expiresAt: getDonationExpiryDate(createdAt, durationMonths),
          status: 'active',
          channelId: message.channel.id,
          remindersSent: [],
        };
        records.push(record);
        await writeRecords(client, message.guild.id, records);

        const embed = new EmbedBuilder()
          .setColor(0xD4AF37)
          .setTitle('💎 Donation Recorded')
          .setDescription(`Thank you, <@${userId}>, for supporting **${message.guild.name}**!`)
          .addFields(
            { name: 'Donation', value: `**${PESO.format(record.amount)}**`, inline: true },
            { name: 'Record ID', value: `\`${record.id}\``, inline: true },
            { name: 'Recorded by', value: `<@${record.recordedBy}>`, inline: true },
            { name: 'Valid for', value: `**${durationMonths} month(s)**`, inline: true },
            { name: 'Expires', value: `<t:${Math.floor(new Date(record.expiresAt).getTime() / 1000)}:D>`, inline: true },
            ...(note ? [{ name: 'Note', value: note }] : []),
          )
          .setThumbnail(member.displayAvatarURL())
          .setTimestamp(new Date(record.createdAt))
          .setFooter({ text: 'Barracks • Donor Registry' });
        await message.channel.send({ embeds: [embed] });
        return;
      }

      if (action === 'remove') {
        const id = args.shift()?.toUpperCase();
        const index = records.findIndex(record => record.id.toUpperCase() === id);
        if (index < 0) {
          await message.reply('❌ Donation record not found. Use `bdonate list` to view record IDs.');
          return;
        }
        const [removed] = records.splice(index, 1);
        await writeRecords(client, message.guild.id, records);
        await message.reply(`✅ Removed donation record \`${removed.id}\` for <@${removed.userId}> (${PESO.format(removed.amount)}).`);
        return;
      }

      if (action === 'list') {
        if (!records.length) {
          await message.reply('There are no donation records yet.');
          return;
        }
        const latest = [...records].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 15);
        const lines = latest.map(record => `• <@${record.userId}> — **${PESO.format(record.amount)}** — \`${record.id}\` — <t:${Math.floor(new Date(record.createdAt).getTime() / 1000)}:d>`);
        const embed = new EmbedBuilder()
          .setColor(0xD4AF37)
          .setTitle('💎 Barracks Donation Records')
          .setDescription(lines.join('\n').slice(0, 4000))
          .setFooter({ text: `Showing ${latest.length} of ${records.length} records` });
        await message.channel.send({ embeds: [embed] });
        return;
      }

      if (action === 'profile') {
        const token = args.shift();
        const userId = token?.match(/^<@!?(\d+)>$/)?.[1] || (token && /^\d{17,20}$/.test(token) ? token : message.author.id);
        const userRecords = records.filter(record => record.userId === userId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        const total = userRecords.reduce((sum, record) => sum + Number(record.amount || 0), 0);
        const embed = new EmbedBuilder()
          .setColor(0xD4AF37)
          .setTitle('💎 Donor Profile')
          .setDescription(`Member: <@${userId}>\n**Total donated: ${PESO.format(total)}**\nDonation entries: **${userRecords.length}**`)
          .addFields({ name: 'Recent donations', value: userRecords.length
            ? userRecords.slice(0, 10).map(record => `• ${PESO.format(record.amount)} — <t:${Math.floor(new Date(record.createdAt).getTime() / 1000)}:d> (${record.id})`).join('\n')
            : 'No donations recorded.' })
          .setTimestamp();
        await message.channel.send({ embeds: [embed] });
        return;
      }

      if (action === 'leaderboard') {
        const totals = aggregate(records);
        const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
        const description = ranked.length
          ? ranked.map(([userId, total], index) => `**${index + 1}.** <@${userId}> — ${PESO.format(total)}`).join('\n')
          : 'No donations recorded yet.';
        const embed = new EmbedBuilder().setColor(0xD4AF37).setTitle('🏆 Barracks Donor Leaderboard').setDescription(description).setFooter({ text: `${totals.size} donor(s) • ${records.length} donation(s)` });
        await message.channel.send({ embeds: [embed] });
        return;
      }

      if (action === 'total') {
        const total = records.reduce((sum, record) => sum + Number(record.amount || 0), 0);
        const embed = new EmbedBuilder()
          .setColor(0xD4AF37)
          .setTitle('💰 Barracks Donation Summary')
          .addFields(
            { name: 'Total received', value: `**${PESO.format(total)}**`, inline: true },
            { name: 'Registered donors', value: `**${aggregate(records).size}**`, inline: true },
            { name: 'Donation entries', value: `**${records.length}**`, inline: true },
          )
          .setTimestamp();
        await message.channel.send({ embeds: [embed] });
        return;
      }

      await message.reply([
        '**💎 Barracks Donation Tracker**',
        '`bdonate add @member amount [months] [note]` — Record a donation (staff only; defaults to 1 month)',
        '`bdonate remove record_id` — Remove a record (staff only)',
        '`bdonate list` — Show latest donation records',
        '`bdonate profile [@member]` — View a donor profile',
        '`bdonate leaderboard` — Top donors by total amount',
        '`bdonate total` — Server donation summary',
      ].join('\n'));
    } catch (error) {
      logger.error('Donation tracker command failed:', error);
      await message.reply('❌ I could not complete that donation command. Please check the bot database and try again.').catch(() => {});
    }
  },
};

async function readRecords(client, guildId) {
  const value = await client.db.get(DONATION_KEY(guildId), []);
  return Array.isArray(value) ? value.filter(record => record && record.id && record.userId) : [];
}

async function writeRecords(client, guildId, records) {
  if (!client.db || typeof client.db.set !== 'function') throw new Error('Database is unavailable');
  await client.db.set(DONATION_KEY(guildId), records);
}

function aggregate(records) {
  const totals = new Map();
  for (const record of records) {
    totals.set(record.userId, (totals.get(record.userId) || 0) + Number(record.amount || 0));
  }
  return totals;
}
