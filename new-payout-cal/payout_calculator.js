/**
 * NEW TEC — PAYOUT CALCULATOR
 * ==================================================================
 * Pure payout logic. No dependencies, no network, no Airtable, no
 * environment variables. Drop this file into any system and call it.
 *
 * Works as-is in Node (CommonJS), bundlers (ESM), and the browser.
 *
 *   const calc = require("./payout_calculator");
 *   const r = calc.calculatePayout({
 *     views: 250000,
 *     ratePerMillion: 300,
 *     clipType: "Original-Edited",
 *     platform: "TikTok",
 *   });
 *   // r.payouts -> { clipper: 41.25, editor: 0, accountManager: 18.75, agency: 15 }
 *
 * ------------------------------------------------------------------
 * THE MODEL IN ONE LINE
 * ------------------------------------------------------------------
 *   total       = (views / 1,000,000) * ratePerMillion
 *   role payout = total * that role's percentage
 *
 * The CAMPAIGN supplies the rate. The CLIP SCENARIO supplies the
 * percentages. Nothing else affects the number.
 *
 * ------------------------------------------------------------------
 * ⚠ THIS SCENARIO SET IS DELIBERATELY SMALL AND WILL GROW
 * ------------------------------------------------------------------
 * There are currently three scenarios. That is the minimum covering
 * current operations, not the finished design. More are coming and
 * existing percentages will change.
 *
 * Do NOT hardcode scenario names in the consuming system. Read the
 * list at runtime:
 *
 *   calc.listScenarios()        -> ["Original-Edited", "Raw + Edited", ...]
 *   calc.describeScenario(name) -> full definition incl. percentages
 *
 * Adding a scenario should mean adding one entry to SPLITS below
 * (plus OWN_SPLITS if it can be an AM's own clip) and nothing else.
 */

// ==================================================================
// SPLIT TABLE — the single source of truth
// ==================================================================
/**
 *   src  = sourcer / finder   (who found or clipped it)
 *   edit = editor             (who edited it)
 *   am   = account manager    (posting, caption, page management)
 *   own  = agency             (house share)
 *
 * `std` applies to TikTok, X and Instagram.
 * `yt`  applies to YouTube, the only platform weighted differently.
 *
 * Keys are the canonical scenario names. Whatever stores clip data
 * must use these exact strings.
 */
var SPLITS = {
  "Original-Edited": {
    // Clipped from the stream and edited by the same person.
    ownable: true,
    std: { src: 0.55, edit: 0.00, am: 0.25, own: 0.20 },
    yt:  { src: 0.60, edit: 0.00, am: 0.20, own: 0.20 },
  },
  "Raw + Edited": {
    // Sourced by one person, edited by another. Cannot be an AM's own
    // clip, because by definition the work was split between people.
    ownable: false,
    std: { src: 0.20, edit: 0.35, am: 0.25, own: 0.20 },
    yt:  { src: 0.20, edit: 0.40, am: 0.20, own: 0.20 },
  },
  "Ripped + Edited": {
    // Account managers only, YouTube only. Never pays a sourcer or
    // editor share — the manager did every job. Resolves the same way
    // whether or not the AM's-own flag is set.
    ownable: true,
    amOnly: true,
    platforms: ["YouTube"],
    std: { src: 0.00, edit: 0.00, am: 0.70, own: 0.30 },
    yt:  { src: 0.00, edit: 0.00, am: 0.70, own: 0.30 },
  },
};

/** Applied when the account manager did every job themselves. */
var OWN_SPLITS = {
  "Original-Edited": { src: 0, edit: 0, am: 0.80, own: 0.20 },
  "Ripped + Edited": { src: 0, edit: 0, am: 0.70, own: 0.30 },
};

/**
 * Scenarios removed from the system. Rejected with guidance rather
 * than silently paid on retired rules. Every clip must now be edited.
 */
var RETIRED_TYPES = {
  "Ripped": 'Unedited ripped clips are no longer allowed — every ripped clip must be edited. Reclassify as "Ripped + Edited".',
  "Raw":    'Unedited raw clips are no longer allowed — every raw clip must be edited. Reclassify as "Raw + Edited".',
  "Stolen": '"Stolen" became "Ripped", which has since been retired. Reclassify as "Ripped + Edited".',
};

/** Platforms sharing the standard band. YouTube is handled separately. */
var STANDARD_PLATFORMS = ["TikTok", "X", "Instagram"];

// ==================================================================
// VALIDATION
// ==================================================================
/**
 * Every scenario must total exactly 100%. Call this once at startup.
 * A table that does not balance means every clip pays out wrong, so
 * the consuming system should refuse to run rather than continue.
 *
 * @returns {string[]} problems — empty array means valid
 */
