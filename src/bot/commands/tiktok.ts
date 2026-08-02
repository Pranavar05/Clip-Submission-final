import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import { TikTokService } from '../../api/services/tiktok.js';
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';
import { query } from '../../shared/db.js';

const TIKTOK_SCOPES = ['user.info.basic', 'video.list'];

export async function executeTikTokConnect(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    if (!config.tiktok.clientKey) {
      await interaction.reply({
        content: '❌ TikTok integration is not configured. Ask an admin to set `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET`.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const url = TikTokService.buildAuthUrl(interaction.user.id, TIKTOK_SCOPES);

    const linkButton = new ButtonBuilder()
      .setLabel('Connect TikTok')
      .setStyle(ButtonStyle.Link)
      .setURL(url)
      .setEmoji('🔗');

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(linkButton);

    const embed = new EmbedBuilder()
      .setTitle('🔗 Connect Your TikTok Account')
      .setDescription(
        `Click the button below to authorize this bot to read your TikTok video stats.\n\n` +
        `> ⏳ This authorization link expires in **10 minutes**.\n` +
        `> 🔒 Your credentials are encrypted and stored securely.`
      )
      .setColor('#FF0050')
      .setFooter({ text: 'This link is unique to you — do not share it.' });

    await interaction.reply({
      embeds: [embed],
      components: [row],
      flags: MessageFlags.Ephemeral
    });
  } catch (err: any) {
    logger.error('Failed to generate TikTok connect URL:', err.message);
    await interaction.reply({
      content: `❌ Failed to generate TikTok authorization link: ${err.message}`,
      flags: MessageFlags.Ephemeral
    });
  }
}

export async function executeTikTokDisconnect(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    await TikTokService.unlinkAccount(interaction.user.id);
    await interaction.reply({
      content: '✅ Your TikTok account has been unlinked from this bot.',
      flags: MessageFlags.Ephemeral
    });
  } catch (err: any) {
    logger.error('Failed to disconnect TikTok:', err.message);
    await interaction.reply({
      content: '❌ Failed to unlink your TikTok account. Please try again.',
      flags: MessageFlags.Ephemeral
    });
  }
}

export async function executeTikTokProfile(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    // Check if user has linked their account
    const rows = await query<any>('SELECT user_id FROM tiktok_tokens WHERE user_id = $1', [interaction.user.id]);
    if (rows.length === 0) {
      await interaction.editReply("You haven't connected TikTok yet — run `/tiktok-connect` first.");
      return;
    }

    const profile = await TikTokService.getUserProfile(interaction.user.id);

    const embed = new EmbedBuilder()
      .setTitle(profile.display_name || 'TikTok Profile')
      .setThumbnail(profile.avatar_url || null)
      .addFields(
        { name: 'Followers', value: String(profile.follower_count ?? 'N/A'), inline: true }
      )
      .setColor('#FF0050')
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    logger.error('Failed to fetch TikTok profile:', err.message);
    await interaction.editReply(`❌ Failed to fetch your TikTok profile: ${err.message}`);
  }
}
