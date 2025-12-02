const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 7000;
const SUBREDDIT_URL = 'https://www.reddit.com/r/movieleaks/new.json';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/catalog/movie/top';

// Use a real browser User-Agent to avoid Reddit blocks
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const manifest = {
    id: 'org.reddit.movieleaks.v4',
    version: '4.0.0',
    name: 'Reddit Movie Leaks (Robust)',
    description: 'Latest releases. If IMDb fails, shows raw Reddit title.',
    resources: ['catalog'],
    types: ['movie'],
    catalogs: [
        {
            type: 'movie',
            id: 'movieleaks_best',
            name: 'Movie Leaks',
            extra: [{ name: 'skip' }]
        }
    ]
};

const builder = new addonBuilder(manifest);
let movieCatalog = [];
let lastStatus = "Initializing...";

// --- Helpers ---

function parseTitle(rawTitle) {
    // Regex to find "Title" and "Year"
    // Matches: "Saltburn 2023", "Saltburn.2023", "Saltburn (2023)"
    const regex = /^(.+?)[\.\s\(]+(\d{4})[\.\s\)]+/;
    const match = rawTitle.match(regex);
    if (match) {
        return {
            title: match[1].replace(/\./g, ' ').trim(),
            year: match[2]
        };
    }
    // Fallback: If no year found, return raw title and current year estimate
    return { title: rawTitle, year: null };
}

async function resolveToImdb(title, year) {
    if (!year) return null; // Cinemeta needs a year to be accurate
    try {
        const query = `${title} ${year}`;
        const url = `${CINEMETA_URL}/search=${encodeURIComponent(query)}.json`;
        const { data } = await axios.get(url);
        if (data && data.metas && data.metas.length > 0) {
            return data.metas[0];
        }
    } catch (e) {
        // Ignore errors, we will fallback to raw data
    }
    return null;
}

async function updateCatalog() {
    console.log(`[${new Date().toLocaleTimeString()}] Fetching r/MovieLeaks...`);
    lastStatus = "Fetching from Reddit...";
    
    try {
        const response = await axios.get(SUBREDDIT_URL, {
            headers: { 'User-Agent': USER_AGENT }
        });

        const redditPosts = response.data.data.children;
        console.log(`> Found ${redditPosts.length} posts. Processing...`);
        lastStatus = `Processing ${redditPosts.length} posts...`;

        const newCatalog = [];

        for (const post of redditPosts.slice(0, 40)) {
            const p = post.data;
            const parsed = parseTitle(p.title);
            
            // 1. Try to resolve to a real IMDb item
            const imdbItem = await resolveToImdb(parsed.title, parsed.year);

            if (imdbItem) {
                // Success: We found a real movie
                newCatalog.push({
                    id: imdbItem.id,
                    type: 'movie',
                    name: imdbItem.name,
                    poster: `https://images.metahub.space/poster/medium/${imdbItem.id}/img`,
                    description: `(IMDb Match) ${imdbItem.description || ''}`,
                    releaseInfo: imdbItem.releaseInfo
                });
                console.log(`> Matched: ${parsed.title} -> ${imdbItem.id}`);
            } else {
                // Failure: Just show the Reddit post as a custom item
                // This ensures the list is NEVER empty if Reddit works
                newCatalog.push({
                    id: `leaks_${p.id}`,
                    type: 'movie',
                    name: parsed.title,
                    poster: p.thumbnail && p.thumbnail.startsWith('http') ? p.thumbnail : null,
                    description: `Raw Reddit Post: ${p.title}\n\nCould not find IMDb match.`,
                    releaseInfo: parsed.year || '????'
                });
                console.log(`> Raw: ${parsed.title} (No IMDb match)`);
            }
        }

        // Remove duplicates
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
        console.error('! Error updating catalog:', error.message);
        lastStatus = `Error: ${error.message}`;
    }
}

// --- Handler ---

builder.defineCatalogHandler(async ({ type, id, extra }) => {
    // If the catalog is empty, show a Status Card so the user knows why
    if (movieCatalog.length === 0) {
        return {
            metas: [{
                id: 'tt0000000',
                type: 'movie',
                name: `Status: ${lastStatus}`,
                description: "If this says 'Fetching', wait 10 seconds and reload. If 'Error', check Termux logs.",
                poster: 'https://via.placeholder.com/300x450.png?text=Loading...',
            }]
        };
    }

    if (type === 'movie' && id === 'movieleaks_best') {
        const skip = extra.skip ? parseInt(extra.skip) : 0;
        return { metas: movieCatalog.slice(skip, skip + 100) };
    }
    return { metas: [] };
});

serveHTTP(builder.getInterface(), { port: PORT });
updateCatalog();
setInterval(updateCatalog, 15 * 60 * 1000); // 15 mins

console.log(`Addon running on http://localhost:${PORT}`);


