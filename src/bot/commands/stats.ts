import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import { query } from '../../shared/db.js';
import { logger } from '../../shared/logger.js';

export async function executeStats(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const id = interaction.options.getString('id', true).trim().toUpperCase();

  try {
    const rows = await query<any>(
      `SELECT c.id, c.discord_username, c.discord_user_id, c.clip_type, c.description, c.submitted_at, c.status,
              COALESCE(v.count, 0) as view_count, v.last_viewed_at
       FROM submissions c
       LEFT JOIN view_counts v ON c.id = v.submission_id
       WHERE c.id = $1`,
      [id]
    );

    if (!rows.length) {
      await interaction.editReply({ content: `❌ No clip found with ID \`${id}\`. Double-check the ID and try again.` });
      return;
    }

    const s = rows[0];
    const views = Number(s.view_count).toLocaleString();
    const submittedAt = s.submitted_at ? new Date(s.submitted_at).toUTCString() : 'N/A';

    const embed = new EmbedBuilder()
      .setTitle(`📊 Clip Stats: \`${s.id}\``)
      .setColor('#5865F2')
      .addFields(
        { name: '👤 Submitted By', value: `<@${s.discord_user_id}> (${s.discord_username})`, inline: true },
        { name: '🎬 Clip Type', value: s.clip_type || 'N/A', inline: true },
        { name: '👁 Total Views', value: `**${views}**`, inline: true },
        { name: '📋 Status', value: s.status || 'Tracked', inline: true },
        { name: '📅 Submitted At', value: submittedAt, inline: false },
        { name: '📝 Description', value: s.description || '*No description*', inline: false }
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    logger.error('Failed to fetch clip stats:', err.message);
    await interaction.editReply({ content: '❌ Failed to fetch stats. Please try again later.' });
  }
}
