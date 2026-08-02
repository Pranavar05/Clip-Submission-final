/**
 * oauthServer.js
 *
 * Minimal Express server that TikTok redirects to after a user authorizes
 * the app (redirect_uri = TIKTOK_REDIRECT_URI). Exchanges the code for
 * tokens, stores them, and shows the user a simple confirmation page —
 * then they go back to Discord. Nothing sensitive is ever displayed here.
 */
const express = require("express");
const { exchangeCodeForToken } = require("./tiktokAuth");
const { saveTokens } = require("./tokenStore");

function startOAuthServer() {
  const app = express();

  app.get("/callback", async (req, res) => {
    const { code, state, error, error_description } = req.query;

    if (error) {
      res.status(400).send(`TikTok authorization failed: ${error_description || error}`);
      return;
    }
    if (!code || !state) {
      res.status(400).send("Missing code or state in callback.");
      return;
    }

    try {
      const tokenData = await exchangeCodeForToken(code, state);
      saveTokens(tokenData.discordUserId, tokenData);
      res.send(
        "<h2>TikTok connected ✅</h2><p>You can close this tab and go back to Discord.</p>"
      );
    } catch (err) {
      console.error("OAuth callback error:", err.message);
      res.status(500).send("Something went wrong linking your TikTok account. Please try /tiktok-connect again.");
    }
  });

  app.get("/health", (_req, res) => res.send("ok"));

  const port = process.env.OAUTH_SERVER_PORT || 3000;
  app.listen(port, () => {
    console.log(`OAuth callback server listening on port ${port}`);
  });
}

module.exports = { startOAuthServer };
