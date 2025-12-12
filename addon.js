const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 7000;
const SUBREDDIT_URL = 'https://www.reddit.com/r/movieleaks/new.json';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/catalog/movie/top';
const OMDB_API_KEY = 'a8924bd9'; 
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 60 days in milliseconds
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000; 

const manifest = {
    id: 'org.reddit.movieleaks.v5',
    version: '5.0.7', // Bumped version
    name: 'Reddit Movie Leaks (2 Months)',
    description: 'Scrapes r/MovieLeaks with OMDB/RT Scores.',
    // KEY FIX: Claiming 'tt' prefixes tells Stremio to check us for metadata on IMDb IDs
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

// --- 1. OMDB Fetcher (Primary & Reliable) ---
async function fetchScoresFromOmdb(imdbId) {
    if (!imdbId) return null;
    try {
        const url = `http://www.omdbapi.com/?apikey=${OMDB_API_KEY}&i=${imdbId}`;
        const { data } = await axios.get(url);

        if (data && data.Response === 'True' && data.Ratings) {
            const rt = data.Ratings.find(r => r.Source === "Rotten Tomatoes");
            if (rt) {
                console.log(`> 🍅 OMDB Hit for ${imdbId}: ${rt.Value}`);
                return rt.Value;
            }
        }
    } catch (e) {
        // console.log(`! OMDB Error: ${e.message}`);
    }
    return null;
}

// --- 2. RT Direct Fetcher (Fallback) ---
async function fetchRottenTomatoesFallback(title, year) {
    try {
        const query = year ? `${title} ${year}` : title;
        const url = `https://www.rottentomatoes.com/search?search=${encodeURIComponent(query)}`;
        const { data } = await axios.get(url, { 
            headers: { 'User-Agent': USER_AGENT } 
        });

        const scoreMatch = data.match(/tomatometerscore="(\d+)"/i);
        if (scoreMatch && scoreMatch[1]) {
            console.log(`> 🍅 Scrape Hit for "${title}": ${scoreMatch[1]}%`);
            return `${scoreMatch[1]}%`;
        }
    } catch (e) {
        // console.log(`! RT Scrape Error: ${e.message}`);
    }
    return null;
}

function parseTitle(rawTitle) {
    const regex = /^(.+?)[\.\s\(]+(\d{4})[\.\s\)]+/;
    const match = rawTitle.match(regex);
    if (match) {
        return {
            title: match[1].replace(/\./g, ' ').trim(),
            year: match[2]
        };
    }
    return { title: rawTitle, year: null };
}

async function resolveToImdb(title, year) {
    if (!year) return null;
    try {
        const query = `${title} ${year}`;
        const url = `${CINEMETA_URL}/search=${encodeURIComponent(query)}.json`;
        const { data } = await axios.get(url);
        if (data && data.metas && data.metas.length > 0) {
            return data.metas[0];
        }
    } catch (e) {
        return null;
    }
    return null;
}

async function updateCatalog() {
    console.log('--- STARTING SCRAPE ---');
    lastStatus = "Scraping Reddit...";
    
    let allPosts = [];
    let afterToken = null;
    let keepFetching = true;
    let page = 1;
    const cutoffDateSeconds = Math.floor((Date.now() - MAX_AGE_MS) / 1000);

    try {
        while (keepFetching) {
            console.log(`> Fetching Page ${page}...`);
            const url = `${SUBREDDIT_URL}?limit=100&after=${afterToken || ''}`;
            const response = await axios.get(url, { headers: { 'User-Agent': USER_AGENT } });
            const children = response.data.data.children;
            
            if (children.length === 0) { keepFetching = false; break; }

            for (const child of children) {
                const p = child.data;
                if (p.created_utc < cutoffDateSeconds) {
                    keepFetching = false;
                    break; 
                }
                allPosts.push(p);
            }
            afterToken = response.data.data.after;
            if (!afterToken) keepFetching = false;
            page++;
            if (keepFetching) await delay(1500); 
        }

        console.log(`> Found ${allPosts.length} posts. Processing...`);
        lastStatus = `Processing ${allPosts.length} items...`;
        const newCatalog = [];

        for (const p of allPosts) {
            const parsed = parseTitle(p.title);
            
            // 1. Resolve to IMDb ID (Cinemeta)
            const imdbItem = await resolveToImdb(parsed.title, parsed.year);
            
            let rtScore = null;
            if (imdbItem) {
                rtScore = await fetchScoresFromOmdb(imdbItem.id);
            }
            if (!rtScore) {
                rtScore = await fetchRottenTomatoesFallback(parsed.title, parsed.year);
            }

            const scorePrefix = rtScore ? `🍅 ${rtScore} ` : '';
            // Make the score very obvious in the description
            const scoreDesc = rtScore ? `⭐️ ROTTEN TOMATOES: ${rtScore} ⭐️\n\n` : '';

            if (imdbItem) {
                newCatalog.push({
                    id: imdbItem.id,
                    type: 'movie',
                    name: `${scorePrefix}${imdbItem.name}`,
                    poster: `https://images.metahub.space/poster/medium/${imdbItem.id}/img`,
                    description: `${scoreDesc}${imdbItem.description || ''}`,
                    releaseInfo: imdbItem.releaseInfo
                });
            } else {
                newCatalog.push({
                    id: `leaks_${p.id}`,
                    type: 'movie',
                    name: `${scorePrefix}${parsed.title}`,
                    poster: null, 
                    description: `${scoreDesc}Unmatched Release: ${p.title}`,
                    releaseInfo: parsed.year || '????'
                });
            }
            await delay(50);
        }

        const uniqueCatalog = [];
        const seenIds = new Set();
        for (const item of newCatalog) {
            if (!seenIds.has(item.id)) {
                seenIds.add(item.id);
                uniqueCatalog.push(item);
            }
        }

        movieCatalog = uniqueCatalog;
        lastStatus = "Ready";
        console.log(`> Update Complete. Catalog size: ${movieCatalog.length}`);

    } catch (error) {
        console.error('! Error:', error.message);
        lastStatus = `Error: ${error.message}`;
    }
}

// --- Handlers ---

builder.defineCatalogHandler(async ({ type, id, extra }) => {
    if (movieCatalog.length === 0) {
        return {
            metas: [{
                id: 'tt_status',
                type: 'movie',
                name: `Status: ${lastStatus}`,
                description: "Fetching data...",
                poster: 'https://via.placeholder.com/300x450.png?text=Loading...',
            }]
        };
    }
    if (type === 'movie' && id === 'movieleaks_long') {
        const skip = extra.skip ? parseInt(extra.skip) : 0;
        return { metas: movieCatalog.slice(skip, skip + 100) };
    }
    return { metas: [] };
});

// IMPORTANT: Returns custom metadata (with score) even for IMDb IDs
builder.defineMetaHandler(({ type, id }) => {
    const item = movieCatalog.find(i => i.id === id);
    if (item) {
        return { meta: item };
    }
    // If not in our list, return null so Stremio asks the next addon (Cinemeta)
    return { meta: null };
});

serveHTTP(builder.getInterface(), { port: PORT });
updateCatalog();
setInterval(updateCatalog, 60 * 60 * 1000); 
console.log(`Addon running on http://localhost:${PORT}`);
