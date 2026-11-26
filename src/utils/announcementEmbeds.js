import { EmbedBuilder } from 'discord.js';
import { formatWelcomeMessage } from './welcome.js';

export function buildMemberAnnouncementEmbed(settings = {}, data = {}, defaults = {}) {
  const resolve = (value) => formatWelcomeMessage(String(value ?? ''), data);
  // Discord doesn't render user mentions inside embed titles, author names, or footers.
  // Replace mention syntax there with the member's display name to avoid showing raw <@id>.
  const resolvePlainText = (value) => resolve(value).replace(/<@!?(\d+)>/g,
    () => data.member?.displayName || data.user?.globalName || data.user?.username || 'Member');
  const color = /^#[0-9a-fA-F]{6}$/.test(settings.color || '') ? settings.color : (defaults.color || '#36393f');
  const embed = new EmbedBuilder().setColor(color);
  const authorName = resolvePlainText(settings.authorName);
  const title = resolvePlainText(settings.title);
  const description = resolve(settings.description);
  const thumbnailUrl = resolve(settings.thumbnailUrl || defaults.thumbnailUrl || '');
  const imageUrl = resolve(settings.imageUrl || defaults.imageUrl || '');
  // Older welcome configurations store footer text under `footer`; newer dashboard settings use `footerText`.
  const fallbackFooterText = data.guild?.memberCount != null
    ? `We already have ${Number(data.guild.memberCount).toLocaleString('en-US')} members`
    : 'We already have our members';
  const footerText = resolvePlainText(settings.footerText ?? settings.footer) || fallbackFooterText;
  if (authorName) embed.setAuthor({ name: authorName.slice(0, 256) });
  if (title) embed.setTitle(title.slice(0, 256));
  if (description) embed.setDescription(description.slice(0, 4096));
  if (thumbnailUrl) embed.setThumbnail(thumbnailUrl);
  if (imageUrl) embed.setImage(imageUrl);
  if (footerText) {
    const footer = { text: footerText.slice(0, 2048) };
    const footerIconUrl = settings.footerIconUrl || 'https://cdn.discordapp.com/emojis/1573225271983738930.png?size=64&quality=lossless';
    footer.iconURL = resolve(footerIconUrl);
    embed.setFooter(footer);
  }
  return embed;
}
