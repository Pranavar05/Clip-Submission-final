import { ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { query } from '../../shared/db.js';
import { logger } from '../../shared/logger.js';

const TROPHY: Record<number, string> = { 0: '🏆', 1: '🥈', 2: '🥉' };

export async function executeLeaderboard(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const limit = interaction.options.getInteger('limit') ?? 10;

  try {
    const entries = await query<any>(
      `SELECT c.id, c.discord_username, c.user_id, c.clip_type, c.description, c.submitted_at,
              COALESCE(v.count, 0) as view_count
       FROM submissions c
       LEFT JOIN view_counts v ON c.id = v.submission_id
       ORDER BY view_count DESC, c.submitted_at ASC
       LIMIT $1`,
      [limit]
    );

    if (!entries || !entries.length) {
      await interaction.editReply({ content: '📭 No clips have been tracked yet. Submit some clips first!' });
      return;
    }

    const topThreeEmojis = ['🥇', '🥈', '🥉'];
    const lines: string[] = [];

    entries.forEach((entry, i) => {
      const views = Number(entry.view_count).toLocaleString();
      const type = entry.clip_type || 'Unknown';
      const userMention = `<@${entry.user_id}>`;

      if (i < 3) {
        // Special highlighted format for top 3
        const emoji = topThreeEmojis[i];
        lines.push(
          `${emoji} **#${i + 1}** • ${userMention} (\`${entry.id}\`)\n` +
          `┗ 🎬 *${type}*  •  👁️ **${views}** views\n`
        );
      } else {
        // Divider line between top 3 and runner-ups
        if (i === 3) {
          lines.push('⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n**Runner-Ups:**');
        }
        lines.push(`🎖️ **#${i + 1}** • ${userMention} (\`${entry.id}\`)  •  🎬 *${type}*  •  👁️ **${views}** views`);
      }
    });

    const embed = new EmbedBuilder()
      .setTitle('🏆 Clip Submission Leaderboard')
      .setDescription(lines.join('\n'))
      .setColor('#FFD700')
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    logger.info(`Leaderboard command served directly from DB to ${interaction.user.tag} (${entries.length} entries)`);
  } catch (err: any) {
    logger.error('Failed to fetch leaderboard:', err.message);
    await interaction.editReply({ content: '❌ Failed to fetch the leaderboard. Please try again.' });
  }
}
