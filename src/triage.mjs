// Task triage + complexity routing (spec Part A3). Cheap rules-first classifier that tags each task
// with a tier, then routes model + turn cap + max-edit size. Goal: ≥70% of edits land on Haiku and
// trivial/mechanical edits stay under a few cents. Ambiguous → judgment (Sonnet). Anything that
// touches JS / interactivity → interactive (Sonnet, and Part B will browser-verify it).

// maxTurns are a SAFETY stop, not a cost lever (model routing is the cost lever). They were set too
// tight in v1 and crashed real tasks one edit short — these are realistic budgets. Image/attachment
// work gets a further +turns bonus in job.mjs (resizing on a box with no image tools is tool-heavy).
export const TIERS = {
  trivial:     { model: "claude-haiku-4-5-20251001", maxTurns: 8,  maxEdit: 200,       browserVerify: false },
  mechanical:  { model: "claude-haiku-4-5-20251001", maxTurns: 10, maxEdit: 400,       browserVerify: false },
  judgment:    { model: "claude-sonnet-4-6",         maxTurns: 16, maxEdit: 600,       browserVerify: false },
  structural:  { model: "claude-opus-4-8",           maxTurns: 35, maxEdit: Infinity,  browserVerify: false },
  interactive: { model: "claude-sonnet-4-6",         maxTurns: 18, maxEdit: 600,       browserVerify: true  },
};

// Signals (Latvian + English) for the JS/interactivity class — the dangerous one (Part A3/B).
const INTERACTIVE = /\b(toggle|tab|carousel|slider|carousel|modal|popup|accordion|checkbox|dropdown|filter|menu|button.*work|click|hover|animation|animate|script|javascript|\bjs\b|interactiv|form (submit|work|send)|calculat|slaid(?:r|er)|pārslēg|izvēln|poga.*(strādā|darbo)|aizpild|kalkulator)/i;
// Structural: moving/adding sections or pages, restyling a group, OR anything sitewide / multi-page
// (footer/header on every page, creating policy/terms pages) — these need a partial + many edits.
const STRUCTURAL = /\b(add (a )?(section|page|block)|new (section|page)|remove (the )?section|reorder|move (the|that) (section|block)|restructure|redesign|jaun(a|u) (sadaļ|lap)|pievieno.*(sadaļ|lap)|pārkārto|pārveido layout)|visās lapās|katrā lapā|visā(m|s) lapā(m|s)|all pages|every page|across (the|all) (site|pages)|site-?wide|privacy policy|terms (of|&|and)|(izveido|uztaisi|pievieno).{0,30}(politik|noteikum|lap)|footer[ī]?.{0,40}(visās|katrā|jābūt)/i;
// Judgment: rewriting prose / tone / multi-field consistent changes.
const JUDGMENT = /\b(rewrite|reword|rephrase|tone|paragraph|copywrit|make it (sound|read)|improve the (text|wording|copy)|pārraksti|pārfrāzē|toni|teksta? (uzlabo|labo))/i;
// Mechanical: a few fields / a data value / restyle one element.
const MECHANICAL = /\b(color|colour|font|size|spacing|padding|margin|align|restyle|background|krās|fontu|izmēr|atstarp|nobīd)/i;
// Trivial: typo / single field (price, phone, date, one image, one link).
const TRIVIAL = /\b(typo|fix the spelling|change the (price|phone|number|date|email|link|address)|update the (price|phone|date)|replace the (image|photo|logo)|cen|tālru|datum|e-?past|kļūd)/i;

// Rules-first tier. Order matters: most-specific / most-dangerous first.
export function triage(instruction) {
  const t = String(instruction || "");
  // Count distinct "tasks" in a multi-task email (numbered/bulleted lines) — many tasks lifts the tier.
  const taskish = (t.match(/(^|\n)\s*([-*•]|\d+[.)])\s+\S/g) || []).length;

  let tier;
  if (INTERACTIVE.test(t)) tier = "interactive";
  else if (STRUCTURAL.test(t)) tier = "structural";
  else if (JUDGMENT.test(t)) tier = "judgment";
  else if (TRIVIAL.test(t) && taskish <= 1) tier = "trivial";
  else if (MECHANICAL.test(t)) tier = "mechanical";
  else tier = "judgment"; // ambiguous → judgment (Sonnet), per spec

  // A single email bundling many tasks shouldn't run trivial/mechanical caps — it needs room.
  // (Part A4 will split these into micro-jobs; until then, lift the cap so we don't truncate.)
  if (taskish >= 3 && (tier === "trivial" || tier === "mechanical")) tier = "judgment";

  return { tier, taskCount: taskish, ...TIERS[tier] };
}
