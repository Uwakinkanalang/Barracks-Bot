// birthdayService.js

import { EmbedBuilder } from 'discord.js';
import { getGuildConfig } from './config/guildConfig.js';
import { getGuildBirthdays, setBirthday as dbSetBirthday, deleteBirthday as dbDeleteBirthday, getMonthName, getBirthdayTrackingKey } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../utils/errorHandler.js';

export function validateBirthday(month, day) {
  
  if (typeof month !== 'number' || typeof day !== 'number') {
    return {
      isValid: false,
      error: 'Month and day must be numbers'
    };
  }

  if (month < 1 || month > 12) {
    return {
      isValid: false,
      error: 'Month must be between 1 and 12'
    };
  }

  if (day < 1 || day > 31) {
    return {
      isValid: false,
      error: 'Day must be between 1 and 31'
    };
  }

  // Birthday records store month/day only. Use a leap year so February 29 remains valid.
  const date = new Date(2000, month - 1, day);
  
  if (isNaN(date.getTime()) || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return {
      isValid: false,
      error: 'Invalid date. Please check the month and day combination.'
    };
  }

  return { isValid: true };
}

export async function setBirthday(client, guildId, userId, month, day, year = null) {
  try {
    
    const validation = validateBirthday(month, day);
    if (!validation.isValid) {
      logger.warn('Birthday validation failed', {
        userId,
        guildId,
        month,
        day,
        error: validation.error
      });
      
      throw new TitanBotError(
        validation.error,
        ErrorTypes.VALIDATION,
        validation.error,
        { month, day, userId, guildId }
      );
    }

    const success = await dbSetBirthday(client, guildId, userId, month, day, year);
    
    if (!success) {
      throw new TitanBotError(
        'Failed to save birthday to database',
        ErrorTypes.DATABASE,
        'Failed to set your birthday. Please try again later.',
        { userId, guildId, month, day }
      );
    }

    logger.info('Birthday set successfully', {
      userId,
      guildId,
      month,
      day,
      year,
      monthName: getMonthName(month)
    });

    return {
      data: {
        month,
        day,
        year,
        monthName: getMonthName(month)
      }
    };
  } catch (error) {
    logger.error('Error in setBirthday service', {
      error: error.message,
      stack: error.stack,
      userId,
      guildId,
      month,
      day
    });
    
    throw error;
  }
}

export async function getUserBirthday(client, guildId, userId) {
  try {
    const birthdays = await getGuildBirthdays(client, guildId);
    const birthdayData = birthdays[userId];
    
    if (!birthdayData) {
      return null;
    }

    return {
      month: birthdayData.month,
      day: birthdayData.day,
      year: birthdayData.year ?? null,
      monthName: getMonthName(birthdayData.month)
    };
  } catch (error) {
    logger.error('Error in getUserBirthday service', {
      error: error.message,
      userId,
      guildId
    });
    throw error;
  }
}

export async function getAllBirthdays(client, guildId) {
  try {
    const birthdays = await getGuildBirthdays(client, guildId);
    
    if (!birthdays || Object.keys(birthdays).length === 0) {
      return [];
    }

    const sortedBirthdays = Object.entries(birthdays)
      .map(([userId, data]) => ({
        userId,
        month: data.month,
        day: data.day,
        year: data.year ?? null,
        monthName: getMonthName(data.month)
      }))
      .sort((a, b) => {
        if (a.month !== b.month) return a.month - b.month;
        return a.day - b.day;
      });

    return sortedBirthdays;
  } catch (error) {
    logger.error('Error in getAllBirthdays service', {
      error: error.message,
      guildId
    });
    throw error;
  }
}

export async function deleteBirthday(client, guildId, userId) {
  try {
    
    const birthday = await getUserBirthday(client, guildId, userId);
    
    if (!birthday) {
      return {
        status: 'not_found',
      };
    }

    const success = await dbDeleteBirthday(client, guildId, userId);
    
    if (!success) {
      throw new TitanBotError(
        'Failed to delete birthday from database',
        ErrorTypes.DATABASE,
        'Failed to remove your birthday. Please try again.',
        { userId, guildId }
      );
    }

    logger.info('Birthday removed successfully', {
      userId,
      guildId
    });

    return {
      status: 'removed',
    };
  } catch (error) {
    logger.error('Error in deleteBirthday service', {
      error: error.message,
      userId,
      guildId
    });
    throw error;
  }
}

export async function getUpcomingBirthdays(client, guildId, limit = 5) {
  try {
    const birthdays = await getGuildBirthdays(client, guildId);
    
    if (!birthdays || Object.keys(birthdays).length === 0) {
      return [];
    }

    const today = new Date();
    const currentYear = today.getFullYear();
    
    const upcomingBirthdays = [];
    
    for (const [userId, userData] of Object.entries(birthdays)) {
      let nextBirthday = new Date(currentYear, userData.month - 1, userData.day);

      if (nextBirthday < today) {
        nextBirthday = new Date(currentYear + 1, userData.month - 1, userData.day);
      }
      
      const daysUntil = Math.ceil((nextBirthday - today) / (1000 * 60 * 60 * 24));
      
      upcomingBirthdays.push({
        userId,
        month: userData.month,
        day: userData.day,
        monthName: getMonthName(userData.month),
        date: nextBirthday,
        daysUntil
      });
    }

    upcomingBirthdays.sort((a, b) => a.daysUntil - b.daysUntil);

    return upcomingBirthdays.slice(0, limit);
  } catch (error) {
    logger.error('Error in getUpcomingBirthdays service', {
      error: error.message,
      guildId,
      limit
    });
    throw error;
  }
}

