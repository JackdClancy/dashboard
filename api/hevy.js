// Server-side proxy for the Hevy API.
// Same reasoning as api/akahu.js: third-party APIs that require an API key
// generally don't allow direct browser-to-browser CORS requests, so this
// function makes the request server-side and relays the result back.
//
// Body: { apiKey, since?, muscleSince? }
//   since       — ISO date; return every workout from then on (else latest 10)
//   muscleSince — ISO date; also return `muscleGroups`, the share of sets per
//                 muscle over workouts from that date. Lets the Gym page get
//                 its week, month and muscle split from one Hevy pass instead
//                 of three (this replaced the separate /api/hevy-muscles).

import { fetchWorkouts, muscleSplit, startOf } from './_hevy.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { apiKey, since, muscleSince } = req.body || {};
  if (!apiKey) {
    return res.status(400).json({ error: 'Missing apiKey' });
  }

  try {
    // One fetch covers both ranges; with muscleSince alone that still means
    // paging back far enough (not just the latest 10).
    const from = since && muscleSince
      ? (new Date(since) < new Date(muscleSince) ? since : muscleSince)
      : since || muscleSince;
    const fetched = await fetchWorkouts(apiKey, from);
    // `workouts` keeps its old meaning: everything since `since`, else the latest 10.
    const rawWorkouts = since
      ? fetched.filter(w => startOf(w) >= new Date(since).getTime())
      : fetched.slice(0, 10);

    // Reduce each workout to just what the client needs, including total
    // volume (kg) computed from every set's weight_kg * reps.
    const workouts = rawWorkouts.map(w => {
      let volumeKg = 0;
      (w.exercises || []).forEach(ex => {
        (ex.sets || []).forEach(s => {
          if (typeof s.weight_kg === 'number' && typeof s.reps === 'number') {
            volumeKg += s.weight_kg * s.reps;
          }
        });
      });
      return {
        title: w.title,
        start_time: w.start_time,
        end_time: w.end_time,
        created_at: w.created_at,
        volume_kg: Math.round(volumeKg * 10) / 10,
      };
    });

    const body = { workouts };
    if (muscleSince) {
      const muscleFrom = new Date(muscleSince).getTime();
      body.muscleGroups = await muscleSplit(apiKey, fetched.filter(w => startOf(w) >= muscleFrom));
    }
    return res.status(200).json(body);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
}
