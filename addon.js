```javascript
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
    version: '6.0.2', // Bumped version for strict accuracy
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

// --- 1. OMDB Fetcher (Primary & Reliable) ---
async function fetchScoresFromOmdb(imdbId) {
    if (!imdbId) return null;
    try {
        const url = `http://www.omdbapi.com/?apikey=${OMDB_API_KEY}&i=${imdbId}`;
        const { data } = await axios.get(url);

        if (data && data.Response === 'True' && data.Ratings) {
            // OMDB explicitly labels the Critic Tomatometer as "Rotten Tomatoes"
            const rt = data.Ratings.find(r => r.Source === "Rotten Tomatoes");
            if (rt) {
                console.log(`> 🍅 OMDB Tomatometer Hit for ${imdbId}: ${rt.Value}`);
                return rt.Value;
            }
        }
    } catch (e) {
        // Silent error
    }
    return null;
}

// --- 2. RT Direct Fetcher (STRICT Fallback) ---
async function fetchRottenTomatoesFallback(title, year) {
    try {
        const query = year ? `${title} ${year}` : title;
        const url = `https://www.rottentomatoes.com/search?search=${encodeURIComponent(query)}`;
        const { data } = await axios.get(url, { 
            headers: { 'User-Agent': USER_AGENT } 
        });

        // Parse the HTML rows to ensure we only get MOVIES and match the YEAR
        const matches = [...data.matchAll(/<search-page-media-row([^>]+)>/g)];
        
        for (const match of matches) {
            const attrs = match[1];
            
            // Extract attributes from the HTML tag
            const isMovie = attrs.includes('data-type="movie"') || attrs.includes('type="movie"');
            const scoreMatch = attrs.match(/tomatometerscore\s*=\s*["'](\d+)["']/i); // strictly tomatometer
            const yearMatch = attrs.match(/releaseyear\s*=\s*["'](\d{4})["']/i);
            
            if (isMovie && scoreMatch) {
                const score = scoreMatch[1];
                const rtYear = yearMatch ? yearMatch[1] : null;

                // If a year is provided, ensure it matches (allow 1 year difference for festival vs wide release)
                if (year && rtYear) {
                    if (Math.abs(parseInt(year) - parseInt(rtYear)) <= 1) {
                        console.log(`> 🍅 Scrape Hit for "${title}" (${rtYear}): ${score}%`);
                        return `${score}%`;
                    }
                } else {
                    // Extract title to prevent totally wrong matches when year is missing
                    const titleMatch = attrs.match(/name\s*=\s*["']([^"']+)["']/i);
                    const rtTitle = titleMatch ? titleMatch[1].replace(/&#[0-9]+;/g, '') : ""; // Handle HTML entities

                    if (!year && rtTitle.toLowerCase() === title.toLowerCase()) {
                        console.log(`> 🍅 Scrape Hit for "${title}": ${score}%`);
                        return `${score}%`;
                    } else if (!year) {
                        // Very last resort if no year and title isn't exact
                        console.log(`> 🍅 Loose Scrape Hit for "${title}": ${score}%`);
                        return `${score}%`;
                    }
                }
            }
        }
    } catch (e) {
        // Silent error
    }
    return null;
}

function parseTitle(rawTitle) {
    // Bulletproof parsing to handle titles ending in year like "Apex (2026)"
    const yearMatch = rawTitle.match(/(19|20)\d{2}/);
    if (yearMatch) {
        const yearIndex = yearMatch.index;
        let title = rawTitle.substring(0, yearIndex).trim();
        // Clean up brackets, dots, hyphens
        title = title.replace(/[\._\(\)\[\]\-]/g, ' ').replace(/\s+/g, ' ').trim();
        return { title: title, year: yearMatch[0] };
    }
    
    // Fallback if no year found at all
    let title = rawTitle.replace(/[\._\(\)\[\]\-]/g, ' ').replace(/\s+/g, ' ').trim();
    return { title: title, year: null };
}

async function resolveToImdb(title, year) {
    try {
        const query = year ? `${title} ${year}` : title;
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
    console.log('--- STARTING SCRAPE (v6.0.2) ---');
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
            
            const imdbItem = await resolveToImdb(parsed.title, parsed.year);
            
            // KEY FIX: Use Cinemeta's year if Reddit post didn't have one
            const actualYear = parsed.year || (imdbItem && imdbItem.releaseInfo ? imdbItem.releaseInfo.substring(0,4) : null);

            let rtScore = null;
            if (imdbItem) {
                rtScore = await fetchScoresFromOmdb(imdbItem.id);
            }
            if (!rtScore) {
                rtScore = await fetchRottenTomatoesFallback(parsed.title, actualYear);
            }

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



```
