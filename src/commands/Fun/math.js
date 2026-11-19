import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { getEconomyData, setEconomyData } from '../../utils/economy.js';

const REWARD = 50000;
const TIME_LIMIT = 30_000;
const activeGames = new Set();

const operations = {
    add: { symbol: '+', calculate: (a, b) => a + b },
    subtract: { symbol: '−', calculate: (a, b) => a - b },
    multiply: { symbol: '×', calculate: (a, b) => a * b },
    divide: { symbol: '÷', calculate: (a, b) => a / b },
};

function createQuestion(operationKey) {
    const keys = Object.keys(operations);
    const selected = operationKey && operationKey !== 'random'
        ? operationKey
        : keys[Math.floor(Math.random() * keys.length)];

    let a;
    let b;
    switch (selected) {
        case 'add':
            a = Math.floor(Math.random() * 50) + 1;
            b = Math.floor(Math.random() * 50) + 1;
            break;
        case 'subtract':
            a = Math.floor(Math.random() * 50) + 1;
            b = Math.floor(Math.random() * (a + 1));
            break;
        case 'multiply':
            a = Math.floor(Math.random() * 11) + 2;
            b = Math.floor(Math.random() * 11) + 2;
            break;
        case 'divide':
            b = Math.floor(Math.random() * 11) + 2;
            const quotient = Math.floor(Math.random() * 11) + 2;
            a = b * quotient;
            break;
        default:
            return createQuestion('random');
    }

    return { question: `${a} ${operations[selected].symbol} ${b}`, answer: operations[selected].calculate(a, b) };
}

export default {
    prefixOnly: true,
    category: 'fun',
    data: new SlashCommandBuilder()
        .setName('math')
        .setDescription('Solve a random math question to earn bCash')
        .addStringOption(option =>
            option.setName('operation')
                .setDescription('Choose a math operation or random')
                .setRequired(false)
                .addChoices(
                    { name: 'Random', value: 'random' },
                    { name: 'Addition', value: 'add' },
                    { name: 'Subtraction', value: 'subtract' },
                    { name: 'Multiplication', value: 'multiply' },
                    { name: 'Division', value: 'divide' },
                )
        ),

    async execute(interaction, config, client) {
        if (!interaction.guild || !interaction.channel) {
            const payload = { content: 'This command can only be used in a server.' };
            return interaction._isPrefixCommand ? interaction.reply(payload) : interaction.reply({ ...payload, ephemeral: true });
        }

        if (!client?.db) {
            const payload = { content: 'The economy database is currently unavailable. Please try again later.' };
            return interaction._isPrefixCommand ? interaction.reply(payload) : interaction.reply({ ...payload, ephemeral: true });
        }

        const gameKey = interaction.channel.id;
        if (activeGames.has(gameKey)) {
            const payload = { content: 'A math challenge is already active in this channel. Solve it first!' };
            return interaction._isPrefixCommand ? interaction.reply(payload) : interaction.reply({ ...payload, ephemeral: true });
        }

        const operation = interaction.options?.getString('operation') ?? null;
        const { question, answer } = createQuestion(operation);
        activeGames.add(gameKey);

        const embed = new EmbedBuilder()
            .setColor(0xD4AF37)
            .setTitle('🧮 BARRACKS MATH CHALLENGE')
            .setDescription(`Solve this question to earn **₱${REWARD.toLocaleString()} bCash**!\n\n## ${question}\n\nYou have **30 seconds**. The first correct answer wins!`)
            .setFooter({ text: 'Type your answer in this channel.' });

        if (interaction.user?.displayAvatarURL) {
            embed.setThumbnail(interaction.user.displayAvatarURL({ size: 256 }));
        }

        try {
            if (interaction._isPrefixCommand) {
                await interaction.reply({ embeds: [embed] });
            } else {
                await interaction.reply({ embeds: [embed] });
            }

            const collector = interaction.channel.createMessageCollector({
                filter: message => !message.author.bot && /^-?\d+$/.test(message.content.trim()),
                time: TIME_LIMIT,
            });

            collector.on('collect', async message => {
                if (Number(message.content.trim()) !== answer) {
                    await message.react('❌').catch(() => {});
                    return;
                }

                collector.stop('answered');
                try {
                    const userData = await getEconomyData(client, interaction.guildId, message.author.id);
                    if (!userData) throw new Error('Could not load player economy data.');
                    userData.wallet = (Number(userData.wallet) || 0) + REWARD;
                    await setEconomyData(client, interaction.guildId, message.author.id, userData);

                    const winEmbed = new EmbedBuilder()
                        .setColor(0x2ECC71)
                        .setTitle('✅ CORRECT ANSWER!')
                        .setDescription(`<@${message.author.id}> solved **${question}** correctly and earned **₱${REWARD.toLocaleString()} bCash**!`)
                        .setThumbnail(message.author.displayAvatarURL({ size: 256 }))
                        .setFooter({ text: `New wallet balance: ₱${Number(userData.wallet).toLocaleString()}` });
                    await message.reply({ embeds: [winEmbed] });
                } catch (error) {
                    await message.reply('Your answer was correct, but I could not update your bCash. Please contact an administrator.').catch(() => {});
                    console.error('[math] Failed to award bCash:', error);
                }
            });

            collector.on('end', async (_collected, reason) => {
                activeGames.delete(gameKey);
                if (reason !== 'answered') {
                    const timeoutEmbed = new EmbedBuilder()
                        .setColor(0xE74C3C)
                        .setTitle('⏰ TIME’S UP!')
                        .setDescription(`No one got it in time. The correct answer was **${answer}**. Better luck next round!`);
                    await interaction.channel.send({ embeds: [timeoutEmbed] }).catch(() => {});
                }
            });
        } catch (error) {
            activeGames.delete(gameKey);
            throw error;
        }
    },
};
