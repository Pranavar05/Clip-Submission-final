import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import { query } from '../../shared/db.js';
import { logger } from '../../shared/logger.js';

export async function executeMySubmissions(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const userId = interaction.user.id;

  try {
    const rows = await query<any>(
      `SELECT s.id, s.clip_type, s.submitted_at, s.status, s.rejection_note, c.name as creator_name
       FROM submissions s
       LEFT JOIN creators c ON s.creator_id = c.id
       WHERE s.user_id = $1
       ORDER BY s.submitted_at DESC
       LIMIT 10`,
      [userId]
    );

    if (rows.length === 0) {
      const embed = new EmbedBuilder()
        .setTitle('🎬 My Submissions')
        .setDescription('📭 **You have not uploaded any clips yet.**\n\nUse the submission button in this server to generate an upload link and submit your first clip!')
        .setColor(0xe74c3c)
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('🎬 Your Recent Submissions')
      .setDescription('Here is the status of your last 10 submissions:')
      .setColor('#5865F2')
      .setTimestamp();

    const list = rows.map((sub: any) => {
      const dateStr = sub.submitted_at
        ? new Date(sub.submitted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : 'Unknown Date';

      let statusLabel = '⏳ Pending Review';
      if (sub.status === 'APPROVED' || sub.status === 'COMPLETED') {
        statusLabel = '✅ Approved';
      } else if (sub.status === 'REJECTED') {
        statusLabel = '❌ Rejected';
      } else if (sub.status === 'FLAGGED') {
        statusLabel = '📌 Flagged for Review';
      }

      let rowText = `• **${sub.id}** (${dateStr}) - **${sub.creator_name || 'Unknown'}** [${sub.clip_type}]\n  Status: **${statusLabel}**`;
      if (sub.status === 'REJECTED' && sub.rejection_note) {
        rowText += `\n  *Reason: ${sub.rejection_note}*`;
      }
      return rowText;
    }).join('\n\n');

    embed.addFields({ name: 'Submission History', value: list });

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    logger.error(`Failed to fetch submissions for user ${userId}:`, err.message);
    await interaction.editReply({ content: '❌ Failed to fetch your submissions. Please try again later.' });
  }
}
