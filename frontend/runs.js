// Script runs in the viewer: which steps a script took, where a run header
// goes in the action log, and the note that explains a run. Pure: no DOM.

// A step without `source` predates scripting and came from a tool.
export const sourceOf = (step) => (step?.source === 'script' || step?.source === 'human' ? step.source : 'tool');

// A script step belongs to a run once a note opened one; a script step taken
// before the first note has none.
export const hasRun = (step) => sourceOf(step) === 'script' && Number.isInteger(step.run);

// A run step starts a run segment when the step loaded before it is not in
// the same run (a tool step, another run, or nothing loaded before it).
export function needsRunHeader(steps, i) {
  const step = steps[i];
  if (!hasRun(step)) return false;
  const prev = steps[i - 1];
  return !prev || sourceOf(prev) !== 'script' || prev.run !== step.run;
}

// The note that opened a script step's run, or null (tool step, no run, or not loaded).
export function noteFor(notes, step) {
  if (!hasRun(step)) return null;
  return notes.find((n) => n.run === step.run) || null;
}

// `loaded` plus any note of `live` it lacks (one arrived while loading), by run.
export function mergeNotes(loaded, live) {
  const out = [...loaded];
  for (const n of live) if (!out.some((m) => m.run === n.run)) out.push(n);
  return out.sort((a, b) => a.run - b.run);
}
