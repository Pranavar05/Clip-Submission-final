/**
 * NEW TEC — PAYOUT CALCULATOR TESTS
 * ------------------------------------------------------------------
 *   node test_payout_calculator.js
 *
 * No dependencies, no credentials, no network. Run this after ANY
 * change to the split table — a failure means someone would be paid
 * the wrong amount.
 */

var calc = require("./payout_calculator");

var pass = 0, fail = 0;

function check(name, actual, expected) {
  var ok = actual === expected;
  console.log((ok ? "  PASS" : "**FAIL**") + "  " + name + ": " + actual + (ok ? "" : "  (expected " + expected + ")"));
  ok ? pass++ : fail++;
}
function throws(name, fn, mustInclude) {
  try {
    fn();
    console.log("**FAIL**  " + name + ": did not throw");
    fail++;
  } catch (e) {
    var ok = e.message.indexOf(mustInclude) !== -1;
    console.log((ok ? "  PASS" : "**FAIL**") + "  " + name + ": " + (ok ? "threw as expected" : "wrong message -> " + e.message));
    ok ? pass++ : fail++;
  }
}
function pay(clipType, platform, isOwn, views, rate, role) {
  return calc.calculatePayout({
    views: views, ratePerMillion: rate, clipType: clipType,
    platform: platform, isAMOwnClip: isOwn,
  }).payouts[role];
}

console.log("\n=== 1. SPLIT TABLE INTEGRITY ===");
var problems = calc.validateSplits();
check("table validates clean", problems.length, 0);
problems.forEach(function (p) { console.log("     - " + p); });
check("three scenarios", calc.listScenarios().length, 3);
check("two AM's-own scenarios", Object.keys(calc.OWN_SPLITS).length, 2);
check("three retired scenarios", calc.listRetiredScenarios().length, 3);

console.log("\n=== 2. ORIGINAL-EDITED ===");
// 1,000,000 views @ $200/mil = $200 gross
check("TikTok clipper 55%", pay("Original-Edited", "TikTok", false, 1e6, 200, "clipper"), 110);
check("TikTok manager 25%", pay("Original-Edited", "TikTok", false, 1e6, 200, "accountManager"), 50);
check("TikTok agency 20%",  pay("Original-Edited", "TikTok", false, 1e6, 200, "agency"), 40);
check("YouTube clipper 60%", pay("Original-Edited", "YouTube", false, 1e6, 200, "clipper"), 120);
check("YouTube manager 20%", pay("Original-Edited", "YouTube", false, 1e6, 200, "accountManager"), 40);
check("X uses standard band", pay("Original-Edited", "X", false, 1e6, 200, "clipper"), 110);
check("Instagram uses standard band", pay("Original-Edited", "Instagram", false, 1e6, 200, "clipper"), 110);

console.log("\n=== 3. RAW + EDITED ===");
check("clipper 20%", pay("Raw + Edited", "TikTok", false, 1e6, 100, "clipper"), 20);
check("editor 35%",  pay("Raw + Edited", "TikTok", false, 1e6, 100, "editor"), 35);
check("manager 25%", pay("Raw + Edited", "TikTok", false, 1e6, 100, "accountManager"), 25);
check("YouTube editor 40%", pay("Raw + Edited", "YouTube", false, 1e6, 100, "editor"), 40);
check("YouTube manager 20%", pay("Raw + Edited", "YouTube", false, 1e6, 100, "accountManager"), 20);

console.log("\n=== 4. RIPPED + EDITED (AM-only, YouTube-only, 70/30) ===");
check("clipper 0%",  pay("Ripped + Edited", "YouTube", false, 1e6, 300, "clipper"), 0);
check("editor 0%",   pay("Ripped + Edited", "YouTube", false, 1e6, 300, "editor"), 0);
check("manager 70%", pay("Ripped + Edited", "YouTube", false, 1e6, 300, "accountManager"), 210);
check("agency 30%",  pay("Ripped + Edited", "YouTube", false, 1e6, 300, "agency"), 90);
check("AM's-own flag changes nothing", pay("Ripped + Edited", "YouTube", true, 1e6, 300, "accountManager"), 210);

console.log("\n=== 5. PLATFORM RESTRICTION ===");
throws("rejected on TikTok",    function () { calc.getSplit("Ripped + Edited", "TikTok", false); }, "only permitted on YouTube");
throws("rejected on X",         function () { calc.getSplit("Ripped + Edited", "X", false); }, "only permitted on YouTube");
throws("rejected on Instagram", function () { calc.getSplit("Ripped + Edited", "Instagram", false); }, "only permitted on YouTube");
check("scenariosForPlatform(TikTok) excludes ripped", calc.scenariosForPlatform("TikTok").indexOf("Ripped + Edited"), -1);
check("scenariosForPlatform(YouTube) includes ripped", calc.scenariosForPlatform("YouTube").length, 3);

