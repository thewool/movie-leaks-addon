const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 7000;
const SUBREDDIT_URL = 'https://www.reddit.com/r/movieleaks/new.json';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/catalog/movie/top';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 60 days in milliseconds
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000; 

const manifest = {
    id: 'org.reddit.movieleaks.v5',
    version: '5.0.0',
    name: 'Reddit Movie Leaks (2 Months)',
    description: 'Scrapes r/MovieLeaks going back 2 months. Be patient on first load.',
    resources: ['catalog'],
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

// --- Helpers ---

// Delay function to prevent Reddit bans (2 seconds)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- NEW: Direct Rotten Tomatoes Fetcher ---
async function fetchRottenTomatoesDirect(title, year) {
    try {
        // Search just Title first, then Title + Year if needed
        let searchQueries = [title];
        if (year) searchQueries.push(`${title} ${year}`);

        for (const query of searchQueries) {
            const url = `https://www.rottentomatoes.com/napi/search/all?query=${encodeURIComponent(query)}&limit=5`;
            const { data } = await axios.get(url, { 
                headers: { 'User-Agent': USER_AGENT } 
            });

            if (data && data.movie && data.movie.items && data.movie.items.length > 0) {
                const match = data.movie.items.find(m => {
                    if (year && m.releaseYear) {
                        const diff = Math.abs(parseInt(m.releaseYear) - parseInt(year));
                        return diff <= 1; // Allow 1 year variance
                    }
                    return true;
                });

                if (match && match.tomatometerScore && match.tomatometerScore.score) {
                    return `${match.tomatometerScore.score}%`;
                }
            }
            await delay(200); // Polite delay between retries
        }
    } catch (e) {
        // Ignore errors to keep flow moving
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
    console.log('--- STARTING 2-MONTH SCRAPE ---');
    lastStatus = "Scraping Reddit (Page 1)...";
    
    let allPosts = [];
    let afterToken = null;
    let keepFetching = true;
    let page = 1;
    
    // Time cutoff (2 months ago)
    // Reddit API uses SECONDS for timestamp, JS uses MILLISECONDS
    const cutoffDateSeconds = Math.floor((Date.now() - MAX_AGE_MS) / 1000);

    try {
        while (keepFetching) {
            console.log(`> Fetching Page ${page}...`);
            lastStatus = `Fetching Page ${page}...`;

            const url = `${SUBREDDIT_URL}?limit=100&after=${afterToken || ''}`;
            
            const response = await axios.get(url, {
                headers: { 'User-Agent': USER_AGENT }
            });

            const children = response.data.data.children;
            
            if (children.length === 0) {
                keepFetching = false;
                break;
            }

            for (const child of children) {
                const p = child.data;
                
                // Stop if post is older than 2 months
                if (p.created_utc < cutoffDateSeconds) {
                    console.log(`> Reached limit: Post from ${new Date(p.created_utc * 1000).toLocaleDateString()}`);
                    keepFetching = false;
                    break; 
                }
                
                allPosts.push(p);
            }

            // Pagination logic
            afterToken = response.data.data.after;
            if (!afterToken) keepFetching = false;

            page++;
            // Polite delay between pages
            if (keepFetching) await delay(2000); 
        }

        console.log(`> Found ${allPosts.length} posts in last 2 months. Processing IMDB & RT...`);
        lastStatus = `Processing ${allPosts.length} items...`;

        const newCatalog = [];

        // Process posts (Latest first)
        for (const p of allPosts) {
            const parsed = parseTitle(p.title);
            
            // 1. Resolve to IMDb
            const imdbItem = await resolveToImdb(parsed.title, parsed.year);

            // 2. NEW: Fetch Rotten Tomatoes Score
            const rtScore = await fetchRottenTomatoesDirect(parsed.title, parsed.year);
            const scorePrefix = rtScore ? `🍅 ${rtScore} ` : '';

            if (imdbItem) {
                // Official Poster
                newCatalog.push({
                    id: imdbItem.id,
                    type: 'movie',
                    name: `${scorePrefix}${imdbItem.name}`, // Add score here
                    poster: `https://images.metahub.space/poster/medium/${imdbItem.id}/img`,
                    description: `(Verified) ${imdbItem.description || ''}`,
                    releaseInfo: imdbItem.releaseInfo
                });
            } else {
                // Fallback Item
                newCatalog.push({
                    id: `leaks_${p.id}`,
                    type: 'movie',
                    name: `${scorePrefix}${parsed.title}`, // Add score here too
                    poster: null, 
                    description: `Unmatched Release: ${p.title}`,
                    releaseInfo: parsed.year || '????'
                });
            }
            
            // Slight delay to be gentle on RT API
            await delay(100); 
        }

        // Deduplicate
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

// --- Handler ---

builder.defineCatalogHandler(async ({ type, id, extra }) => {
    // Show status if empty
    if (movieCatalog.length === 0) {
        return {
            metas: [{
                id: 'tt_status',
                type: 'movie',
                name: `Status: ${lastStatus}`,
                description: "Please wait for the server to finish fetching 2 months of data.",
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

serveHTTP(builder.getInterface(), { port: PORT });

// Run initial update immediately
updateCatalog();

// Refresh every hour (fetching 2 months of data takes time, so we do it less often)
setInterval(updateCatalog, 60 * 60 * 1000); 

console.log(`Addon running on http://localhost:${PORT}`);
