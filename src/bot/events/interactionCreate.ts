import {
  Interaction,
  GuildMember,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits
} from 'discord.js';
import crypto from 'crypto';
import { logger } from '../../shared/logger.js';
import { config } from '../../shared/config.js';
import { encryptToken } from '../../shared/token.js';
import { query } from '../../shared/db.js';
import { executeSetupPortal } from '../commands/setup.js';
import { executeLeaderboard } from '../commands/leaderboard.js';
import { executeStats } from '../commands/stats.js';
import { executeMyStats } from '../commands/mystats.js';
import { executeTrackViews } from '../commands/trackViews.js';
import { executeTikTokConnect } from '../commands/tiktok.js';
import { executeMyPayout } from '../commands/mypayout.js';
import { executeGuidelines } from '../commands/guidelines.js';
import { executeCampaigns } from '../commands/campaigns.js';
import { executeClipperProfile } from '../commands/clipperProfile.js';
import { executeMySubmissions } from '../commands/mySubmissions.js';

const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function getUserRoles(interaction: Interaction, userId: string): Promise<string[]> {
  if (!interaction.guildId) return [];

  // Fast path: get roles from cached interaction member if available
  if (interaction.member && 'roles' in interaction.member) {
    const roles = interaction.member.roles;
    if (typeof roles === 'object' && 'cache' in roles) {
      return Array.from((roles.cache as any).keys()) as string[];
    }
  }

  // Fallback: cached redis lookup or fetch from Discord API
  let rolesList: string[] = [];
  const { getRedisClient } = await import('../../shared/redis.js');
  const redis = getRedisClient();
  const cacheKey = `member_roles:${userId}`;

  if (redis) {
    try {
      const cachedRoles = await redis.get(cacheKey);
      if (cachedRoles) {
        return JSON.parse(cachedRoles);
      }
    } catch (_) {}
  }

  try {
    const guild = await interaction.client.guilds.fetch(interaction.guildId);
    const member = await guild.members.fetch(userId);
    rolesList = Array.from(member.roles.cache.keys());
    if (redis) {
      await redis.set(cacheKey, JSON.stringify(rolesList), 'EX', 300);
    }
  } catch (err: any) {
    logger.error(`Failed to fetch member roles: ${err.message}`);
  }
  return rolesList;
}

