import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';

export const STARBOARD_CHANNEL_ID = '1540687292719439944';
export const STARBOARD_EMOJI = '⭐';
export const STARBOARD_THRESHOLD = 5;

async function fetchStarboardChannel(client) {
  const channel = await client.channels.fetch(STARBOARD_CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased() || !channel.messages || !channel.send) {
    logger.warn(`Starboard channel ${STARBOARD_CHANNEL_ID} is missing or is not a text channel.`);
    return null;
  }
  return channel;
}

async function findStarboardPost(channel, sourceMessageId) {
  const recent = await channel.messages.fetch({ limit: 100 }).catch(error => {
    logger.warn('Could not read recent starboard posts:', error);
    return null;
  });
  if (!recent) return null;
  return recent.find(post =>
    post.author?.id === channel.client.user.id &&
    post.embeds.some(embed => embed.footer?.text === `Barracks Starboard | ${sourceMessageId}`)
  ) || null;
}

function buildStarboardEmbed(message, starCount) {
  const embed = new EmbedBuilder()
    .setColor(0xFEE75C)
    .setTitle('⭐ Community Starboard')
    .setURL(message.url)
    .setAuthor({
      name: message.member?.displayName || message.author.globalName || message.author.username,
      iconURL: message.author.displayAvatarURL({ size: 256 }),
    })
    .setDescription((message.content || '*No text content.*').slice(0, 4000))
    .addFields(
      { name: '⭐ Stars', value: String(starCount), inline: true },
      { name: '📍 Original Channel', value: `<#${message.channel.id}>`, inline: true },
    )
    .setFooter({ text: `Barracks Starboard | ${message.id}` })
    .setTimestamp(message.createdAt);

  const image = message.attachments.find(attachment =>
    attachment.contentType?.startsWith('image/')
  );
  if (image) embed.setImage(image.url);

  const otherAttachments = message.attachments
    .filter(attachment => !attachment.contentType?.startsWith('image/'))
    .map(attachment => `[${attachment.name || 'Attachment'}](${attachment.url})`)
    .slice(0, 5);
  if (otherAttachments.length) {
    embed.addFields({ name: 'Attachments', value: otherAttachments.join('\n').slice(0, 1024) });
  }

  return embed;
}

export async function syncStarboardPost(message, starCount, client) {
  if (!message?.guild || !message.author || message.author.bot) return;
  if (message.channelId === STARBOARD_CHANNEL_ID) return;

  const channel = await fetchStarboardChannel(client);
  if (!channel) return;

  const existing = await findStarboardPost(channel, message.id);
  if (starCount < STARBOARD_THRESHOLD) {
    if (existing) {
      await existing.delete().catch(error => logger.warn('Could not remove a starboard post below the threshold:', error));
    }
    return;
  }

  const embed = buildStarboardEmbed(message, starCount);
  if (existing) {
    await existing.edit({ embeds: [embed], allowedMentions: { parse: [] } }).catch(error => {
      logger.error('Could not update a starboard post:', error);
    });
    return;
  }

  const post = await channel.send({
    embeds: [embed],
    allowedMentions: { parse: [] },
  });

  try {
    const botMember = channel.guild.members.me || await channel.guild.members.fetchMe();
    if (botMember.permissionsIn(channel).has(PermissionFlagsBits.ManageMessages)) {
      await post.pin();
    } else {
      logger.warn('Starboard post was created but could not be pinned: missing Manage Messages permission.');
    }
  } catch (error) {
    logger.warn('Starboard post was created but pinning failed:', error);
  }
}

export async function removeStarboardPost(sourceMessageId, client) {
  const channel = await fetchStarboardChannel(client);
  if (!channel) return;
  const existing = await findStarboardPost(channel, sourceMessageId);
  if (existing) {
    await existing.delete().catch(error => logger.warn('Could not remove deleted source from starboard:', error));
  }
}

export async function getHumanStarCount(reaction) {
  const users = await reaction.users.fetch({ limit: 100 }).catch(error => {
    logger.warn('Could not fetch users for a starboard reaction:', error);
    return null;
  });
  if (!users) return null;
  return users.filter(user => !user.bot).size;
}

export { STARBOARD_EMOJI };
