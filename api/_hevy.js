// Shared Hevy access for the /api functions. Vercel doesn't route files whose
// name starts with an underscore, so this is a module, not an endpoint.

const BASE = 'https://api.hevyapp.com/v1';

// Hevy returns workouts newest-first and caps pageSize at 10, so to cover a
// date range we page until we pass `since`. With no `since`, just the latest
// page. MAX_PAGES bounds a long history so the function can't hang.
export async function fetchWorkouts(apiKey, since) {
  const headers = { 'api-key': apiKey };
  if (!since) {
    const r = await fetch(`${BASE}/workouts?page=1&pageSize=10`, { headers });
    if (!r.ok) throw await hevyError(r);
    return (await r.json()).workouts || [];
  }

  const sinceTime = new Date(since).getTime();
  const MAX_PAGES = 10;
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await fetch(`${BASE}/workouts?page=${page}&pageSize=10`, { headers });
    if (r.status === 404) break; // ran out of pages - not an error
    if (!r.ok) throw await hevyError(r);
    const workouts = (await r.json()).workouts || [];
    if (workouts.length === 0) break;
    all.push(...workouts);
    if (startOf(workouts[workouts.length - 1]) < sinceTime) break;
  }
  return all.filter(w => startOf(w) >= sinceTime);
}

export const startOf = w => new Date(w.start_time || w.created_at).getTime();

async function hevyError(r) {
  const err = new Error(`Hevy API error: ${r.status} ${await r.text()}`);
  err.status = r.status;
  return err;
}

// Exercise template id → primary muscle group. Hevy doesn't tag muscles on
// workouts — only on the separate templates endpoint. Best-effort cache across
// warm invocations; templates rarely change.
let templateCache = null; // { byId, fetchedAt }
const CACHE_TTL_MS = 60 * 60 * 1000;

async function fetchMuscleByTemplate(apiKey) {
  if (templateCache && Date.now() - templateCache.fetchedAt < CACHE_TTL_MS) {
    return templateCache.byId;
  }
  // This endpoint allows pageSize up to 100 (workouts only allow 10) — the old
  // pageSize=10 meant ~50 sequential requests on every cold start.
  const byId = {};
  let complete = false;
  for (let page = 1; page <= 20; page++) {
    const r = await fetch(`${BASE}/exercise_templates?page=${page}&pageSize=100`, {
      headers: { 'api-key': apiKey },
    });
    if (r.status === 404) { complete = true; break; }
    if (!r.ok) break; // don't fail the whole request just because templates errored
    const data = await r.json();
    const templates = data.exercise_templates || [];
    templates.forEach(t => { byId[t.id] = t.primary_muscle_group; });
    if (templates.length === 0 || page >= (data.page_count || Infinity)) { complete = true; break; }
  }
  // Only cache a full set — caching a partial one would show "Unknown" muscles
  // for an hour after a single transient error.
  if (complete) templateCache = { byId, fetchedAt: Date.now() };
  return byId;
}

// Each muscle group's share of total sets across `workouts`.
export async function muscleSplit(apiKey, workouts) {
  const setsByTemplate = {};
  for (const w of workouts) {
    for (const ex of w.exercises || []) {
      if (!ex.exercise_template_id) continue;
      setsByTemplate[ex.exercise_template_id] =
        (setsByTemplate[ex.exercise_template_id] || 0) + (ex.sets || []).length;
    }
  }
  if (Object.keys(setsByTemplate).length === 0) return [];

  const muscleById = await fetchMuscleByTemplate(apiKey);
  const totals = {};
  let totalSets = 0;
  for (const [id, count] of Object.entries(setsByTemplate)) {
    const muscle = muscleById[id] || 'Unknown';
    totals[muscle] = (totals[muscle] || 0) + count;
    totalSets += count;
  }
  return Object.entries(totals)
    .map(([muscle, sets]) => ({ muscle, sets, pct: Math.round((sets / totalSets) * 1000) / 10 }))
    .sort((a, b) => b.sets - a.sets);
}
