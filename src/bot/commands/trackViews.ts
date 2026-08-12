import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import { checkAndUpdateViews } from '../../api/services/viewChecker.js';
import { logger } from '../../shared/logger.js';

export async function executeTrackViews(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    logger.info(`Manually triggering view check and payout calculation from Discord command (/track-views) by ${interaction.user.tag}`);
    const result = await checkAndUpdateViews();
    
    if (result === false) {
      await interaction.editReply({ content: '⚠️ View check / payout calculation is already running. Please wait for the current pass to finish.' });
      return;
    }

    // Keep server-side logs detailed for debugging
    logger.info(`View checking & payout run completed. Submissions: ${result.totalRecords}, Calculated: ${result.calculated}, Written: ${result.written}, Skipped Views: ${result.skippedNoViews}, Skipped Unchanged: ${result.skippedViewsUnchanged}, Errors: ${result.errors}`);
    if (result.errors > 0) {
      logger.error('Errors encountered during view tracking pass:', result.errorMessages.join('\n'));
    }

    // Send a clean, simple success message in Discord chat
    const embed = new EmbedBuilder()
      .setTitle('🔄 Views & Payouts Checked!')
      .setDescription('Successfully fetched latest view counts from YouTube/TikTok and processed payout calculations in the background.')
      .setColor('#43B581')
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    logger.error('Failed to manually track views via Discord command:', err.message);
    await interaction.editReply({ content: `❌ Failed to run view checking & payouts calculation: ${err.message}` });
  }
}
