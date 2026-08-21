import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import { AirtableService } from '../../api/services/airtable.js';
import { logger } from '../../shared/logger.js';

export async function executeCampaigns(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const campaigns = await AirtableService.getActiveCampaignsWithRates();

    if (campaigns.length === 0) {
      await interaction.editReply({ content: '📭 No active clipping campaigns found at this time.' });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('🎯 Active Clipping Campaigns')
      .setDescription(
        'Below are all the active creators and campaigns you can submit clips for. Submissions for these creators will track views and generate payouts according to these rates.'
      )
      .setColor(0x2ecc71)
      .setTimestamp();

    // Chunk campaigns to never exceed Discord's 1024 character field limit
    const CHUNK_SIZE = 5;
    for (let i = 0; i < campaigns.length; i += CHUNK_SIZE) {
      const chunk = campaigns.slice(i, i + CHUNK_SIZE);
      const chunkText = chunk.map((c) => {
        const rateStr = c.rate.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return `• **${c.name}**\n  Rate per Million Views: **$${rateStr}**\n  Status: \`${c.status}\``;
      }).join('\n\n');

      const fieldName = i === 0 ? '📢 Active Campaigns & Creators' : '📢 Active Campaigns (cont.)';
      embed.addFields({ name: fieldName, value: chunkText });
    }

    embed.setFooter({ text: 'Use the submission portal to upload clips for these creators.' });

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    logger.error('Failed to fetch active campaigns:', err.message || err);
    await interaction.editReply({ content: '❌ Failed to fetch active campaigns from Airtable. Please try again later.' });
  }
}
