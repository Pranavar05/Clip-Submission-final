import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import { TikTokService } from '../../api/services/tiktok.js';
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';

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

