require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("tiktok-connect")
    .setDescription("Link your TikTok account to New Tech Agency's bot"),
  new SlashCommandBuilder()
    .setName("tiktok-profile")
    .setDescription("Show your connected TikTok profile info"),
  new SlashCommandBuilder()
    .setName("tiktok-post")
    .setDescription("Post a video to TikTok from a public URL you own")
    .addStringOption((opt) =>
      opt.setName("video_url").setDescription("Public URL of the video file").setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName("title").setDescription("Caption/title for the post").setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("visibility")
        .setDescription("Who can see this post")
        .addChoices(
          { name: "Only me (sandbox/testing)", value: "SELF_ONLY" },
          { name: "Mutual followers", value: "MUTUAL_FOLLOW_FRIENDS" },
          { name: "Everyone", value: "PUBLIC_TO_EVERYONE" }
        )
    ),
  new SlashCommandBuilder()
    .setName("tiktok-status")
    .setDescription("Check the status of a video you posted")
    .addStringOption((opt) =>
      opt.setName("publish_id").setDescription("publish_id returned by /tiktok-post").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("tiktok-disconnect")
    .setDescription("Unlink your TikTok account from this bot"),
].map((c) => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);

(async () => {
  try {
    const route = process.env.DISCORD_GUILD_ID
      ? Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID)
      : Routes.applicationCommands(process.env.DISCORD_CLIENT_ID);

    await rest.put(route, { body: commands });
    console.log(
      `Registered ${commands.length} slash commands ${
        process.env.DISCORD_GUILD_ID ? "(guild-scoped, instant)" : "(global, may take up to 1h)"
      }.`
    );
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
})();
