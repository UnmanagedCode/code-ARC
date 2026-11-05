// The action log: one row per step, clickable to scrub. Live steps append.
const ACTION_LABEL = { START: 'start', RESET: 'reset' };

function label(step) {
  const action = ACTION_LABEL[step.action] || step.action;
  const xy = step.x !== undefined ? ` (${step.x},${step.y})` : '';
  return { head: `#${step.n} ${action}${xy}`, tail: `${step.state} · ${step.levels_completed}/${step.win_levels}` };
}

export function createStepLog(listEl, onPick) {
  let selected = -1;

  function row(step, index) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'step-row';
    b.dataset.index = String(index);
    const { head, tail } = label(step);
    const h = document.createElement('span');
    h.className = 'step-head';
    h.textContent = head;
    const t = document.createElement('span');
    t.className = 'step-tail muted';
    t.textContent = tail;
    b.append(h, t);
    if (step.reasoning) b.title = step.reasoning;
    b.addEventListener('click', () => onPick(index));
    li.append(b);
    return li;
  }

  return {
    reset(steps) {
      selected = -1;
      listEl.replaceChildren(...steps.map(row));
    },
    append(step, index) {
      listEl.append(row(step, index));
    },
    select(index) {
      const rows = listEl.children;
      rows[selected]?.firstChild.removeAttribute('aria-current');
      selected = index;
      const cur = rows[index]?.firstChild;
      if (!cur) return;
      cur.setAttribute('aria-current', 'true');
      cur.scrollIntoView({ block: 'nearest' });
    },
  };
}