function validateSplits() {
  var problems = [];
  var round = function (n) { return Math.round(n * 1e6) / 1e6; };

  Object.keys(SPLITS).forEach(function (type) {
    var cfg = SPLITS[type];
    ["std", "yt"].forEach(function (band) {
      var s = cfg[band];
      if (!s) { problems.push('SPLITS["' + type + '"] is missing the "' + band + '" band'); return; }
      var total = round(s.src + s.edit + s.am + s.own);
      if (total !== 1) {
        problems.push('SPLITS["' + type + '"].' + band + ' totals ' + (total * 100).toFixed(2) + '%, expected 100%');
      }
      Object.keys(s).forEach(function (k) {
        if (s[k] < 0 || s[k] > 1) {
          problems.push('SPLITS["' + type + '"].' + band + '.' + k + ' = ' + s[k] + ' is outside 0–1');
        }
      });
    });
  });

  Object.keys(OWN_SPLITS).forEach(function (type) {
    var s = OWN_SPLITS[type];
    var total = round(s.src + s.edit + s.am + s.own);
    if (total !== 1) {
      problems.push('OWN_SPLITS["' + type + '"] totals ' + (total * 100).toFixed(2) + '%, expected 100%');
    }
    if (!SPLITS[type]) {
      problems.push('OWN_SPLITS["' + type + '"] has no matching entry in SPLITS');
    } else if (!SPLITS[type].ownable) {
      problems.push('OWN_SPLITS["' + type + '"] exists but SPLITS marks it not ownable');
    }
  });

  return problems;
}

// ==================================================================
// SCENARIO INTROSPECTION — use these instead of hardcoding names
// ==================================================================
/** @returns {string[]} every valid scenario name, in definition order */
function listScenarios() {
  return Object.keys(SPLITS);
}

/** @returns {string[]} scenarios valid on a given platform */
function scenariosForPlatform(platform) {
  return Object.keys(SPLITS).filter(function (t) {
    var p = SPLITS[t].platforms;
    return !p || p.indexOf(platform) !== -1;
  });
}

/**
 * Full definition of one scenario, safe to render in a UI.
 * @returns {object|null}
 */
function describeScenario(clipType) {
  var cfg = SPLITS[clipType];
  if (!cfg) return null;
  return {
    name: clipType,
    platforms: cfg.platforms ? cfg.platforms.slice() : STANDARD_PLATFORMS.concat(["YouTube"]),
    accountManagerOnly: !!cfg.amOnly,
    canBeAMOwnClip: !!cfg.ownable,
    percentages: {
      standard: { clipper: cfg.std.src, editor: cfg.std.edit, accountManager: cfg.std.am, agency: cfg.std.own },
      youtube:  { clipper: cfg.yt.src,  editor: cfg.yt.edit,  accountManager: cfg.yt.am,  agency: cfg.yt.own },
      amOwnClip: OWN_SPLITS[clipType]
        ? { clipper: OWN_SPLITS[clipType].src, editor: OWN_SPLITS[clipType].edit,
            accountManager: OWN_SPLITS[clipType].am, agency: OWN_SPLITS[clipType].own }
        : null,
    },
  };
}

/** @returns {string[]} retired scenario names, for migration checks */
function listRetiredScenarios() {
  return Object.keys(RETIRED_TYPES);
}

// ==================================================================
// SPLIT RESOLUTION
// ==================================================================
/**
 * Resolve the percentage split for one clip.
 * Throws with a message safe to surface to a non-technical user.
 *
 * @param {string} clipType
 * @param {string} platform    "TikTok" | "YouTube" | "X" | "Instagram"
 * @param {boolean} isAMOwnClip
 * @returns {{src:number, edit:number, am:number, own:number}}
 */
function getSplit(clipType, platform, isAMOwnClip) {
  var cfg = SPLITS[clipType];

  if (!cfg) {
    if (RETIRED_TYPES[clipType]) {
      throw new Error('Clip Type "' + clipType + '" has been retired. ' + RETIRED_TYPES[clipType]);
    }
    throw new Error(
      'Unrecognized Clip Type "' + clipType + '". Valid options: ' + Object.keys(SPLITS).join(", ")
    );
  }

  if (cfg.platforms && cfg.platforms.indexOf(platform) === -1) {
    throw new Error(
      '"' + clipType + '" is only permitted on ' + cfg.platforms.join(", ") +
      ', but this clip is logged as ' + platform + '. Either correct the platform, or reclassify the clip.'
    );
  }

  // Account-manager-only scenarios resolve identically either way —
  // nobody else can have worked on them.
  if (cfg.amOnly) return cfg.std;

  if (isAMOwnClip) {
    if (!cfg.ownable) {
      throw new Error(
        '"' + clipType + '" cannot be an AM\'s own clip — that scenario means the work was split ' +
        'between people. If the AM did everything themselves, log it as Original-Edited.'
      );
    }
    var own = OWN_SPLITS[clipType];
    if (!own) throw new Error('No AM\'s-own split defined for "' + clipType + '"');
    return own;
  }

  return platform === "YouTube" ? cfg.yt : cfg.std;
}

