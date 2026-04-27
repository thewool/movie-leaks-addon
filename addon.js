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
    id: 'org.reddit.movieleaks.v6', 
    version: '6.0.6', // Bumped version to force Stremio update
    name: 'Reddit Movie Leaks (Titles)',
    description: 'Scrapes r/MovieLeaks. Scores strictly enforced in titles.',
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

// --- 1. RT Direct Fetcher (PRIMARY - Source of Truth) ---
async function fetchRottenTomatoesPrimary(title, year) {
    try {
        const query = year ? `${title} ${year}` : title;
        const url = `https://www.rottentomatoes.com/search?search=${encodeURIComponent(query)}`;
        const { data } = await axios.get(url, { 
            headers: { 'User-Agent': USER_AGENT },
            timeout: 5000 // Prevent hanging
        });

        const matches = [...data.matchAll(/<search-page-media-row([^>]+)>/g)];
        const cleanTarget = title.toLowerCase().replace(/[^a-z0-9]/g, '');
        
        for (const match of matches) {
            const attrs = match[1];
            
            const isMovie = attrs.includes('data-type="movie"') || attrs.includes('type="movie"');
            const scoreMatch = attrs.match(/tomatometerscore\s*=\s*["'](\d+)["']/i); 
            const yearMatch = attrs.match(/releaseyear\s*=\s*["'](\d{4})["']/i);
            const nameMatch = attrs.match(/name\s*=\s*["']([^"']+)["']/i);
            
            if (isMovie && scoreMatch && nameMatch) {
                const score = scoreMatch[1];
                const rtYear = yearMatch ? yearMatch[1] : null;
                const rtNameRaw = nameMatch[1].replace(/&#[0-9]+;/g, ' ').trim();
                const cleanResult = rtNameRaw.toLowerCase().replace(/[^a-z0-9]/g, '');

                // STRICT: Title must be an exact alphanumeric match
                if (cleanResult === cleanTarget) {
                    if (year && rtYear) {
                        // Allow +/- 1 year for festival releases vs wide releases
                        if (Math.abs(parseInt(year) - parseInt(rtYear)) <= 1) {
                            return `${score}%`;
                        }
                    } else if (!year || !rtYear) {
                        // Trust exact title match if year info is missing
                        return `${score}%`;
                    }
                }
            }
        }
    } catch (e) {
        // Silent error, fall back to OMDB
    }
    return null;
}

// --- 2. OMDB Fetcher (SECONDARY / FALLBACK) ---
async function fetchScoresFromOmdb(imdbId) {
    if (!imdbId) return null;
    try {
        const url = `http://www.omdbapi.com/?apikey=${OMDB_API_KEY}&i=${imdbId}`;
        const { data } = await axios.get(url, { timeout: 5000 });

        if (data && data.Response === 'True' && data.Ratings) {
            const rt = data.Ratings.find(r => r.Source === "Rotten Tomatoes");
            if (rt) {
                return rt.Value;
            }
        }
    } catch (e) {
        // Silent error
    }
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
        const { data } = await axios.get(url, { timeout: 5000 });
        if (data && data.metas && data.metas.length > 0) {
            return data.metas[0];
        }
    } catch (e) {
        return null;
    }
    return null;
}

async function updateCatalog() {
    console.log('--- STARTING TURBO ACCURATE SCRAPE (v6.0.6) ---');
    lastStatus = "Fetching Reddit...";
    
    let allPosts = [];
    let afterToken = null;
    let keepFetching = true;
    let page = 1;
    const cutoffDateSeconds = Math.floor((Date.now() - MAX_AGE_MS) / 1000);

    try {
        while (keepFetching) {
            const url = `${SUBREDDIT_URL}?limit=100&after=${afterToken || ''}`;
            const response = await axios.get(url, { headers: { 'User-Agent': USER_AGENT }, timeout: 8000 });
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
            if (keepFetching) await delay(1000); 
        }

        console.log(`> Found ${allPosts.length} posts. Processing...`);
        const newCatalog = [];

        for (let i = 0; i < allPosts.length; i++) {
            const p = allPosts[i];
            const parsed = parseTitle(p.title);
            
            // Update status dynamically so Stremio shows progress
            if (i % 10 === 0) {
                 lastStatus = `Scraping scores... (${i}/${allPosts.length})`;
            }

            // ACCURACY FIX: Resolve IMDB first to get the correct actualYear.
            const imdbItem = await resolveToImdb(parsed.title, parsed.year);
            const actualYear = parsed.year || (imdbItem && imdbItem.releaseInfo ? imdbItem.releaseInfo.substring(0,4) : null);

            // SPEED FIX: Run RT and OMDB in parallel!
            const [rtPrimaryScore, omdbScore] = await Promise.all([
                fetchRottenTomatoesPrimary(parsed.title, actualYear),
                imdbItem ? fetchScoresFromOmdb(imdbItem.id) : null
            ]);
            
            // Prefer live RT score, fallback to OMDB
            let rtScore = rtPrimaryScore || omdbScore;

            // Ensure clean formatting for the prefix
            const scorePrefix = rtScore ? `🍅 ${rtScore.replace('%', '')}% ` : ''; 
            const scoreDesc = rtScore ? `⭐️ ROTTEN TOMATOES: ${rtScore} ⭐️\n\n` : '';
            const genres = rtScore ? [`RT: ${rtScore}`, 'Movie Leaks'] : ['Movie Leaks'];

            const displayYear = (imdbItem && imdbItem.releaseInfo) ? imdbItem.releaseInfo : (actualYear || '????');
            const androidBadge = rtScore ? `🍅 ${rtScore.replace('%', '')}% • ${displayYear}` : displayYear;

            let finalName = "";

            if (imdbItem) {
                finalName = `${scorePrefix}${imdbItem.name}`;
                newCatalog.push({
                    id: imdbItem.id,
                    type: 'movie',
                    name: finalName,
                    poster: `https://images.metahub.space/poster/medium/${imdbItem.id}/img`,
                    description: `${scoreDesc}${imdbItem.description || ''}`,
                    releaseInfo: androidBadge,
                    genres: genres 
                });
            } else {
                finalName = `${scorePrefix}${parsed.title}`;
                newCatalog.push({
                    id: `leaks_${p.id}`,
                    type: 'movie',
                    name: finalName,
                    poster: null, 
                    description: `${scoreDesc}Unmatched Release: ${p.title}`,
                    releaseInfo: androidBadge,
                    genres: genres
                });
            }

            // DIAGNOSTIC LOG: Prove what is being sent to Stremio
            if (rtScore) {
                console.log(`> Title Sent to Stremio: [${finalName}]`);
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
        console.log(`> Turbo Update Complete. Catalog size: ${movieCatalog.length}`);

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

builder.defineMetaHandler(({ type, id }) => {
    const item = movieCatalog.find(i => i.id === id);
    if (item) {
        return { meta: item };
    }
    return { meta: null };
});

serveHTTP(builder.getInterface(), { port: PORT });
updateCatalog();
setInterval(updateCatalog, 60 * 60 * 1000); 
console.log(`Addon running on http://localhost:${PORT}`);