console.log("\n=== 6. AM'S OWN CLIPS ===");
check("own Original-Edited clipper 0", pay("Original-Edited", "TikTok", true, 1e6, 200, "clipper"), 0);
check("own Original-Edited manager 80%", pay("Original-Edited", "TikTok", true, 1e6, 200, "accountManager"), 160);
check("own clips ignore platform", pay("Original-Edited", "YouTube", true, 1e6, 200, "accountManager"), 160);
check("own Ripped+Edited manager 70%", pay("Ripped + Edited", "YouTube", true, 1e6, 200, "accountManager"), 140);
throws("Raw + Edited cannot be AM's own", function () { calc.getSplit("Raw + Edited", "TikTok", true); }, "cannot be an AM's own clip");

console.log("\n=== 7. RETIRED SCENARIOS ===");
throws("Ripped retired", function () { calc.getSplit("Ripped", "TikTok", false); }, "has been retired");
throws("Raw retired",    function () { calc.getSplit("Raw", "TikTok", false); }, "has been retired");
throws("Stolen retired", function () { calc.getSplit("Stolen", "TikTok", false); }, "has been retired");
throws("unknown scenario", function () { calc.getSplit("Sparkle", "TikTok", false); }, "Unrecognized Clip Type");

console.log("\n=== 8. WARNINGS ===");
var w1 = calc.calculatePayout({ views: 1e6, ratePerMillion: 100, clipType: "Raw + Edited",
  platform: "TikTok", hasEditor: false });
check("missing editor warns", w1.warnings.length, 1);
check("still pays out", w1.payouts.editor, 35);
var w2 = calc.calculatePayout({ views: 1e6, ratePerMillion: 100, clipType: "Ripped + Edited",
  platform: "YouTube", hasClipper: true, hasEditor: true });
check("tagging on AM-only warns", w2.warnings.length, 1);
check("tagged people get $0", w2.payouts.clipper, 0);
var w3 = calc.calculatePayout({ views: 1e6, ratePerMillion: 100, clipType: "Original-Edited", platform: "TikTok" });
check("clean clip has no warnings", w3.warnings.length, 0);

console.log("\n=== 9. TOTALS AND ROUNDING ===");
var r = calc.calculatePayout({ views: 250000, ratePerMillion: 300, clipType: "Original-Edited", platform: "TikTok" });
check("total = $75", r.total, 75);
check("clipper 55% of 75", r.payouts.clipper, 41.25);
check("parts sum to total",
  calc.round2(r.payouts.clipper + r.payouts.editor + r.payouts.accountManager + r.payouts.agency), 75);
check("rateUsed echoed for audit", r.rateUsed, 300);
check("percentages exposed", r.percentages.clipper, 55);
check("zero views pays zero", calc.calculatePayout({ views: 0, ratePerMillion: 300,
  clipType: "Original-Edited", platform: "TikTok" }).total, 0);

console.log("\n=== 10. INPUT VALIDATION ===");
throws("negative views rejected", function () {
  calc.calculatePayout({ views: -5, ratePerMillion: 100, clipType: "Original-Edited", platform: "TikTok" });
}, "non-negative");
throws("bad rate rejected", function () {
  calc.calculatePayout({ views: 100, ratePerMillion: "abc", clipType: "Original-Edited", platform: "TikTok" });
}, "non-negative");

console.log("\n=== 11. BATCH ===");
var batch = calc.calculateBatch([
  { views: 1e6, ratePerMillion: 200, clipType: "Original-Edited", platform: "TikTok" },
  { views: 1e6, ratePerMillion: 200, clipType: "Ripped", platform: "TikTok" },          // retired
  { views: 1e6, ratePerMillion: 300, clipType: "Ripped + Edited", platform: "YouTube" },
]);
check("batch returns all rows", batch.length, 3);
check("good row calculated", batch[0].payouts.clipper, 110);
check("bad row isolated, not thrown", typeof batch[1].error, "string");
check("bad row has null payouts", batch[1].payouts, null);
check("row after bad one still works", batch[2].payouts.accountManager, 210);

console.log("\n=== 12. INTROSPECTION (avoid hardcoding) ===");
var d = calc.describeScenario("Ripped + Edited");
check("describes AM-only", d.accountManagerOnly, true);
check("describes platform limit", d.platforms.join(","), "YouTube");
check("exposes AM-own percentages", d.percentages.amOwnClip.accountManager, 0.7);
check("unknown scenario returns null", calc.describeScenario("Nope"), null);

console.log("\n" + new Array(51).join("="));
console.log(pass + " passed, " + fail + " failed");
console.log(new Array(51).join("=") + "\n");
process.exit(fail ? 1 : 0);
