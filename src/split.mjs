// Part A4 — split a multi-task email into independent sub-tasks. Each then runs on its OWN triage
// tier (five trivial edits → five cheap Haiku passes, not one Sonnet pass on a bloated prompt) and
// declares its OWN <VERIFY> checks, so one task failing doesn't sink the rest. Conservative: only
// splits on an explicit numbered/bulleted list of ≥2 items; anything else stays a single task.
//
// The text BEFORE the list (e.g. "On the homepage, please:") is shared scope — it's prepended to
// every sub-task so each keeps the context it needs to be understood in isolation.

const MARKER = /^\s*(?:[-*•]|\d+[.)])\s+(.*\S)\s*$/;

export function splitTasks(instruction) {
  const text = String(instruction || "");
  const lines = text.split(/\r?\n/);
  const items = [];
  const preamble = [];
  let started = false;
  for (const ln of lines) {
    const m = ln.match(MARKER);
    if (m) {
      items.push(m[1].trim());
      started = true;
    } else if (!ln.trim()) {
      continue; // blank line — ignore
    } else if (!started) {
      preamble.push(ln.trim()); // scope text above the list
    } else if (items.length) {
      items[items.length - 1] += " " + ln.trim(); // wrapped continuation of the current item
    }
  }
  if (items.length < 2) return [text]; // no clear multi-task list → one task (unchanged behaviour)
  const pre = preamble.join(" ").trim();
  return items.map((it) => (pre ? `${pre}\n\nTask: ${it}` : it));
}
