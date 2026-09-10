const DB_NAME = 'championDB';
const DB_VERSION = 1;
const STORE_NAME = 'logs';
const LEGACY_STORAGE_KEY = 'championLog.v1';
const PHOTO_MAX_DIMENSION = 480;
const PHOTO_QUALITY = 0.72;
const PHOTO_BUCKET = 'champion-photos';
const SIGNED_URL_TTL_SECONDS = 60 * 60;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getAllLogs(db) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function putLog(db, entry) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function migrateLegacyLocalStorage(db) {
  let legacy;
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    legacy = raw ? JSON.parse(raw) : null;
  } catch {
    legacy = null;
  }
  if (!legacy || !Array.isArray(legacy.logs) || !legacy.logs.length) return;

  for (const log of legacy.logs) {
    await putLog(db, { photo: null, synced: false, ...log, id: crypto.randomUUID() });
  }
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Ignore — worst case the legacy key lingers unused.
  }
}

function compressImage(file, maxDim = PHOTO_MAX_DIMENSION, quality = PHOTO_QUALITY) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const width = Math.round(img.width * scale);
      const height = Math.round(img.height * scale);

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);

      URL.revokeObjectURL(objectUrl);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };

    img.onerror = (event) => {
      URL.revokeObjectURL(objectUrl);
      reject(event);
    };

    img.src = objectUrl;
  });
}

// Loaded lazily via dynamic import so a blocked/slow CDN or Supabase outage
// can never break the local-only features (IndexedDB logging, streaks,
// stats) — those have zero static dependency on this module.
let cloudContextPromise = null;

function getCloudContext() {
  if (!cloudContextPromise) {
    cloudContextPromise = (async () => {
      const { supabase, ensureAnonymousSession } = await import('./supabase-client.js');
      const session = await ensureAnonymousSession();
      return { supabase, userId: session.user.id };
    })();
  }
  return cloudContextPromise;
}

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
}

async function syncLogToSupabase(supabase, userId, log) {
  const photoPath = `${userId}/${log.id}.jpg`;
  const blob = await dataUrlToBlob(log.photo);

  const { error: uploadError } = await supabase.storage
    .from(PHOTO_BUCKET)
    .upload(photoPath, blob, { contentType: 'image/jpeg', upsert: true });
  if (uploadError) throw uploadError;

  const { error: insertError } = await supabase.from('champion_logs').insert({
    id: log.id,
    exercise_id: log.exerciseId,
    log_date: log.date,
    weight: log.weight,
    reps: log.reps,
    sets: log.sets,
    photo_path: photoPath,
  });
  // Postgres unique_violation — this row already synced from an earlier attempt.
  if (insertError && insertError.code !== '23505') throw insertError;
}

async function pullRemoteLogs(supabase, db, localIds) {
  const { data, error } = await supabase
    .from('champion_logs')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw error;

  const pulled = [];
  for (const row of data) {
    if (localIds.has(row.id)) continue;

    const { data: signed } = await supabase.storage
      .from(PHOTO_BUCKET)
      .createSignedUrl(row.photo_path, SIGNED_URL_TTL_SECONDS);

    const entry = {
      id: row.id,
      exerciseId: row.exercise_id,
      date: row.log_date,
      ts: new Date(row.created_at).getTime(),
      weight: Number(row.weight),
      reps: row.reps,
      sets: row.sets,
      photo: signed?.signedUrl ?? null,
      synced: true,
    };
    await putLog(db, entry);
    pulled.push(entry);
  }
  return pulled;
}

async function syncPendingLocalLogs(supabase, db, userId, logs) {
  const pending = logs.filter((log) => log.synced !== true && log.photo);
  for (const log of pending) {
    try {
      await syncLogToSupabase(supabase, userId, log);
      log.synced = true;
      await putLog(db, log);
    } catch (error) {
      console.warn('[progress] Sync failed for log', log.id, error);
    }
  }
}