export async function handleInteractionCreate(interaction: Interaction): Promise<void> {
  try {
    const userId = interaction.user.id;

    // ── Slash Commands ──────────────────────────────────────────────────────
    if (interaction.isChatInputCommand()) {
      const roles = await getUserRoles(interaction, userId);
      const guild = interaction.guild || (interaction.guildId ? await interaction.client.guilds.fetch(interaction.guildId).catch(() => null) : null);
      const isOwner = guild?.ownerId === userId;
      const isAdmin = isOwner || (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false);
      const isClipper = isAdmin || (config.discord.clipperRoleId ? roles.includes(config.discord.clipperRoleId) : false);
      const isManager = isAdmin || (config.discord.managerRoleId ? roles.includes(config.discord.managerRoleId) : false);

      const isClipperCommand = ['my-stats', 'my-payout', 'guidelines', 'campaigns', 'my-submissions', 'tiktok-connect'].includes(interaction.commandName);
      if (isClipperCommand) {
        if (!isClipper && !isManager) {
          await interaction.reply({
            content: '❌ Only members with the **Clipper** or **Manager** role can use this command.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }
 
        if (interaction.commandName === 'my-stats') {
          await executeMyStats(interaction);
        } else if (interaction.commandName === 'my-payout') {
          await executeMyPayout(interaction);
        } else if (interaction.commandName === 'guidelines') {
          await executeGuidelines(interaction);
        } else if (interaction.commandName === 'campaigns') {
          await executeCampaigns(interaction);
        } else if (interaction.commandName === 'my-submissions') {
          await executeMySubmissions(interaction);
        } else if (interaction.commandName === 'tiktok-connect') {
          await executeTikTokConnect(interaction);
        }
        return;
      }

      // All other commands require Manager role
      if (!isManager) {
        await interaction.reply({
          content: '❌ You do not have the **Manager** role required to use this command.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (interaction.commandName === 'setup-portal') {
        await executeSetupPortal(interaction);
      } else if (interaction.commandName === 'leaderboard') {
        await executeLeaderboard(interaction);
      } else if (interaction.commandName === 'stats') {
        await executeStats(interaction);
      } else if (interaction.commandName === 'track-views') {
        await executeTrackViews(interaction);
      } else if (interaction.commandName === 'clipper-profile') {
        await executeClipperProfile(interaction);
      }
      return;
    }

    // ── Button Interactions ─────────────────────────────────────────────────
    if (interaction.isButton()) {
      const { customId } = interaction;

      // ── PORTAL SUBMIT BUTTON ──────────────────────────────────────────────
      if (customId === 'submit_clip_start') {

        // Validate Clipper or Manager Role
        if (config.discord.clipperRoleId || config.discord.managerRoleId) {
          const roles = await getUserRoles(interaction, userId);
          const guild = interaction.guild || (interaction.guildId ? await interaction.client.guilds.fetch(interaction.guildId).catch(() => null) : null);
          const isOwner = guild?.ownerId === userId;
          const isAdmin = isOwner || (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false);
          const hasClipper = isAdmin || (config.discord.clipperRoleId ? roles.includes(config.discord.clipperRoleId) : false);
          const hasManager = isAdmin || (config.discord.managerRoleId ? roles.includes(config.discord.managerRoleId) : false);

          logger.info(`Role check → user=${interaction.user.tag}, clipper=${config.discord.clipperRoleId}, manager=${config.discord.managerRoleId}, admin=${isAdmin}, pass=${hasClipper || hasManager}`);

          if (!hasClipper && !hasManager) {
            await interaction.reply({
              content: '❌ Only members with the **Clipper** or **Manager** role are authorized to submit clips.',
              flags: MessageFlags.Ephemeral
            });
            return;
          }
        }

        // 2. Check Rate Limit (PostgreSQL token cooldown check: count tokens generated in last 15 minutes, only in production)
        if (!config.isDev) {
          const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
          const cooldownRows = await query(
            'SELECT COUNT(*) as count FROM upload_tokens WHERE user_id = $1 AND created_at > $2',
            [userId, fifteenMinutesAgo]
          );
          const count = parseInt(cooldownRows[0].count, 10);
          if (count >= 2) {
            await interaction.reply({
              content: `❌ Cooldown active. You can generate a maximum of 2 submission portals every 15 minutes to prevent abuse.`,
              flags: MessageFlags.Ephemeral
            });
            return;
          }
        }

        // 3. Generate Secure Portal Token (expires in 10 minutes)
        const member = interaction.member as GuildMember | null;
        const displayName = member instanceof GuildMember
          ? member.displayName
          : interaction.user.username;

        const token = await encryptToken({
          tokenId: crypto.randomUUID(),
          userId: interaction.user.id,
          discordUser: interaction.user.username,
          displayName,
          serverId: interaction.guildId || '',
          channelId: interaction.channelId || '',
          expiresAt: Date.now() + TOKEN_TTL_MS
        });

        // 4. Build the portal URL with the token
        const portalUrl = `${config.apiBaseUrl}/portal.html?token=${encodeURIComponent(token)}`;
        logger.info(`Generated portal link for user: ${interaction.user.tag}`);

        // 5. Reply with a link button (ephemeral so only the clipper sees it)
        const linkButton = new ButtonBuilder()
          .setLabel('Open Submission Portal')
          .setStyle(ButtonStyle.Link)
          .setURL(portalUrl)
          .setEmoji('🌐');

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(linkButton);

        const embed = new EmbedBuilder()
          .setTitle('🔗 Your Submission Portal is Ready!')
          .setDescription(
            `Click the button below to open your **secure upload portal** in the browser.\n\n` +
            `You can upload video files up to **200MB** with no Discord limitations.\n\n` +
            `> ⏳ This link will expire in **10 minutes**.`
          )
          .setColor('#5865F2')
          .setFooter({ text: 'Your session is encrypted and only valid for you.' });

        await interaction.reply({
          embeds: [embed],
          components: [row],
          flags: MessageFlags.Ephemeral
        });
        return;
      }
    }
  } catch (error) {
    logger.error('Error handling Discord interaction:', error);
    if (!interaction.isRepliable() || (interaction as any).replied) return;
    try {
      await (interaction as any).reply({
        content: '❌ An unexpected error occurred. Please try again.',
        flags: MessageFlags.Ephemeral
      });
    } catch (_) {}
  }
}
