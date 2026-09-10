const STORAGE_KEY = 'championLog.v1';

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : { logs: [] };
  } catch {
    return { logs: [] };
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private browsing / storage quota — progress just won't persist this session.
  }
}

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function isNextCalendarDay(earlier, later) {
  const a = new Date(`${earlier}T00:00:00`);
  const b = new Date(`${later}T00:00:00`);
  return b - a === 86400000;
}

function computeStreaks(logs) {
  const dates = [...new Set(logs.map((log) => log.date))].sort();
  if (!dates.length) {
    return { current: 0, best: 0 };
  }

  let best = 1;
  let run = 1;
  for (let i = 1; i < dates.length; i += 1) {
    run = isNextCalendarDay(dates[i - 1], dates[i]) ? run + 1 : 1;
    best = Math.max(best, run);
  }

  const dateSet = new Set(dates);
  let current = 0;
  const cursor = new Date();
  while (dateSet.has(todayKey(cursor))) {
    current += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  return { current, best };
}

function relativeDay(dateKey) {
  if (!dateKey) return 'Never';
  const diffDays = Math.round((new Date(todayKey()) - new Date(dateKey)) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return `${diffDays} days ago`;
}

function formatLog(log) {
  const weightPart = log.weight > 0 ? ` @ ${log.weight}kg` : '';
  return `${log.sets} × ${log.reps}${weightPart}`;
}

function renderCommitmentBar(state) {
  const bar = document.querySelector('.commitment-bar');
  if (!bar) return;

  const { current } = computeStreaks(state.logs);
  const trainedToday = state.logs.some((log) => log.date === todayKey());

  bar.querySelector('.commitment-streak-value').textContent = current;
  const status = bar.querySelector('.commitment-status');
  status.dataset.status = trainedToday ? 'trained' : 'pending';
  status.textContent = trainedToday ? '✅ Trained today' : '⚠️ No training logged today';
}

function renderStatTiles(state) {
  const { logs } = state;
  const { current, best } = computeStreaks(logs);
  const totalSessions = new Set(logs.map((log) => log.date)).size;
  const lastDate = logs.length
    ? logs.map((log) => log.date).sort().at(-1)
    : null;

  const values = {
    'stat-current-streak': current,
    'stat-best-streak': best,
    'stat-total-sessions': totalSessions,
    'stat-last-trained': relativeDay(lastDate),
  };

  for (const [id, value] of Object.entries(values)) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }
}

function renderExerciseLastLogs(state) {
  document.querySelectorAll('[data-exercise-last-log]').forEach((el) => {
    const exerciseId = el.dataset.exerciseLastLog;
    const lastForExercise = state.logs
      .filter((log) => log.exerciseId === exerciseId)
      .sort((a, b) => a.ts - b.ts)
      .at(-1);

    if (!lastForExercise) {
      el.textContent = 'Not logged yet';
      el.dataset.hasLog = 'false';
      return;
    }

    el.textContent = `Last: ${formatLog(lastForExercise)} — ${relativeDay(lastForExercise.date)}`;
    el.dataset.hasLog = 'true';
  });
}

function renderActivityList(state) {
  const list = document.getElementById('activity-list');
  if (!list) return;

  const recent = [...state.logs].sort((a, b) => b.ts - a.ts).slice(0, 10);

  if (!recent.length) {
    list.innerHTML = '<li class="activity-empty">No sets logged yet — your first entry starts the streak.</li>';
    return;
  }

  list.innerHTML = recent
    .map((log) => {
      const name = document.querySelector(`[data-exercise-id="${log.exerciseId}"] h2`)?.textContent ?? log.exerciseId;
      return `<li class="activity-row">
        <span class="activity-row-exercise">${name}</span>
        <span class="activity-row-meta">${formatLog(log)} · ${relativeDay(log.date)}</span>
      </li>`;
    })
    .join('');
}

function renderAll(state) {
  renderCommitmentBar(state);
  renderStatTiles(state);
  renderExerciseLastLogs(state);
  renderActivityList(state);
}

function init() {
  const state = loadState();
  renderAll(state);

  document.querySelectorAll('.log-form').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();

      const weight = Number(form.elements.weight.value) || 0;
      const reps = Number(form.elements.reps.value);
      const sets = Number(form.elements.sets.value) || 1;

      if (!reps || reps <= 0) {
        form.elements.reps.focus();
        return;
      }

      state.logs.push({
        exerciseId: form.dataset.exerciseId,
        date: todayKey(),
        ts: Date.now(),
        weight,
        reps,
        sets,
      });

      saveState(state);
      renderAll(state);
      form.reset();
      form.elements.sets.value = sets;
    });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
