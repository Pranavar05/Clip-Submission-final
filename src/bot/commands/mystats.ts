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

    if (!rows || !rows.length) {
      await interaction.editReply({ content: '📭 You do not have any submitted clips yet, so no stats are available.' });
      return;
    }

    const s = rows[0];
    const rankStr = `${s.rank}/${s.total_users}`;
    const totalViews = Number(s.total_views).toLocaleString();
    const totalVideosOver1k = Number(s.videos_over_1k).toLocaleString();
    
    // For rank 1, Views to Next Rank is 0 (or we could output 0)
    const viewsToNextRank = Number(s.views_to_next_rank).toLocaleString();
    
    // For last rank, Views above Rank Below is 0
    const viewsAboveRankBelow = Number(s.views_above_rank_below).toLocaleString();

    const embed = new EmbedBuilder()
      .setAuthor({
        name: 'Clipping Bot',
        iconURL: interaction.client.user?.displayAvatarURL(),
      })
      .setTitle('Your Stats')
      .setDescription('Please be aware, only accounts with active clips in this server will be displayed below.')
      .addFields(
        { name: 'Rank', value: rankStr, inline: false },
        { name: 'Total Views', value: totalViews, inline: false },
        { name: 'Total Videos (Over 1,000 Views)', value: totalVideosOver1k, inline: false },
        { name: 'Views to Next Rank', value: viewsToNextRank, inline: false },
        { name: 'Views above Rank Below', value: viewsAboveRankBelow, inline: false }
      )
      .setColor(0x2b2d31)
      .setFooter({ text: 'Clipping.bot 2026' });

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    logger.error(`Failed to fetch personal stats for ${interaction.user.tag}:`, err.message);
    await interaction.editReply({ content: '❌ Failed to fetch your stats. Please try again later.' });
  }
}
