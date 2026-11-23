import {
    ChannelType,
    EmbedBuilder,
    MessageFlags,
    SlashCommandBuilder,
} from 'discord.js';

const CONFESSIONS_KEY = (guildId) => `guild:${guildId}:confessions`;
const guildLocks = new Map();

async function withGuildLock(guildId, task) {
    const previous = guildLocks.get(guildId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    guildLocks.set(guildId, current);

    await previous;
    try {
        return await task();
    } finally {
        release();
        if (guildLocks.get(guildId) === current) {
            guildLocks.delete(guildId);
        }
    }
}

export default {
    data: new SlashCommandBuilder()
        .setName('confess')
        .setDescription('Post an anonymous confession')
        .addStringOption((option) =>
            option
                .setName('message')
                .setDescription('The confession you want to share anonymously')
                .setMinLength(1)
                .setMaxLength(3500)
                .setRequired(true),
        )
        .addChannelOption((option) =>
            option
                .setName('channel')
                .setDescription('Where the anonymous confession should be posted')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setRequired(true),
        ),

    category: 'Community',

    async execute(interaction, guildConfig, client) {
        if (!interaction.inGuild()) {
            return interaction.reply({
                content: 'This command can only be used inside a server.',
                flags: MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const confessionText = interaction.options.getString('message', true).trim();
        const channel = interaction.options.getChannel('channel', true);

        if (!confessionText) {
            return interaction.editReply('Please enter a confession before submitting.');
        }

        if (!channel?.isTextBased() || typeof channel.send !== 'function') {
            return interaction.editReply('Please choose a text channel where I can post.');
        }

        const botMember = interaction.guild.members.me;
        const permissions = channel.permissionsFor(botMember);
        if (!permissions?.has(['ViewChannel', 'SendMessages', 'EmbedLinks', 'CreatePublicThreads', 'SendMessagesInThreads'])) {
            return interaction.editReply(
                `I need View Channel, Send Messages, Embed Links, Create Public Threads, and Send Messages in Threads in ${channel}.`,
            );
        }

        const key = CONFESSIONS_KEY(interaction.guildId);

        try {
            const confession = await withGuildLock(interaction.guildId, async () => {
                const stored = await client.db.get(key, { nextNumber: 1, entries: {} });
                const state = stored && typeof stored === 'object'
                    ? stored
                    : { nextNumber: 1, entries: {} };
                const entries = state.entries && typeof state.entries === 'object'
                    ? state.entries
                    : {};
                const number = Math.max(1, Number(state.nextNumber) || 1);

                const embed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle(`Confession #${number}`)
                    .setDescription(confessionText)
                    .setFooter({ text: 'Anonymous' })
                    .setTimestamp();

                const postedMessage = await channel.send({
                    embeds: [embed],
                    allowedMentions: { parse: [] },
                });

                const record = {
                    number,
                    userId: interaction.user.id,
                    channelId: channel.id,
                    messageId: postedMessage.id,
                    createdAt: new Date().toISOString(),
                };

                entries[String(number)] = record;
                await client.db.set(key, {
                    nextNumber: number + 1,
                    entries,
                });

                return { number, postedMessage, record };
            });

            let threadCreated = false;
            try {
                await confession.postedMessage.startThread({
                    name: `Confession #${confession.number} • Replies`,
                    autoArchiveDuration: 1440,
                    reason: 'Open a discussion thread for an anonymous confession',
                });
                threadCreated = true;
            } catch (error) {
                // The confession is already published and recorded; do not lose it if thread creation fails.
                threadCreated = false;
            }

            return interaction.editReply(
                threadCreated
                    ? `Your confession was posted anonymously in ${channel} as **Confession #${confession.number}**. A reply thread is now open.`
                    : `Your confession was posted anonymously in ${channel} as **Confession #${confession.number}**, but I could not open its reply thread. Please check my thread permissions.`,
            );
        } catch (error) {
            return interaction.editReply('I could not save or post your confession. Please try again later.');
        }
    },
};
