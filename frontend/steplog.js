// The action log: one <li> per loaded step (positional index = steps index),
// clickable to scrub. Script steps carry a badge; the first loaded step of
// each run segment carries a "Script run k — note" header. Live steps append;
// past the viewer's cap the oldest row is trimmed. Every value is set as text.
import { needsRunHeader, sourceOf } from './runs.js';

const ACTION_LABEL = { START: 'start', RESET: 'reset' };

function label(step) {
  const action = ACTION_LABEL[step.action] || step.action;
  const xy = step.x !== undefined ? ` (${step.x},${step.y})` : '';
  return { head: `#${step.n} ${action}${xy}`, tail: `${step.state} · ${step.levels_completed}/${step.win_levels}` };
}

const headerText = (run, note) => (note ? `Script run ${run} — ${note.text}` : `Script run ${run}`);

// `noteOf(step)` returns the note of a script step's run, or null.
export function createStepLog(listEl, { onPick, noteOf }) {
  let selected = -1;

  function runHeader(step) {
    const h = document.createElement('div');
    h.className = 'run-header';
    h.dataset.run = String(step.run);
    h.textContent = headerText(step.run, noteOf(step));
    return h;
  }

  function row(step, withHeader) {
    const li = document.createElement('li');
    if (withHeader) li.append(runHeader(step));
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'step-row';
    const { head, tail } = label(step);
    const h = document.createElement('span');
    h.className = 'step-head';
    h.textContent = head;
    const source = sourceOf(step);
    if (source === 'script' || source === 'human') {
      const badge = document.createElement('span');
      badge.className = `badge source-${source}`;
      badge.textContent = source;
      h.append(' ', badge);
    }
    const t = document.createElement('span');
    t.className = 'step-tail muted';
    t.textContent = tail;
    b.append(h, t);
    if (step.reasoning) b.title = step.reasoning;
    // The row's position, not a captured index: trimming shifts every row.
    b.addEventListener('click', () => onPick(Array.prototype.indexOf.call(listEl.children, li)));
    li.append(b);
    return li;
  }

  const button = (li) => li?.querySelector('.step-row') || null;

  return {
    reset(steps) {
      selected = -1;
      listEl.replaceChildren(...steps.map((s, i) => row(s, needsRunHeader(steps, i))));
    },
    // Adds the row for the last of `steps`.
    append(steps) {
      const i = steps.length - 1;
      listEl.append(row(steps[i], needsRunHeader(steps, i)));
    },
    // Drops the first row after its step was shifted off `steps`; the new
    // first row gets a run header if it now starts a segment.
    trimFirst(steps) {
      listEl.firstElementChild?.remove();
      if (selected >= 0) selected--;
      const first = listEl.firstElementChild;
      if (first && needsRunHeader(steps, 0) && !first.querySelector('.run-header')) first.prepend(runHeader(steps[0]));
    },
    // A run's note arrived: refresh its headers.
    setNote(note) {
      for (const h of listEl.querySelectorAll('.run-header')) {
        if (h.dataset.run === String(note.run)) h.textContent = headerText(note.run, note);
      }
    },
    select(index) {
      const rows = listEl.children;
      button(rows[selected])?.removeAttribute('aria-current');
      selected = index;
      const cur = button(rows[index]);
      if (!cur) return;
      cur.setAttribute('aria-current', 'true');
      cur.scrollIntoView({ block: 'nearest' });
    },
  };
}
