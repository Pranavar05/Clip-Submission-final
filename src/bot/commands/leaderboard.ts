import { ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { query } from '../../shared/db.js';
import { logger } from '../../shared/logger.js';

export async function executeLeaderboard(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: false });
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

    // Build fields: one clean stat-block per entry — bold label, plain value underneath,
    // matching the "Your Stats" style layout (no inline bullet-cramming).
    const fields: { name: string; value: string; inline: boolean }[] = [];

    entries.forEach((entry, i) => {
      const views = Number(entry.view_count).toLocaleString();
      const type = entry.clip_type || 'Unknown';
      const userMention = `<@${entry.user_id}>`;

      const rankLabel =
        i < 3 ? `${topThreeEmojis[i]}  Rank #${i + 1}` : `Rank #${i + 1}`;

      // Separator before runner-ups section, styled like a subtle section break
      if (i === 3) {
        fields.push({
          name: '\u200b',
          value: '**Runner-Ups**',
          inline: false,
        });
      }

      fields.push({
        name: rankLabel,
        value: `${userMention}\n${type}  •  ${views} views`,
        inline: false,
      });
    });

    const embed = new EmbedBuilder()
      .setAuthor({
        name: 'Clipping Bot',
        iconURL: interaction.client.user?.displayAvatarURL(),
      })
      .setTitle('Leaderboard')
      .setDescription('Please be aware, only accounts with active clips in this server will be displayed below.')
      .addFields(fields)
      .setColor(0x2b2d31)
      .setFooter({ text: 'Clipping.bot 2026' });

    await interaction.editReply({ embeds: [embed] });

    logger.info(`Leaderboard command served directly from DB to ${interaction.user.tag} (${entries.length} entries)`);
  } catch (err: any) {
    logger.error('Failed to fetch leaderboard:', err.message);
    await interaction.editReply({ content: '❌ Failed to fetch the leaderboard. Please try again.' });
  }
}