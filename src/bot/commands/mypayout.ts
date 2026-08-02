import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import { AirtableService } from '../../api/services/airtable.js';
import { logger } from '../../shared/logger.js';

export async function executeMyPayout(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const userId = interaction.user.id;

  try {
    const summary = await AirtableService.getUserPayoutSummary(userId);

    if (summary.clipCount === 0) {
      const embed = new EmbedBuilder()
        .setTitle('💰 My Earnings')
        .setDescription(
          `📭 **No submission or payout history found.**\n\n` +
          `• Make sure you have submitted clips using the portal.\n` +
          `• Make sure your Discord account is linked to your profile in the **Team Members** table in Airtable.\n` +
          `• Contact a manager if your Discord User ID has not been registered yet.`
        )
        .setColor(0xe74c3c)
        .setFooter({ text: 'Clipping.bot Payout System' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const totalViewsFormatted = summary.totalViews.toLocaleString();
    const clipperPayoutFormatted = summary.totalClipperPayout.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const amPayoutFormatted = summary.totalAMPayout.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const totalPayoutFormatted = summary.totalPayout.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const embed = new EmbedBuilder()
      .setAuthor({
        name: `${interaction.user.username}'s Earnings`,
        iconURL: interaction.user.displayAvatarURL(),
      })
      .setTitle('💰 Payout & Earnings Summary')
      .setDescription('Estimated/pending payouts directly fetched from Airtable.')
      .addFields(
        { name: '🎬 Total Clips', value: `${summary.clipCount}`, inline: true },
        { name: '👀 Total Views', value: `${totalViewsFormatted}`, inline: true },
        { name: '💵 Clipper Earnings', value: `$${clipperPayoutFormatted}`, inline: true }
      )
      .setColor(0x2f3136)
      .setTimestamp();

    if (summary.totalAMPayout > 0) {
      embed.addFields(
        { name: '💼 Account Manager (AM) Earnings', value: `$${amPayoutFormatted}`, inline: true },
        { name: '💎 Total Combined Payout', value: `$${totalPayoutFormatted}`, inline: true }
      );
    }

    // List recent submissions (up to 5)
    if (summary.clips.length > 0) {
      const recentList = summary.clips.slice(0, 5).map((clip) => {
        const dateStr = clip.submittedAt 
          ? new Date(clip.submittedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          : 'Unknown';
        
        let payoutInfo = '';
        if (clip.clipperPayout > 0 && clip.amPayout > 0) {
          payoutInfo = `(Clip: $${clip.clipperPayout} + AM: $${clip.amPayout})`;
        } else if (clip.clipperPayout > 0) {
          payoutInfo = `($${clip.clipperPayout})`;
        } else if (clip.amPayout > 0) {
          payoutInfo = `(AM: $${clip.amPayout})`;
        } else {
          payoutInfo = `($0.00)`;
        }

        return `• **[${dateStr}]** ${clip.creatorName} (${clip.platform}) - **${clip.views.toLocaleString()}** views ${payoutInfo}`;
      }).join('\n');

      embed.addFields({ name: '📅 Recent Submissions (Max 5)', value: recentList });
    }

    embed.setFooter({ text: 'Rates and splits are configured in Airtable.' });

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    logger.error(`Failed to fetch payout summary for ${interaction.user.tag}:`, err.message);
    await interaction.editReply({ content: '❌ Failed to fetch your earnings summary from Airtable. Please try again later.' });
  }
}
