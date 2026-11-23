import {
    MessageFlags,
    SlashCommandBuilder,
} from 'discord.js';

const CONFESSIONS_KEY = (guildId) => `guild:${guildId}:confessions`;

export default {
    data: new SlashCommandBuilder()
        .setName('whoconfessed')
        .setDescription('Look up who sent a numbered confession (Staff only)')
        .addIntegerOption((option) =>
            option
                .setName('number')
                .setDescription('The confession number to look up')
                .setMinValue(1)
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

        const isStaff = interaction.member?.roles?.cache?.some(
            (role) => role.name.toLowerCase() === 'staff',
        );

        if (!isStaff) {
            return interaction.reply({
                content: 'Only members with the **@Staff** role can use this command.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const number = interaction.options.getInteger('number', true);
        const stored = await client.db.get(CONFESSIONS_KEY(interaction.guildId), null);
        const record = stored?.entries?.[String(number)];

        if (!record?.userId) {
            return interaction.reply({
                content: `I could not find **Confession #${number}** in this server.`,
                flags: MessageFlags.Ephemeral,
            });
        }

        return interaction.reply({
            content: `**Confession #${number}** was submitted by <@!${record.userId}> (\`${record.userId}\`).`,
            allowedMentions: { parse: [] },
            flags: MessageFlags.Ephemeral,
        });
    },
};
