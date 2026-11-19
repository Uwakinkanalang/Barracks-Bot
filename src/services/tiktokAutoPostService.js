import axios from 'axios';
import { EmbedBuilder } from 'discord.js';

const KEY = guildId => `guild:${guildId}:tiktokAutoPost`;
const PROFILE_URL = username => `https://www.tiktok.com/@${encodeURIComponent(username)}`;
const FEED_URL = username => `https://rsshub.app/tiktok/user/${encodeURIComponent(username)}`;

function tag(xml, name) {
  const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/\\s*${name}\\s*>`, 'i'));
  return match ? match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim() : '';
}

function parseItems(xml) {
  return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map(([, item]) => {
    const link = tag(item, 'link') || (item.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1] ?? '');
    return { title: tag(item, 'title'), link, guid: tag(item, 'guid') || link, date: tag(item, 'pubDate') };
  }).filter(item => item.link && /tiktok\.com\//i.test(item.link));
}

export async function processTikTokFeeds(client) {
  for (const guild of client.guilds.cache.values()) {
    const config = await client.db.get(KEY(guild.id), { channelId: null, accounts: [] });
    if (!config?.channelId || !Array.isArray(config.accounts) || !config.accounts.length) continue;
    const channel = await client.channels.fetch(config.channelId).catch(() => null);
    if (!channel?.isTextBased() || !channel.send) continue;

    let changed = false;
    for (const account of config.accounts) {
      try {
        const response = await axios.get(FEED_URL(account.username), {
          timeout: 15000,
          headers: { 'User-Agent': 'Mozilla/5.0 BarracksBot TikTok feed monitor' },
          responseType: 'text',
        });
        const items = parseItems(response.data).slice(0, 10);
        if (!items.length) continue;
        const newestFirst = items.reverse();
        if (!account.lastVideoId) {
          account.lastVideoId = newestFirst[newestFirst.length - 1].guid;
          account.lastCheckedAt = new Date().toISOString();
          changed = true;
          continue;
        }
        const previousIndex = newestFirst.findIndex(item => item.guid === account.lastVideoId);
        const fresh = previousIndex >= 0 ? newestFirst.slice(previousIndex + 1) : newestFirst.filter(item => item.guid !== account.lastVideoId).slice(-3);
        for (const item of fresh) {
          const embed = new EmbedBuilder()
            .setColor(0x111111)
            .setAuthor({ name: `New TikTok from @${account.username}`, url: PROFILE_URL(account.username) })
            .setTitle(item.title?.slice(0, 250) || 'Watch the new TikTok video')
            .setURL(item.link)
            .setDescription(`[▶ Watch on TikTok](${item.link})`)
            .setFooter({ text: 'Barracks-Bot • TikTok Auto-Post' });
          if (item.date && !Number.isNaN(Date.parse(item.date))) embed.setTimestamp(new Date(item.date));
          await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
        }
        account.lastVideoId = newestFirst[newestFirst.length - 1].guid;
        account.lastCheckedAt = new Date().toISOString();
        changed = true;
      } catch (error) {
        // RSS providers can rate-limit or temporarily fail; retry on the next poll.
        console.warn(`TikTok feed check failed for @${account.username}:`, error.message);
      }
    }
    if (changed) await client.db.set(KEY(guild.id), config);
  }
}

export function getTikTokConfigKey(guildId) {
  return KEY(guildId);
}
