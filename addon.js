const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 7000;
const SUBREDDIT_URL = 'https://www.reddit.com/r/movieleaks/new.json';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/catalog/movie/top';

// RPDB API Key (Pre-filled)
// const RPDB_API_KEY = '';

// Cache configuration
const UPDATE_INTERVAL = 15 * 60 * 1000; // 15 minutes
let movieCatalog = []; 

const manifest = {
    id: 'org.reddit.movieleaks.imdb',
    version: '2.2.0',
    name: 'Reddit Movie Leaks (RPDB)',
    description: 'Latest r/MovieLeaks releases with IMDb matching and RPDB ratings.',
    resources: ['catalog'],
    types: ['movie'],
    catalogs: [
        {
            type: 'movie',
            id: 'movieleaks_imdb',
            name: 'Movie Leaks',
            extra: [{ name: 'skip' }]
        }
    ]
};

const builder = new addonBuilder(manifest);

// --- Helpers ---

function parseTitle(rawTitle) {
    // Regex extracts title and year from "Movie.Title.2023.1080p..."
    const regex = /^(.+?)[\.\s\(]+(\d{4})[\.\s\)]+/;
    const match = rawTitle.match(regex);
    if (match) {
        return {
            title: match[1].replace(/\./g, ' ').trim(),
            year: match[2]
        };
    }
    return null; 
}

async function resolveToImdb(title, year) {
    try {
        const query = `${title} ${year}`;
        const url = `${CINEMETA_URL}/search=${encodeURIComponent(query)}.json`;
        const { data } = await axios.get(url);

        if (data && data.metas && data.metas.length > 0) {
            return data.metas[0];
        }
    } catch (e) {
        console.error(`Failed to resolve: ${title} (${year})`);
    }
    return null;
}

async function updateCatalog() {
    console.log('--- Updating Catalog from r/MovieLeaks ---');
    try {
        const response = await axios.get(SUBREDDIT_URL, {
            headers: { 'User-Agent': 'StremioAddon/2.2' }
        });

        const redditPosts = response.data.data.children;
        const newCatalog = [];

        // Limit to top 40 to prevent rate limits
        for (const post of redditPosts.slice(0, 40)) {
            const parsed = parseTitle(post.data.title);
            
            if (parsed) {
                // Check local cache first
                const existing = movieCatalog.find(m => m.name === parsed.title && m.releaseInfo === parsed.year);
                
                if (existing) {
                    newCatalog.push(existing);
                } else {
                    const imdbItem = await resolveToImdb(parsed.title, parsed.year);
                    if (imdbItem) {
                        
                        // Construct RPDB URL using the provided key
                        const posterUrl = `https://api.ratingposterdb.com/${RPDB_API_KEY}/imdb/poster/default/${imdbItem.id}.jpg`;

                        newCatalog.push({
                            id: imdbItem.id,
                            type: 'movie',
                            name: imdbItem.name,
                            poster: posterUrl, 
                            description: imdbItem.description,
                            releaseInfo: imdbItem.releaseInfo
                        });
                        console.log(`Matched: ${parsed.title} -> ${imdbItem.id}`);
                    }
                }
            }
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
        console.log(`--- Update Complete. Catalog size: ${movieCatalog.length} ---`);

    } catch (error) {
        console.error('Error updating catalog:', error.message);
    }
}

// --- Handler ---

builder.defineCatalogHandler(async ({ type, id, extra }) => {
    if (type === 'movie' && id === 'movieleaks_imdb') {
        const skip = extra.skip ? parseInt(extra.skip) : 0;
        const metas = movieCatalog.slice(skip, skip + 100);
        return { metas };
    }
    return { metas: [] };
});

serveHTTP(builder.getInterface(), { port: PORT });

// Init
updateCatalog();
setInterval(updateCatalog, UPDATE_INTERVAL);

console.log(`Addon running on http://localhost:${PORT}`);


