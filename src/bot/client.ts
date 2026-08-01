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
      },
      {
        name: 'leaderboard',
        description: 'Displays the clip leaderboard by view counts.',
        options: [
          {
            name: 'limit',
            description: 'Number of top clips to show (default 10, max 25)',
            type: 4, // Integer type
            required: false,
          }
        ]
      },
      {
        name: 'stats',
        description: 'Displays stats for a specific clip.',
        options: [
          {
            name: 'id',
            description: 'The submission ID of the clip (e.g., SUB-000001)',
            type: 3, // String type
            required: true,
          }
        ]
      },
      {
        name: 'my-stats',
        description: 'View your personal ranking and clip stats within the community.',
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
