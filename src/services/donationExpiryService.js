import { logger } from '../utils/logger.js';

const DONATION_KEY = (guildId) => `guild:${guildId}:donations:records`;
const REMINDER_DAYS = [30, 7, 3];

function addCalendarMonths(date, months) {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function subtractDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() - days);
  return result;
}

async function readRecords(client, guildId) {
  const value = await client.db.get(DONATION_KEY(guildId), []);
  return Array.isArray(value) ? value.filter(record => record && record.id && record.userId) : [];
}

export async function checkDonationExpirations(client) {
  if (!client?.db || !client.guilds?.cache) return;
  const now = new Date();
  for (const [guildId, guild] of client.guilds.cache) {
    try {
      const records = await readRecords(client, guildId);
      let changed = false;
      for (const record of records) {
        if (!record.expiresAt || record.status === 'expired' || record.status === 'renewed') continue;
        const expiresAt = new Date(record.expiresAt);
        if (Number.isNaN(expiresAt.getTime())) continue;
        const channel = record.channelId ? await guild.channels.fetch(record.channelId).catch(() => null) : null;
        const sent = new Set(Array.isArray(record.remindersSent) ? record.remindersSent : []);
        if (now >= expiresAt) {
          record.status = 'expired';
          record.expiredAt = now.toISOString();
          changed = true;
          if (channel?.isTextBased()) await channel.send({ content: `⏰ **Donation period expired**\n<@${record.userId}>'s ${record.durationMonths || 1}-month donation period has ended. Staff can record a renewal with \`bdonate add @member amount months\`.` }).catch(error => logger.warn(`Could not send donation expiry notice for ${record.id}:`, error));
          continue;
        }
        for (const days of REMINDER_DAYS) {
          if (sent.has(days) || now < subtractDays(expiresAt, days)) continue;
          if (channel?.isTextBased()) {
            await channel.send({ content: `⚠️ **Donation expiring in ${days} days**\n<@${record.userId}>'s donation period expires <t:${Math.floor(expiresAt.getTime() / 1000)}:R>. Please contact the donor about renewal.` });
            sent.add(days);
            record.remindersSent = [...sent].sort((a, b) => b - a);
            changed = true;
          }
        }
      }
      if (changed) await client.db.set(DONATION_KEY(guildId), records);
    } catch (error) { logger.error(`Donation expiry check failed for guild ${guildId}:`, error); }
  }
}

export function getDonationExpiryDate(startDate, months) {
  return addCalendarMonths(startDate, months).toISOString();
}