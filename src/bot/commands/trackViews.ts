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

    const embed = new EmbedBuilder()
      .setTitle('🔄 Views & Payouts Checked!')
      .setDescription('Successfully fetched latest view counts and processed payout calculations.')
      .addFields(
        { name: '📊 Total Submissions', value: `${result.totalRecords}`, inline: true },
        { name: '✅ Payouts Calculated', value: `${result.calculated}`, inline: true },
        { name: '📝 Written to Airtable', value: `${result.written}`, inline: true },
        { name: '⏭️ Skipped (No Views)', value: `${result.skippedNoViews}`, inline: true },
        { name: '⏭️ Skipped (Unchanged)', value: `${result.skippedViewsUnchanged}`, inline: true },
        { name: '⏭️ Skipped (No Creator)', value: `${result.skippedNoCreator}`, inline: true },
      )
      .setColor(result.errors > 0 ? '#FFA500' : '#43B581')
      .setTimestamp();

    if (result.skippedNoClipType > 0) {
      embed.addFields({ name: '⏭️ Skipped (No Clip Type)', value: `${result.skippedNoClipType}`, inline: true });
    }

    if (result.errors > 0) {
      const errList = result.errorMessages.slice(0, 5).join('\n');
      embed.addFields({ name: `❌ Errors (${result.errors})`, value: errList || 'Check server logs', inline: false });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    logger.error('Failed to manually track views via Discord command:', err.message);
    await interaction.editReply({ content: `❌ Failed to run view checking & payouts calculation: ${err.message}` });
  }
}
