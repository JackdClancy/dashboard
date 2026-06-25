// Server-side proxy for the Hevy API.
// Same reasoning as api/akahu.js: third-party APIs that require an API key
// generally don't allow direct browser-to-browser CORS requests, so this
// function makes the request server-side and relays the result back.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { apiKey } = req.body || {};
  if (!apiKey) {
    return res.status(400).json({ error: 'Missing apiKey' });
  }

  try {
    const r = await fetch('https://api.hevyapp.com/v1/workouts?page=1&pageSize=10', {
      headers: { 'api-key': apiKey },
    });

    if (!r.ok) {
      const body = await r.text();
      return res.status(r.status).json({ error: `Hevy API error: ${r.status} ${body}` });
    }

    const data = await r.json();

    // Reduce each workout to just what the client needs, including total
    // volume (kg) computed from every set's weight_kg * reps.
    const workouts = (data.workouts || []).map(w => {
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
