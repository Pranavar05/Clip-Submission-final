import {
  Interaction,
  GuildMember,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  EmbedBuilder,
  MessageFlags
} from 'discord.js';
import crypto from 'crypto';
import { logger } from '../../shared/logger.js';
import { config } from '../../shared/config.js';
import { encryptToken } from '../../shared/token.js';
import { query } from '../../shared/db.js';
import { executeSetupPortal } from '../commands/setup.js';
import { executeLeaderboard } from '../commands/leaderboard.js';
import { executeStats } from '../commands/stats.js';

const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

export async function handleInteractionCreate(interaction: Interaction): Promise<void> {
  try {
    // ── Slash Commands ──────────────────────────────────────────────────────
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'setup-portal') {
        await executeSetupPortal(interaction);
      } else if (interaction.commandName === 'leaderboard') {
        await executeLeaderboard(interaction);
      } else if (interaction.commandName === 'stats') {
        await executeStats(interaction);
      }
      return;
    }

    // ── Button Interactions ─────────────────────────────────────────────────
    if (interaction.isButton()) {
      const { customId } = interaction;
      const userId = interaction.user.id;

      // ── PORTAL SUBMIT BUTTON ──────────────────────────────────────────────
      if (customId === 'submit_clip_start') {

        // 1. Validate Clipper Role
        if (config.discord.clipperRoleId) {
          const member = interaction.member;
          let hasRole = false;
          let rolesList: string[] = [];

          if (member) {
            if (Array.isArray(member.roles)) {
              rolesList = member.roles;
              hasRole = rolesList.includes(config.discord.clipperRoleId);
            } else if (member.roles && 'cache' in member.roles) {
              rolesList = (member.roles.cache as any).map((r: any) => r.id);
              hasRole = (member.roles.cache as any).has(config.discord.clipperRoleId);
            }
          }

          logger.info(`Role check → user=${interaction.user.tag}, required=${config.discord.clipperRoleId}, userRoles=${JSON.stringify(rolesList)}, pass=${hasRole}`);

          if (!hasRole) {
            await interaction.reply({
              content: '❌ Only members with the **Clipper** role are authorized to submit clips.',
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
