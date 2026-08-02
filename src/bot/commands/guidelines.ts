import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags } from 'discord.js';

export async function executeGuidelines(interaction: ChatInputCommandInteraction): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle('📋 Clip Submission Guidelines')
    .setDescription(
      'Welcome to the Clipping Community! Please follow these guidelines to ensure your clips are processed, views are tracked, and you get paid accurately.'
    )
    .addFields(
      {
        name: '📁 File Requirements',
        value: 
          '• **Max File Size**: 200 MB per clip.\n' +
          '• **Formats**: `.mp4`, `.mov`, `.webm` are preferred.\n' +
          '• **Quality**: Standard 720p or 1080p, good audio, no lag.',
        inline: false
      },
      {
        name: '🚀 Submission Process',
        value:
          '1. Find the clip submission channel and click the **Submit Clip** button.\n' +
          '2. Click the secure portal link generated for you (expires in 10 minutes).\n' +
          '3. Drag and drop your video file, select the **Creator**, write a description, and submit.\n' +
          '4. Once processed, your views and payouts will be tracked automatically!',
        inline: false
      },
      {
        name: '🎬 Payout Splits by Clip Type',
        value:
          '• **Original-Edited**: Clipper: **55%** (YouTube: **60%**) | AM: 25% | Owner: 20%\n' +
          '• **Raw-Split Edit**: Clipper: **20%** | Editor: 35%-40% | AM: 20%-25% | Owner: 20%\n' +
          '• **Stolen**: Clipper: **30%** | AM: 40% | Owner: 30%\n' +
          '• **Raw**: Clipper: **20%** | AM: 60% | Owner: 20%',
        inline: false
      },
      {
        name: '💡 Best Practices',
        value:
          '• Only submit high-entertainment or high-action moments.\n' +
          '• Keep vertical clips framed properly for mobile screens (TikTok/Shorts).\n' +
          '• Do not upload duplicate files or spam the portal.\n' +
          '• Use `/my-stats` to view your rank, and `/my-payout` to track your earnings.',
        inline: false
      }
    )
    .setColor(0x5865F2)
    .setFooter({ text: 'Clipping.bot Guidelines | Help make our community grow! 🚀' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
