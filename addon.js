```javascript
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 7000;
const SUBREDDIT_URL = 'https://www.reddit.com/r/movieleaks/new.json';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/catalog/movie/top';
const OMDB_API_KEY = 'a8924bd9'; 
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000; 

const manifest = {
    id: 'org.reddit.movieleaks.v6', 
    version: '6.0.2',
    name: 'Reddit Movie Leaks (with Scores)',
    description: 'Scrapes r/MovieLeaks. STRICT TOMATOMETER SCORES.',
    idPrefixes: ['tt', 'leaks'], 
    resources: ['catalog', 'meta'],
    types: ['movie'],
    catalogs: [
        {
            type: 'movie',
            id: 'movieleaks_long',
            name: 'Movie Leaks',
            extra: [{ name: 'skip' }]
        }
    ]
};

const builder = new addonBuilder(manifest);
let movieCatalog = [];
let lastStatus = "Initializing...";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- 1. OMDB Fetcher ---
async function fetchScoresFromOmdb(imdbId) {
    if (!imdbId) return null;
    try {
        const url = `http://www.omdbapi.com/?apikey=${OMDB_API_KEY}&i=${imdbId}`;
        const { data } = await axios.get(url);

        if (data && data.Response === 'True' && data.Ratings) {
            const rt = data.Ratings.find(r => r.Source === "Rotten Tomatoes");
            if (rt) return rt.Value;
        }
    } catch (e) {
        return null;
    }
    return null;
}

// --- 2. RT Direct Fetcher (STRICT) ---
async function fetchRottenTomatoesFallback(title, year) {
    try {
        const query = year ? `${title} ${year}` : title;
        const url = `https://www.rottentomatoes.com/search?search=${encodeURIComponent(query)}`;
        const { data } = await axios.get(url, { headers: { 'User-Agent': USER_AGENT } });

        const matches = [...data.matchAll(/<search-page-media-row([^>]+)>/g)];
        
        for (const match of matches) {
            const attrs = match[1];
            const isMovie = attrs.includes('type="movie"');
            const scoreMatch = attrs.match(/tomatometerscore\s*=\s*["'](\d+)["']/i);
            const yearMatch = attrs.match(/releaseyear\s*=\s*["'](\d{4})["']/i);
            
            if (isMovie && scoreMatch) {
                const score = scoreMatch[1];
                const rtYear = yearMatch ? yearMatch[1] : null;

                if (year && rtYear) {
                    if (Math.abs(parseInt(year) - parseInt(rtYear)) <= 1) return `${score}%`;
                } else if (!year) {
                    return `${score}%`;
                }
            }
        }
    } catch (e) { return null; }
    return null;
}

function parseTitle(rawTitle) {
    const yearMatch = rawTitle.match(/(19|20)\d{2}/);
    if (yearMatch) {
        const yearIndex = yearMatch.index;
        let title = rawTitle.substring(0, yearIndex).trim();
        title = title.replace(/[\._\(\)\[\]\-]/g, ' ').replace(/\s+/g, ' ').trim();
        return { title: title, year: yearMatch[0] };
    }
    let title = rawTitle.replace(/[\._\(\)\[\]\-]/g, ' ').replace(/\s+/g, ' ').trim();
    return { title: title, year: null };
}

async function resolveToImdb(title, year) {
    try {
        const query = year ? `${title} ${year}` : title;
        const url = `${CINEMETA_URL}/search=${encodeURIComponent(query)}.json`;
        const { data } = await axios.get(url);
        if (data && data.metas && data.metas.length > 0) return data.metas[0];
    } catch (e) { return null; }
    return null;
}

async function updateCatalog() {
    console.log('--- STARTING SCRAPE ---');
    lastStatus = "Scraping Reddit...";
    let allPosts = [];
    let afterToken = null;
    let keepFetching = true;
    const cutoffDateSeconds = Math.floor((Date.now() - MAX_AGE_MS) / 1000);

    try {
        while (keepFetching) {
            const url = `${SUBREDDIT_URL}?limit=100&after=${afterToken || ''}`;
            const response = await axios.get(url, { headers: { 'User-Agent': USER_AGENT } });
            const children = response.data.data.children;
            if (children.length === 0) break;

            for (const child of children) {
                const p = child.data;
                if (p.created_utc < cutoffDateSeconds) {
                    keepFetching = false;
                    break; 
                }
                allPosts.push(p);
            }
            afterToken = response.data.data.after;
            if (!afterToken) break;
            await delay(1500); 
        }

        const newCatalog = [];
        for (const p of allPosts) {
            const parsed = parseTitle(p.title);
            const imdbItem = await resolveToImdb(parsed.title, parsed.year);
            const actualYear = parsed.year || (imdbItem && imdbItem.releaseInfo ? imdbItem.releaseInfo.substring(0,4) : null);

            let rtScore = imdbItem ? await fetchScoresFromOmdb(imdbItem.id) : null;
            if (!rtScore) rtScore = await fetchRottenTomatoesFallback(parsed.title, actualYear);

            const scorePrefix = rtScore ? `🍅 ${rtScore} ` : '';
            const scoreDesc = rtScore ? `⭐️ ROTTEN TOMATOES: ${rtScore} ⭐️\n\n` : '';
            const genres = rtScore ? [`RT: ${rtScore}`, 'Movie Leaks'] : ['Movie Leaks'];

            if (imdbItem) {
                newCatalog.push({
                    id: imdbItem.id,
                    type: 'movie',
                    name: `${scorePrefix}${imdbItem.name}`,
                    poster: `https://images.metahub.space/poster/medium/${imdbItem.id}/img`,
                    description: `${scoreDesc}${imdbItem.description || ''}`,
                    releaseInfo: imdbItem.releaseInfo,
                    genres: genres 
                });
            } else {
                newCatalog.push({
                    id: `leaks_${p.id}`,
                    type: 'movie',
                    name: `${scorePrefix}${parsed.title}`,
                    poster: null, 
                    description: `${scoreDesc}Unmatched Release: ${p.title}`,
                    releaseInfo: parsed.year || '????',
                    genres: genres
                });
            }
            await delay(50);
        }

        const seenIds = new Set();
        movieCatalog = newCatalog.filter(item => {
            const duplicate = seenIds.has(item.id);
            seenIds.add(item.id);
            return !duplicate;
        });

        lastStatus = "Ready";
        console.log(`Update Complete. Catalog size: ${movieCatalog.length}`);
    } catch (error) {
        lastStatus = `Error: ${error.message}`;
    }
}

builder.defineCatalogHandler(async ({ type, id, extra }) => {
    if (movieCatalog.length === 0) {
        return { metas: [{ id: 'tt_status', type: 'movie', name: `Status: ${lastStatus}`, description: "Wait for fetch...", poster: 'https://via.placeholder.com/300x450.png?text=Loading...' }] };
    }
    if (type === 'movie' && id === 'movieleaks_long') {
        const skip = extra.skip ? parseInt(extra.skip) : 0;
        return { metas: movieCatalog.slice(skip, skip + 100) };
    }
    return { metas: [] };
});

builder.defineMetaHandler(({ type, id }) => {
    const item = movieCatalog.find(i => i.id === id);
    return item ? { meta: item } : { meta: null };
});

serveHTTP(builder.getInterface(), { port: PORT });
updateCatalog();
setInterval(updateCatalog, 60 * 60 * 1000);


```
