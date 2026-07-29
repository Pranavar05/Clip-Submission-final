import { 
  CommandInteraction, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  PermissionFlagsBits,
  TextChannel,
  MessageFlags
} from 'discord.js';
import { logger } from '../../shared/logger.js';

export async function executeSetupPortal(interaction: CommandInteraction): Promise<void> {
  try {
    // 1. Verify caller permissions (restrict to administrators & guild owner)
    const isOwner = interaction.guild?.ownerId === interaction.user.id;
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
    if (!isAdmin && !isOwner) {
      await interaction.reply({
        content: '❌ You must be the Server Owner or an Administrator to run this command.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    // Defer the reply to buy time for the channel.send operation (avoids "Unknown interaction" timeout)
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    logger.info(`Setting up submission portal in channel ${interaction.channelId} by user ${interaction.user.tag}`);

    // 2. Build the beautiful portal embed
    const portalEmbed = new EmbedBuilder()
      .setTitle('📤 Clip Submission Portal')
      .setDescription(
        'Welcome! Submit your completed clip here.\n\n' +
        'Every submission is automatically tracked and stored.\n\n' +
        'Please ensure your submission follows the company guidelines.'
      )
      .setColor('#5865F2') // Discord blurple (looks premium and fits primary color)
      .setFooter({ text: 'Discord Clip Submission System' })
      .setTimestamp();

    // 3. Create the submit button
    const submitButton = new ButtonBuilder()
      .setCustomId('submit_clip_start')
      .setLabel('Submit Clip')
      .setStyle(ButtonStyle.Primary); // Blue button

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(submitButton);

    // 4. Send embed to the channel
    const channel = interaction.channel;
    if (channel && 'send' in channel) {
      await (channel as TextChannel).send({
        embeds: [portalEmbed],
        components: [row]
      });
    } else {
      throw new Error('Submission channel is not a valid text-based channel');
    }

    // 5. Update the deferred reply to inform the administrator
    await interaction.editReply({
      content: '✅ Submission portal embed successfully created in this channel!'
    });
  } catch (error) {
    logger.error('Error executing setup-portal command:', error);
    try {
      if (interaction.deferred) {
        await interaction.editReply({
          content: '❌ Failed to create submission portal.'
        });
      } else if (!interaction.replied) {
        await interaction.reply({
          content: '❌ Failed to create submission portal.',
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (replyErr) {
      logger.error('Failed to send error reply:', replyErr);
    }
  }
}
