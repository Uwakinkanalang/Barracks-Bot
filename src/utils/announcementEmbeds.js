import { EmbedBuilder } from 'discord.js';
import { formatWelcomeMessage } from './welcome.js';

export function buildMemberAnnouncementEmbed(settings = {}, data = {}, defaults = {}) {
  const resolve = (value) => formatWelcomeMessage(String(value ?? ''), data);
  const color = /^#[0-9a-fA-F]{6}$/.test(settings.color || '') ? settings.color : (defaults.color || '#36393f');
  const embed = new EmbedBuilder().setColor(color);
  const authorName = resolve(settings.authorName);
  const title = resolve(settings.title);
  const description = resolve(settings.description);
  const thumbnailUrl = settings.thumbnailUrl || defaults.thumbnailUrl;
  const imageUrl = settings.imageUrl || defaults.imageUrl;
  const footerText = resolve(settings.footerText);
  if (authorName) embed.setAuthor({ name: authorName.slice(0, 256) });
  if (title) embed.setTitle(title.slice(0, 256));
  if (description) embed.setDescription(description.slice(0, 4096));
  if (thumbnailUrl) embed.setThumbnail(thumbnailUrl);
  if (imageUrl) embed.setImage(imageUrl);
  if (footerText) {
    const footer = { text: footerText.slice(0, 2048) };
    if (settings.footerIconUrl) footer.iconURL = settings.footerIconUrl;
    embed.setFooter(footer);
  }
  return embed;
}
