require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder, MessageFlags } = require("discord.js");
const { startOAuthServer } = require("./oauthServer");
const { buildAuthUrl } = require("./tiktokAuth");
const { getUserInfo, postVideoFromUrl, getPublishStatus } = require("./tiktokApi");
const { deleteTokens, getTokens } = require("./tokenStore");

// Scopes requested — keep this to only what the bot actually needs
// (over-requesting scopes is a common reason for App Review rejection).
const SCOPES = ["user.info.basic", "video.publish"];

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    switch (interaction.commandName) {
      case "tiktok-connect": {
        const url = buildAuthUrl(interaction.user.id, SCOPES);
        await interaction.reply({
          content: `Click below to connect your TikTok account. This link is unique to you — don't share it.\n${url}`,
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case "tiktok-profile": {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (!getTokens(interaction.user.id)) {
          await interaction.editReply("You haven't connected TikTok yet — run `/tiktok-connect` first.");
          return;
        }
        const user = await getUserInfo(interaction.user.id);
        const embed = new EmbedBuilder()
          .setTitle(user.display_name)
          .setThumbnail(user.avatar_url)
          .addFields({ name: "Followers", value: String(user.follower_count ?? "N/A") })
          .setColor(0xff0050);
        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case "tiktok-post": {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (!getTokens(interaction.user.id)) {
          await interaction.editReply("You haven't connected TikTok yet — run `/tiktok-connect` first.");
          return;
        }
        const videoUrl = interaction.options.getString("video_url", true);
        const title = interaction.options.getString("title", true);
        const visibility = interaction.options.getString("visibility") || "SELF_ONLY";

        const result = await postVideoFromUrl(interaction.user.id, {
          videoUrl,
          title,
          privacyLevel: visibility,
        });

        await interaction.editReply(
          `Publish started ✅ (publish_id: \`${result.publish_id}\`). ` +
            `Use \`/tiktok-status\` or check back shortly — processing is async.`
        );
        break;
      }

      case "tiktok-status": {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (!getTokens(interaction.user.id)) {
          await interaction.editReply("You haven't connected TikTok yet — run `/tiktok-connect` first.");
          return;
        }
        const publishId = interaction.options.getString("publish_id", true);
        const status = await getPublishStatus(interaction.user.id, publishId);
        await interaction.editReply(
          `Status: **${status.status}**${status.fail_reason ? ` — ${status.fail_reason}` : ""}`
        );
        break;
      }

      case "tiktok-disconnect": {
        deleteTokens(interaction.user.id);
        await interaction.reply({
          content: "Your TikTok account has been unlinked from this bot.",
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      default:
        await interaction.reply({ content: "Unknown command.", flags: MessageFlags.Ephemeral });
    }
  } catch (err) {
    console.error(`Error handling /${interaction.commandName}:`, err.message);
    const errorMsg = `Something went wrong: ${err.message}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(errorMsg);
    } else {
      await interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
    }
  }
});

startOAuthServer();
client.login(process.env.DISCORD_BOT_TOKEN);
