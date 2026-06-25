// Server-side proxy for the Hevy API.
// Same reasoning as api/akahu.js: third-party APIs that require an API key
// generally don't allow direct browser-to-browser CORS requests, so this
// function makes the request server-side and relays the result back.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { apiKey, since } = req.body || {};
  if (!apiKey) {
    return res.status(400).json({ error: 'Missing apiKey' });
  }

  try {
    let rawWorkouts = [];

    if (since) {
      // Hevy returns newest-first and caps pageSize at 10, so to cover a
      // full month we page through until we pass the requested date.
      const sinceTime = new Date(since).getTime();
      const MAX_PAGES = 10;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const r = await fetch(`https://api.hevyapp.com/v1/workouts?page=${page}&pageSize=10`, {
          headers: { 'api-key': apiKey },
        });
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
    } else {
      const r = await fetch('https://api.hevyapp.com/v1/workouts?page=1&pageSize=10', {
        headers: { 'api-key': apiKey },
      });
      if (!r.ok) {
        const body = await r.text();
        return res.status(r.status).json({ error: `Hevy API error: ${r.status} ${body}` });
      }
      const data = await r.json();
      rawWorkouts = data.workouts || [];
    }

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
        created_at: w.created_at,
        volume_kg: Math.round(volumeKg * 10) / 10,
      };
    });

    return res.status(200).json({ workouts });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