// ==================================================================
// PAYOUT CALCULATION
// ==================================================================
function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

/**
 * Calculate every role's payout for a single clip.
 *
 * @param {object} input
 * @param {number} input.views              view count
 * @param {number} input.ratePerMillion     campaign rate, $ per 1,000,000 views
 * @param {string} input.clipType           must match a scenario name
 * @param {string} input.platform           "TikTok" | "YouTube" | "X" | "Instagram"
 * @param {boolean} [input.isAMOwnClip]     AM did every job themselves
 * @param {boolean} [input.hasEditor]       an editor is assigned (for warnings)
 * @param {boolean} [input.hasClipper]      a sourcer is assigned (for warnings)
 *
 * @returns {object} result
 *   result.total        {number}  gross generated by the clip
 *   result.payouts      {object}  { clipper, editor, accountManager, agency }
 *   result.percentages  {object}  same shape, as 0–100 numbers
 *   result.rateUsed     {number}  echoed back for audit trails
 *   result.warnings     {string[]} non-fatal issues worth surfacing
 *
 * Throws on invalid combinations. Callers should catch and record the
 * message against the clip rather than dropping it silently.
 */
function calculatePayout(input) {
  if (!input || typeof input !== "object") {
    throw new Error("calculatePayout requires an input object.");
  }

  var views = Number(input.views);
  var rate = Number(input.ratePerMillion);
  if (!isFinite(views) || views < 0) throw new Error("views must be a non-negative number.");
  if (!isFinite(rate) || rate < 0) throw new Error("ratePerMillion must be a non-negative number.");

  var isOwn = input.isAMOwnClip === true;
  var split = getSplit(input.clipType, input.platform, isOwn);

  var total = (views / 1000000) * rate;
  var warnings = [];

  // An editor share with nobody assigned is money allocated to no one.
  if (split.edit > 0 && input.hasEditor === false) {
    warnings.push(
      '"' + input.clipType + '" owes ' + Math.round(split.edit * 100) +
      '% to an editor but no editor is assigned. That share is unallocated.'
    );
  }
  // Someone tagged on a clip that pays them nothing is expecting money
  // that will never arrive.
  if (SPLITS[input.clipType].amOnly) {
    var tagged = [];
    if (input.hasClipper === true) tagged.push("A sourcer");
    if (input.hasEditor === true) tagged.push("An editor");
    if (tagged.length) {
      warnings.push(
        tagged.join(" and ") + ' is assigned to "' + input.clipType +
        '", which pays the account manager and agency only. They receive $0.'
      );
    }
  }

  return {
    total: round2(total),
    rateUsed: rate,
    payouts: {
      clipper:        round2(total * split.src),
      editor:         round2(total * split.edit),
      accountManager: round2(total * split.am),
      agency:         round2(total * split.own),
    },
    percentages: {
      // Rounded to 4dp: 0.55 * 100 is 55.00000000000001 in floating
      // point, which looks like corruption if written to a field.
      clipper:        round4(split.src * 100),
      editor:         round4(split.edit * 100),
      accountManager: round4(split.am * 100),
      agency:         round4(split.own * 100),
    },
    warnings: warnings,
  };
}

/**
 * Convenience wrapper for many clips at once. Never throws — a failed
 * clip comes back with `error` set so one bad record cannot abort a
 * whole batch.
 *
 * @param {object[]} clips  same shape as calculatePayout input
 * @returns {object[]} results, each either a payout or { error, input }
 */
function calculateBatch(clips) {
  return (clips || []).map(function (c) {
    try {
      var r = calculatePayout(c);
      r.input = c;
      return r;
    } catch (err) {
      return { error: err.message, input: c, payouts: null };
    }
  });
}

// ==================================================================
// EXPORTS — CommonJS, ESM bundlers, and browser global
// ==================================================================
var API = {
  SPLITS: SPLITS,
  OWN_SPLITS: OWN_SPLITS,
  RETIRED_TYPES: RETIRED_TYPES,
  STANDARD_PLATFORMS: STANDARD_PLATFORMS,
  validateSplits: validateSplits,
  listScenarios: listScenarios,
  scenariosForPlatform: scenariosForPlatform,
  describeScenario: describeScenario,
  listRetiredScenarios: listRetiredScenarios,
  getSplit: getSplit,
  calculatePayout: calculatePayout,
  calculateBatch: calculateBatch,
  round2: round2,
  round4: round4,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = API;
} else if (typeof window !== "undefined") {
  window.NewTecPayout = API;
}
