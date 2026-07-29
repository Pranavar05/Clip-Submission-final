import { Client, GatewayIntentBits, Partials, Collection, ApplicationCommandData, PermissionFlagsBits } from 'discord.js';
import { logger } from '../shared/logger.js';
import { config } from '../shared/config.js';
import { handleInteractionCreate } from './events/interactionCreate.js';

// Extend Client to hold commands collection for dynamic command handling
export class SubmissionBotClient extends Client {
  public commands = new Collection<string, any>();

  constructor() {
    super({
      intents: [
        GatewayIntentBits.Guilds
      ]
    });
  }
}

export const client = new SubmissionBotClient();

client.once('ready', async () => {
  logger.info(`Discord Bot logged in successfully as: ${client.user?.tag}`);

  // Register commands
  try {
    const commandsToRegister: ApplicationCommandData[] = [
      {
        name: 'setup-portal',
        description: 'Deploys the Clip Submission Portal embed and button to this channel.',
        defaultMemberPermissions: PermissionFlagsBits.Administrator,
      }
    ];

    if (config.discord.guildId) {
      logger.info(`Registering slash commands for development Guild: ${config.discord.guildId}`);
      const guild = await client.guilds.fetch(config.discord.guildId);
      await guild.commands.set(commandsToRegister);
      logger.info('Guild commands registered successfully.');
    } else {
      logger.info('Registering global slash commands...');
      await client.application?.commands.set(commandsToRegister);
      logger.info('Global commands registered successfully.');
    }
  } catch (error) {
    logger.error('Failed to register application slash commands:', error);
  }
});

// Event Registrations
client.on('interactionCreate', handleInteractionCreate);
