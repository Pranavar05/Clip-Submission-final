import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import { query } from '../../shared/db.js';
import { logger } from '../../shared/logger.js';
import { AirtableService } from '../../api/services/airtable.js';

export async function executeClipperProfile(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  
  const targetUser = interaction.options.getUser('user', true);
  const userId = targetUser.id;

  try {
    // 1. Sync views from Airtable to local database
    await AirtableService.syncViewsToDb().catch(err => {
      logger.error('Failed to sync views before clipper-profile query:', err.message);
    });

    // 2. Fetch stats from local database
    const rows = await query<any>(
      `WITH user_views AS (
         SELECT 
           c.user_id,
           SUM(COALESCE(v.count, 0)) as total_views,
           COUNT(c.id) as total_videos,
           COUNT(CASE WHEN COALESCE(v.count, 0) > 1000 THEN 1 END) as videos_over_1k
         FROM submissions c
         LEFT JOIN view_counts v ON c.id = v.submission_id
         GROUP BY c.user_id
       ),
       ranked_users AS (
         SELECT 
           user_id,
           total_views,
           total_videos,
           videos_over_1k,
           ROW_NUMBER() OVER (ORDER BY total_views DESC) as rank
         FROM user_views
       )
       SELECT 
         r.rank,
         (SELECT COUNT(*) FROM ranked_users) as total_users,
         r.total_views,
         r.total_videos,
         r.videos_over_1k
       FROM ranked_users r
       WHERE r.user_id = $1`,
      [userId]
    );

    // 3. Fetch payout and earnings stats from Airtable
    const summary = await AirtableService.getUserPayoutSummary(userId).catch(err => {
      logger.error(`Failed to fetch payout summary for clipper profile of ${userId}:`, err.message);
      return null;
    });

    const hasDbStats = rows && rows.length > 0;
    const hasAirtableStats = summary && summary.clipCount > 0;

    if (!hasDbStats && !hasAirtableStats) {
      await interaction.editReply({
        content: `📭 **No submissions or profile records found for ${targetUser.username}**.`
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setAuthor({
        name: `${targetUser.username}'s Clipper Profile`,
        iconURL: targetUser.displayAvatarURL(),
      })
      .setTitle('📊 Clipper Performance & Earnings')
      .setColor(0x9b59b6)
      .setTimestamp();

    // Add DB Stats if available
    if (hasDbStats) {
      const s = rows[0];
      embed.addFields(
        { name: 'Rank', value: `#${s.rank} of ${s.total_users}`, inline: true },
        { name: 'Total Views (All Platforms)', value: Number(s.total_views).toLocaleString(), inline: true },
        { name: 'Videos Over 1,000 Views', value: Number(s.videos_over_1k).toLocaleString(), inline: true }
      );
    } else {
      embed.addFields(
        { name: 'Rank', value: 'Unranked', inline: true },
        { name: 'Total Views', value: '0', inline: true },
        { name: 'Videos Over 1,000 Views', value: '0', inline: true }
      );
    }

    // Add Airtable payout stats if available
    if (hasAirtableStats && summary) {
      const clipperPayoutFormatted = summary.totalClipperPayout.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const amPayoutFormatted = summary.totalAMPayout.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const totalPayoutFormatted = summary.totalPayout.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      embed.addFields(
        { name: '🎬 Total Submissions', value: `${summary.clipCount}`, inline: true },
        { name: '💵 Clipper Payouts', value: `$${clipperPayoutFormatted}`, inline: true },
        { name: '💼 AM Payouts', value: `$${amPayoutFormatted}`, inline: true }
      );

      if (summary.totalAMPayout > 0) {
        embed.addFields({ name: '💎 Total Combined Earnings', value: `$${totalPayoutFormatted}`, inline: false });
      }

      // Recent submissions
      const recentList = summary.clips.slice(0, 3).map((clip) => {
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

      if (recentList) {
        embed.addFields({ name: '📅 Recent Submissions (Max 3)', value: recentList });
      }
    } else {
      embed.addFields(
        { name: '🎬 Total Submissions', value: '0', inline: true },
        { name: '💵 Total Earnings', value: '$0.00', inline: true }
      );
    }

    embed.setFooter({ text: 'Clipper stats synced from database & Airtable.' });

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    logger.error(`Failed to fetch clipper profile for target user ${userId}:`, err.message);
    await interaction.editReply({ content: '❌ Failed to fetch clipper profile. Please try again later.' });
  }
}
