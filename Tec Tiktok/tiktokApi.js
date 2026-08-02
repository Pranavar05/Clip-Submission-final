/**
 * tiktokApi.js
 *
 * Thin wrapper around the TikTok Display API (read profile/video data) and
 * Content Posting API (publish video). Automatically refreshes the access
 * token if it's expired or about to expire before making a call.
 */
const axios = require("axios");
const { getTokens, saveTokens } = require("./tokenStore");
const { refreshAccessToken } = require("./tiktokAuth");

const API_BASE = "https://open.tiktokapis.com/v2";
const REFRESH_MARGIN_SECONDS = 120; // refresh a bit before actual expiry

/**
 * Ensures we have a valid (non-expired) access token for this Discord user,
 * refreshing it if necessary, and persists any refreshed tokens.
 */
async function getValidAccessToken(discordUserId) {
  const stored = getTokens(discordUserId);
  if (!stored) {
    throw new Error(
      "This Discord account isn't linked to TikTok yet. Run /tiktok-connect first."
    );
  }

  const now = Math.floor(Date.now() / 1000);
  if (stored.expires_at - now > REFRESH_MARGIN_SECONDS) {
    return stored.access_token;
  }

  if (stored.refresh_expires_at <= now) {
    throw new Error(
      "Your TikTok connection has expired (refresh token is over a year old). Please run /tiktok-connect again."
    );
  }

  const refreshed = await refreshAccessToken(stored.refresh_token);
  saveTokens(discordUserId, {
    ...refreshed,
  });
  return refreshed.access_token;
}

/**
 * Display API: basic profile info for the connected user.
 */
async function getUserInfo(discordUserId) {
  const accessToken = await getValidAccessToken(discordUserId);
  const fields = ["open_id", "display_name", "avatar_url", "follower_count"].join(",");

  const { data } = await axios.get(`${API_BASE}/user/info/`, {
    params: { fields },
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (data.error && data.error.code !== "ok") {
    throw new Error(`TikTok API error: ${data.error.message}`);
  }
  return data.data.user;
}

/**
 * Content Posting API: publish a video TikTok pulls from a public URL you own
 * (PULL_FROM_URL). Ownership of the hosting domain must be verified in the
 * TikTok developer portal before this works in production.
 *
 * In Sandbox mode, posts are automatically forced to private visibility.
 */
async function postVideoFromUrl(discordUserId, { videoUrl, title, privacyLevel = "SELF_ONLY" }) {
  const accessToken = await getValidAccessToken(discordUserId);

  const body = {
    post_info: {
      title,
      privacy_level: privacyLevel, // e.g. PUBLIC_TO_EVERYONE, MUTUAL_FOLLOW_FRIENDS, SELF_ONLY
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false,
    },
    source_info: {
      source: "PULL_FROM_URL",
      video_url: videoUrl,
    },
  };

  const { data } = await axios.post(`${API_BASE}/post/publish/video/init/`, body, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
  });

  if (data.error && data.error.code !== "ok") {
    throw new Error(`TikTok publish failed: ${data.error.message}`);
  }
  return data.data; // contains publish_id to poll status with
}

/**
 * Poll the status of a previously-initiated publish.
 */
async function getPublishStatus(discordUserId, publishId) {
  const accessToken = await getValidAccessToken(discordUserId);
  const { data } = await axios.post(
    `${API_BASE}/post/publish/status/fetch/`,
    { publish_id: publishId },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
    }
  );

  if (data.error && data.error.code !== "ok") {
    throw new Error(`TikTok status check failed: ${data.error.message}`);
  }
  return data.data;
}

module.exports = { getUserInfo, postVideoFromUrl, getPublishStatus, getValidAccessToken };