function updateSyncBadge(state) {
  const badge = document.getElementById('sync-badge');
  if (!badge) return;

  const labels = {
    syncing: '☁️ Syncing…',
    synced: '☁️ Backed up',
    offline: '⚠️ Not backed up (saved on this device only)',
  };
  badge.textContent = labels[state] ?? '';
  badge.dataset.syncState = state;
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

function renderCommitmentBar(logs) {
  const bar = document.querySelector('.commitment-bar');
  if (!bar) return;

  const { current } = computeStreaks(logs);
  const trainedToday = logs.some((log) => log.date === todayKey());

  bar.querySelector('.commitment-streak-value').textContent = current;
  const status = bar.querySelector('.commitment-status');
  status.dataset.status = trainedToday ? 'trained' : 'pending';
  status.textContent = trainedToday ? '✅ Trained today' : '⚠️ No training logged today';
}

function renderStatTiles(logs) {
  const { current, best } = computeStreaks(logs);
  const totalSessions = new Set(logs.map((log) => log.date)).size;
  const lastDate = logs.length ? logs.map((log) => log.date).sort().at(-1) : null;

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

function renderExerciseLastLogs(logs) {
  document.querySelectorAll('[data-exercise-last-log]').forEach((el) => {
    const exerciseId = el.dataset.exerciseLastLog;
    const lastForExercise = logs
      .filter((log) => log.exerciseId === exerciseId)
      .sort((a, b) => a.ts - b.ts)
      .at(-1);

    if (!lastForExercise) {
      el.innerHTML = 'Not logged yet';
      el.dataset.hasLog = 'false';
      return;
    }

    const thumb = lastForExercise.photo
      ? `<img class="last-log-thumb" src="${lastForExercise.photo}" alt="Your proof photo from this exercise's last logged set" />`
      : '';
    el.innerHTML = `${thumb}<span>Last: ${formatLog(lastForExercise)} — ${relativeDay(lastForExercise.date)}</span>`;
    el.dataset.hasLog = 'true';
  });
}

function renderActivityList(logs) {
  const list = document.getElementById('activity-list');
  if (!list) return;

  const recent = [...logs].sort((a, b) => b.ts - a.ts).slice(0, 10);

  if (!recent.length) {
    list.innerHTML = '<li class="activity-empty">No sets logged yet — your first entry starts the streak.</li>';
    return;
  }

  list.innerHTML = recent
    .map((log) => {
      const name = document.querySelector(`[data-exercise-id="${log.exerciseId}"] h2`)?.textContent ?? log.exerciseId;
      const thumb = log.photo ? `<img class="activity-thumb" src="${log.photo}" alt="" />` : '';
      return `<li class="activity-row">
        ${thumb}
        <div class="activity-row-text">
          <span class="activity-row-exercise">${name}</span>
          <span class="activity-row-meta">${formatLog(log)} · ${relativeDay(log.date)}</span>
        </div>
      </li>`;
    })
    .join('');
}

function renderAll(logs) {
  renderCommitmentBar(logs);
  renderStatTiles(logs);
  renderExerciseLastLogs(logs);
  renderActivityList(logs);
}

function clearPhotoPreview(form) {
  const preview = form.querySelector('.log-photo-preview');
  if (!preview) return;
  if (preview.dataset.blobUrl) URL.revokeObjectURL(preview.dataset.blobUrl);
  preview.hidden = true;
  preview.removeAttribute('src');
  delete preview.dataset.blobUrl;
}

function wirePhotoPreview(form) {
  const input = form.querySelector('input[type="file"]');
  const preview = form.querySelector('.log-photo-preview');
  if (!input || !preview) return;

  input.addEventListener('change', () => {
    const file = input.files[0];
    if (preview.dataset.blobUrl) URL.revokeObjectURL(preview.dataset.blobUrl);

    if (!file) {
      preview.hidden = true;
      delete preview.dataset.blobUrl;
      return;
    }

    const url = URL.createObjectURL(file);
    preview.src = url;
    preview.dataset.blobUrl = url;
    preview.hidden = false;
  });
}

function wireLogForm(form, db, logs) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const weight = Number(form.elements.weight.value) || 0;
    const reps = Number(form.elements.reps.value);
    const sets = Number(form.elements.sets.value) || 1;
    const photoFile = form.elements.photo?.files?.[0];

    if (!reps || reps <= 0) {
      form.elements.reps.focus();
      return;
    }
    if (!photoFile) {
      form.elements.photo.reportValidity();
      return;
    }

    const submitButton = form.querySelector('.log-submit');
    const originalLabel = submitButton.textContent;
    submitButton.disabled = true;
    submitButton.textContent = 'Saving…';

    try {
      const photo = await compressImage(photoFile);
      const entry = {
        id: crypto.randomUUID(),
        exerciseId: form.dataset.exerciseId,
        date: todayKey(),
        ts: Date.now(),
        weight,
        reps,
        sets,
        photo,
        synced: false,
      };

      await putLog(db, entry);
      logs.push(entry);
      renderAll(logs);
      form.reset();
      form.elements.sets.value = sets;
      clearPhotoPreview(form);

      // Background cloud backup — local save already succeeded, so this
      // never blocks the visible "Log Set" flow. Failures retry next load.
      getCloudContext()
        .then(({ supabase, userId }) => syncLogToSupabase(supabase, userId, entry))
        .then(() => {
          entry.synced = true;
          return putLog(db, entry);
        })
        .catch((error) => {
          console.warn('[progress] Background sync failed for this set, will retry next load:', error);
        });
    } catch (error) {
      console.error('[progress] Failed to save logged set:', error);
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = originalLabel;
    }
  });
}

async function init() {
  const db = await openDatabase();
  await migrateLegacyLocalStorage(db);
  const logs = await getAllLogs(db);

  renderAll(logs);
  updateSyncBadge('syncing');

  document.querySelectorAll('.log-form').forEach((form) => {
    wirePhotoPreview(form);
    wireLogForm(form, db, logs);
  });

  try {
    const { supabase, userId } = await getCloudContext();
    const localIds = new Set(logs.map((log) => log.id));
    const pulled = await pullRemoteLogs(supabase, db, localIds);
    if (pulled.length) {
      logs.push(...pulled);
      renderAll(logs);
    }

    await syncPendingLocalLogs(supabase, db, userId, logs);
    updateSyncBadge('synced');
  } catch (error) {
    console.warn('[progress] Cloud sync unavailable — your data is still saved on this device:', error);
    updateSyncBadge('offline');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
