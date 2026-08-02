import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import { checkAndUpdateViews } from '../../api/services/viewChecker.js';
import { logger } from '../../shared/logger.js';

export async function executeTrackViews(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    logger.info(`Manually triggering view check and payout calculation from Discord command (/track-views) by ${interaction.user.tag}`);
    const ran = await checkAndUpdateViews();
    
    if (!ran) {
      await interaction.editReply({ content: '⚠️ View check / payout calculation is already running. Please wait for the current pass to finish.' });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('🔄 Views & Payouts Checked!')
      .setDescription('Successfully fetched latest view counts from YouTube and processed payout calculations.')
      .setColor('#43B581')
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    logger.error('Failed to manually track views via Discord command:', err.message);
    await interaction.editReply({ content: '❌ Failed to run view checking & payouts calculation. Please check server logs.' });
  }
}
