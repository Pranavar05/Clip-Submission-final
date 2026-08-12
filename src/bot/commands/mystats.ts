import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import { query } from '../../shared/db.js';
import { logger } from '../../shared/logger.js';
import { AirtableService } from '../../api/services/airtable.js';

export async function executeMyStats(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const userId = interaction.user.id;

  try {
    // Sync views from Airtable to DB (with 30s cooldown throttling)
    await AirtableService.syncViewsToDb().catch(err => {
      logger.error('Failed to sync views before my-stats query:', err.message);
    });

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
         r.videos_over_1k,
         COALESCE(
           (SELECT total_views FROM ranked_users WHERE rank = r.rank - 1),
           r.total_views
         ) - r.total_views as views_to_next_rank,
         r.total_views - COALESCE(
           (SELECT total_views FROM ranked_users WHERE rank = r.rank + 1),
           r.total_views
         ) as views_above_rank_below
       FROM ranked_users r
       WHERE r.user_id = $1`,
      [userId]
    );

    // Fetch payout and earnings stats from Airtable
    const summary = await AirtableService.getUserPayoutSummary(userId).catch(err => {
      logger.error(`Failed to fetch payout summary for my-stats of ${userId}:`, err.message);
      return null;
    });

    const hasDbStats = rows && rows.length > 0;
    const hasAirtableStats = summary && summary.clipCount > 0;

    if (!hasDbStats && !hasAirtableStats) {
      await interaction.editReply({ content: '📭 You do not have any submitted clips or stats available yet.' });
      return;
    }

    const embed = new EmbedBuilder()
      .setAuthor({
        name: `${interaction.user.username}'s Clipper Stats`,
        iconURL: interaction.user.displayAvatarURL() || interaction.client.user?.displayAvatarURL(),
      })
      .setTitle('📊 Performance & Earnings Profile')
      .setColor(0x2b2d31)
      .setTimestamp();

    if (hasDbStats) {
      const s = rows[0];
      const rankStr = `${s.rank}/${s.total_users}`;
      const totalViews = Number(s.total_views).toLocaleString();
      const totalVideosOver1k = Number(s.videos_over_1k).toLocaleString();
      const viewsToNextRank = Number(s.views_to_next_rank).toLocaleString();
      const viewsAboveRankBelow = Number(s.views_above_rank_below).toLocaleString();

      embed.addFields(
        { name: 'Server Rank', value: `#${rankStr}`, inline: true },
        { name: 'Total Database Views', value: totalViews, inline: true },
        { name: 'Videos Over 1,000 Views', value: totalVideosOver1k, inline: true },
        { name: 'Views to Next Rank', value: viewsToNextRank, inline: true },
        { name: 'Views above Rank Below', value: viewsAboveRankBelow, inline: true }
      );
    } else {
      embed.addFields(
        { name: 'Server Rank', value: 'Unranked', inline: true },
        { name: 'Total Database Views', value: '0', inline: true },
        { name: 'Videos Over 1k Views', value: '0', inline: true }
      );
    }

    if (hasAirtableStats && summary) {
      const clipperPayoutFormatted = summary.totalClipperPayout.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const amPayoutFormatted = summary.totalAMPayout.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const totalPayoutFormatted = summary.totalPayout.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      embed.addFields(
        { name: '🎬 Airtable Clips Count', value: `${summary.clipCount}`, inline: true },
        { name: '💵 Clipper Earnings', value: `$${clipperPayoutFormatted}`, inline: true },
        { name: '💼 Account Manager (AM) Earnings', value: `$${amPayoutFormatted}`, inline: true },
        { name: '💎 Total Combined Earnings', value: `$${totalPayoutFormatted}`, inline: false }
      );
    }

    embed.setFooter({ text: 'Clipping.bot 2026' });

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    logger.error(`Failed to fetch personal stats for ${interaction.user.tag}:`, err.message);
    await interaction.editReply({ content: '❌ Failed to fetch your stats. Please try again later.' });
  }
}