export async function getTodaysBirthdays(client, guildId) {
  try {
    const birthdays = await getGuildBirthdays(client, guildId);
    const today = new Date();
    const currentMonth = today.getUTCMonth() + 1;
    const currentDay = today.getUTCDate();

    const todaysBirthdays = [];

    for (const [userId, userData] of Object.entries(birthdays)) {
      if (userData.month === currentMonth && userData.day === currentDay) {
        todaysBirthdays.push({
          userId,
          month: userData.month,
          day: userData.day,
          monthName: getMonthName(userData.month)
        });
      }
    }

    return todaysBirthdays;
  } catch (error) {
    logger.error('Error in getTodaysBirthdays service', {
      error: error.message,
      guildId
    });
    throw error;
  }
}

export async function checkBirthdays(client) {
  const manilaParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    month: 'numeric',
    day: 'numeric',
    year: 'numeric',
  }).formatToParts(new Date());
  const currentMonth = Number(manilaParts.find(part => part.type === 'month')?.value);
  const currentDay = Number(manilaParts.find(part => part.type === 'day')?.value);

  if (process.env.NODE_ENV !== 'production') {
    logger.debug(`🎂 Running daily birthday check for Manila: ${currentMonth}/${currentDay}.`);
  }

  for (const [guildId, guild] of client.guilds.cache) {
    try {
      const config = await getGuildConfig(client, guildId);
      const birthdayChannelId = config?.birthdayChannelId;
      const birthdayRoleId = config?.birthdayRoleId || '1557466630991388744';
      const channel = birthdayChannelId
        ? await guild.channels.fetch(birthdayChannelId).catch(() => null)
        : null;

      const trackingKey = getBirthdayTrackingKey(guildId);
      const trackingData = (await client.db.get(trackingKey)) || {};
      const updatedTrackingData = { ...trackingData };
      
      for (const userId of Object.keys(trackingData)) {
        try {
          if (birthdayRoleId) {
            const member = await guild.members.fetch(userId).catch(() => null);
            if (member && member.roles.cache.has(birthdayRoleId)) {
              await member.roles.remove(birthdayRoleId, "Birthday role expired");
            }
          }
          delete updatedTrackingData[userId];
        } catch (error) {
           logger.error(`Error removing birthday role from ${userId}:`, error);
        }
      }

      if (Object.keys(updatedTrackingData).length !== Object.keys(trackingData).length) {
        await client.db.set(trackingKey, updatedTrackingData);
      }

      // Use the canonical birthday storage (guild:<id>:birthdays) that set/remove commands write to.
      const birthdays = (await getGuildBirthdays(client, guildId)) || {};
      const birthdayMembers = [];
      for (const [userId, userData] of Object.entries(birthdays)) {
        if (userData.month === currentMonth && userData.day === currentDay) {
          const member = await guild.members.fetch(userId).catch(() => null);
          if (member) {
            birthdayMembers.push(member);
            if (birthdayRoleId) {
              try {
                await member.roles.add(birthdayRoleId, "Happy Birthday! 🎉");
                updatedTrackingData[userId] = true;
              } catch (error) {
                  logger.error(`Error adding birthday role to ${member.user.tag}:`, error);
              }
            }
          }
        }
      }

      if (birthdayMembers.length > 0) {
        await client.db.set(trackingKey, updatedTrackingData);
        logger.info(`Birthday role sync completed for ${birthdayMembers.length} member(s) in guild ${guildId}.`);

        // Send at most one automatic birthday announcement per guild per Manila calendar day.
        if (channel?.isTextBased?.() && typeof channel.send === 'function') {
          const dateKey = `${manilaParts.find(part => part.type === 'year')?.value}-${String(currentMonth).padStart(2, '0')}-${String(currentDay).padStart(2, '0')}`;
          const announcementKey = `guild:${guildId}:birthday-announcement:${dateKey}`;
          const alreadyAnnounced = await client.db.get(announcementKey);

          if (!alreadyAnnounced) {
            const mentions = birthdayMembers.map(member => member.toString());
            const plural = birthdayMembers.length > 1;
            const embed = new EmbedBuilder()
              .setColor(0x5865F2)
              .setTitle('🎂 Happy Birthday!')
              .setDescription(
                plural
                  ? `Today we're celebrating ${mentions.join(', ')}! Wishing you all a wonderful day filled with happiness and good memories. 🎉`
                  : `Today we're celebrating ${mentions[0]}! Wishing you a wonderful day filled with happiness and good memories. 🎉`
              )
              .setFooter({ text: 'Barracks • Birthday Celebration' })
              .setTimestamp();

            await channel.send({
              embeds: [embed],
              allowedMentions: { users: birthdayMembers.map(member => member.id) },
            });
            await client.db.set(announcementKey, true);
            logger.info(`Automatic birthday announcement posted for ${birthdayMembers.length} member(s) in guild ${guildId}.`);
          }
        }
      }
    } catch (error) {
      logger.error(`Error processing birthdays for guild ${guildId}:`, error);
    }
  }
}