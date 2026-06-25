// Server-side proxy that computes a muscle-group breakdown for a date
// range. Hevy doesn't tag muscle groups on workouts/exercises directly -
// each exercise only has an exercise_template_id, and the muscle group
// lives on the separate Exercise Templates endpoint. This function:
//   1. Pages through workouts since the given date (same approach as
//      api/hevy.js) and counts sets per exercise_template_id.
//   2. Pages through Hevy's exercise templates to resolve each
//      template_id to a primary_muscle_group.
//   3. Returns each muscle group's share of total sets.

export const config = { maxDuration: 30 };

// Best-effort cache across warm invocations - not guaranteed to persist,
// but exercise templates rarely change so it's free when it does.
let templateCache = null; // { byId: {...}, fetchedAt: number }
const CACHE_TTL_MS = 60 * 60 * 1000;

async function fetchAllTemplates(apiKey) {
  const now = Date.now();
  if (templateCache && (now - templateCache.fetchedAt) < CACHE_TTL_MS) {
    return templateCache.byId;
  }

  const byId = {};
  const MAX_PAGES = 60;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await fetch(`https://api.hevyapp.com/v1/exercise_templates?page=${page}&pageSize=10`, {
      headers: { 'api-key': apiKey },
    });
    if (r.status === 404) break;
    if (!r.ok) break; // don't fail the whole request just because templates errored
    const data = await r.json();
    const templates = data.exercise_templates || [];
    if (templates.length === 0) break;
    templates.forEach(t => { byId[t.id] = t.primary_muscle_group; });
  }

  templateCache = { byId, fetchedAt: now };
  return byId;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { apiKey, since } = req.body || {};
  if (!apiKey) return res.status(400).json({ error: 'Missing apiKey' });
  if (!since) return res.status(400).json({ error: 'Missing since' });

  try {
    const sinceTime = new Date(since).getTime();
    let rawWorkouts = [];
    const MAX_WORKOUT_PAGES = 10;
    for (let page = 1; page <= MAX_WORKOUT_PAGES; page++) {
      const r = await fetch(`https://api.hevyapp.com/v1/workouts?page=${page}&pageSize=10`, {
        headers: { 'api-key': apiKey },
      });
      if (r.status === 404) break;
      if (!r.ok) {
        const body = await r.text();
        return res.status(r.status).json({ error: `Hevy API error: ${r.status} ${body}` });
      }
      const pageData = await r.json();
      const pageWorkouts = pageData.workouts || [];
      if (pageWorkouts.length === 0) break;
      rawWorkouts.push(...pageWorkouts);
      const oldest = pageWorkouts[pageWorkouts.length - 1];
      const oldestTime = new Date(oldest.start_time || oldest.created_at).getTime();
      if (oldestTime < sinceTime) break;
    }
    rawWorkouts = rawWorkouts.filter(w => {
      const t = new Date(w.start_time || w.created_at).getTime();
      return t >= sinceTime;
    });

    // Count sets per exercise_template_id.
    const setsByTemplateId = {};
    rawWorkouts.forEach(w => {
      (w.exercises || []).forEach(ex => {
        const id = ex.exercise_template_id;
        if (!id) return;
        const setCount = (ex.sets || []).length;
        setsByTemplateId[id] = (setsByTemplateId[id] || 0) + setCount;
      });
    });

    if (Object.keys(setsByTemplateId).length === 0) {
      return res.status(200).json({ muscleGroups: [] });
    }

    const muscleById = await fetchAllTemplates(apiKey);

    const totals = {};
    let totalSets = 0;
    Object.entries(setsByTemplateId).forEach(([id, count]) => {
      const muscle = muscleById[id] || 'Unknown';
      totals[muscle] = (totals[muscle] || 0) + count;
      totalSets += count;
    });

    const muscleGroups = Object.entries(totals)
      .map(([muscle, sets]) => ({
        muscle,
        sets,
        pct: totalSets > 0 ? Math.round((sets / totalSets) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.sets - a.sets);

    return res.status(200).json({ muscleGroups });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
