import { SlashCommandBuilder } from 'discord.js';
import { createEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { withEconomyTransaction } from '../../utils/economy.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const CRIME_COOLDOWN = 60 * 60 * 1000;
const JAIL_TIME = 2 * 60 * 60 * 1000;
const FINE_RATE = 0.2;

const CRIME_TYPES = [
    { name: "Pickpocketing", min: 100, max: 500, risk: 0.3 },
    { name: "Burglary", min: 300, max: 1000, risk: 0.4 },
    { name: "Bank Heist", min: 1000, max: 5000, risk: 0.6 },
    { name: "Art Theft", min: 2000, max: 10000, risk: 0.7 },
    { name: "Cybercrime", min: 5000, max: 20000, risk: 0.8 },
];

export default {
    data: new SlashCommandBuilder()
        .setName('crime')
        .setDescription('Commit a crime to earn money (risky)')
        .addStringOption(option =>
            option
                .setName('type')
                .setDescription('Type of crime to commit')
                .setRequired(true)
                .addChoices(
                    { name: 'Pickpocketing', value: 'pickpocketing' },
                    { name: 'Burglary', value: 'burglary' },
                    { name: 'Bank Heist', value: 'bank-heist' },
                    { name: 'Art Theft', value: 'art-theft' },
                    { name: 'Cybercrime', value: 'cybercrime' },
                )
        ),

    execute: withErrorHandling(async (interaction, config, client) => {
        await InteractionHelper.safeDefer(interaction);
            
            const userId = interaction.user.id;
            const guildId = interaction.guildId;
            const now = Date.now();

            const crimeType = interaction.options.getString("type").toLowerCase();
            const crime = CRIME_TYPES.find(c => c.name.toLowerCase().replace(/\s+/g, '-') === crimeType);
            if (!crime) {
                throw createError("Invalid crime type", ErrorTypes.VALIDATION, "Please select a valid crime type.", { crimeType });
            }
            const isSuccess = Math.random() > crime.risk;
            const amountEarned = isSuccess
                ? Math.floor(Math.random() * (crime.max - crime.min + 1)) + crime.min
                : 0;
            const potentialHaul = Math.floor((crime.min + crime.max) / 2);

            const crimeResult = await withEconomyTransaction(client, guildId, userId, async (accounts) => {
                const userData = accounts[userId];
                const lastCrime = Number(userData.cooldowns?.crime) || 0;
                const isJailed = Number(userData.jailedUntil) > now;
                if (isJailed) {
                    const remaining = Number(userData.jailedUntil) - now;
                    throw createError("User is in jail", ErrorTypes.RATE_LIMIT,
                        `You're in jail for ${Math.ceil(remaining / 60000)} more minutes!`,
                        { jailTimeRemaining: remaining });
                }
                if (now < lastCrime + CRIME_COOLDOWN) {
                    const remaining = lastCrime + CRIME_COOLDOWN - now;
                    throw createError("Crime cooldown active", ErrorTypes.RATE_LIMIT,
                        `You need to wait ${Math.ceil(remaining / 60000)} more minutes before committing another crime.`,
                        { remaining, cooldownType: 'crime' });
                }
                userData.cooldowns ||= {};
                userData.cooldowns.crime = now;
                let fine = 0;
                if (isSuccess) {
                    userData.wallet = (Number(userData.wallet) || 0) + amountEarned;
                } else {
                    fine = Math.min(Math.floor(potentialHaul * FINE_RATE), Number(userData.wallet) || 0);
                    userData.wallet = Math.max(0, (Number(userData.wallet) || 0) - fine);
                    userData.jailedUntil = now + JAIL_TIME;
                }
                return { userData: structuredClone(userData), fine };
            });
            const { fine } = crimeResult;
            const userData = crimeResult.userData;

            if (isSuccess) {
                const embed = successEmbed(
                    "🕵️ Crime Successful!",
                    `You successfully committed ${crime.name} and earned **${amountEarned}** coins!`
                );
                
                await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
            } else {
                const embed = warningEmbed(
                    "🚔 Crime Failed!",
                    `You were caught while attempting ${crime.name} and have been sent to jail! ` +
                    `You were fined ${fine.toLocaleString()} coins and will be in jail for 2 hours.`
                );
                
                await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
            }
    }, { command: 'crime' })
};