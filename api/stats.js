// Vercel function: GET /api/stats -> { views: { happiest: 123, myfriend: 456, n1999: 789, child: 12 } }
// Setup: add YT_API_KEY (YouTube Data API v3 key) in Vercel > Settings > Environment Variables,
// then paste each song's YouTube video ID below (the part after v= or youtu.be/). Songs left empty are skipped.
const YT = { happiest: '7aIOY0UZXTA', myfriend: '', n1999: '', child: '' };

export default async function handler(req, res) {
  const key = process.env.YT_API_KEY;
  const pairs = Object.entries(YT).filter(([, id]) => id);
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
  if (!key || !pairs.length) return res.status(200).json({ views: {} });
  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${pairs.map(([, id]) => id).join(',')}&key=${key}`;
    const j = await (await fetch(url)).json();
    const byId = Object.fromEntries((j.items || []).map((i) => [i.id, Number(i.statistics.viewCount)]));
    const views = {};
    for (const [song, id] of pairs) if (byId[id] != null) views[song] = byId[id];
    res.status(200).json({ views });
  } catch (e) {
    res.status(200).json({ views: {} });
  }
}
