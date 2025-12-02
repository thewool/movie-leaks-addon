const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 7000;
const SUBREDDIT_URL = 'https://www.reddit.com/r/movieleaks/new.json';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/catalog/movie/top';

// Cache configuration
const UPDATE_INTERVAL = 15 * 60 * 1000; // 15 minutes
let movieCatalog = []; 

const manifest = {
    id: 'org.reddit.movieleaks.v3',
    version: '3.0.0', // Version bumped to force refresh
    name: 'Reddit Movie Leaks (Fixed)',
    description: 'Latest r/MovieLeaks releases with official Stremio posters.',
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
            headers: { 'User-Agent': 'StremioAddon/3.0' }
        });

        const redditPosts = response.data.data.children;
        const newCatalog = [];

        // Process top 40 posts
        for (const post of redditPosts.slice(0, 40)) {
            const parsed = parseTitle(post.data.title);
            
            if (parsed) {
                // Check local cache
                const existing = movieCatalog.find(m => m.name === parsed.title && m.releaseInfo === parsed.year);
                
                if (existing) {
                    newCatalog.push(existing);
                } else {
                    const imdbItem = await resolveToImdb(parsed.title, parsed.year);
                    if (imdbItem) {
                        
                        // FIX: Force Official Stremio Poster URL
                        // This uses MetaHub directly, which is always reliable.
                        const posterUrl = `https://images.metahub.space/poster/medium/${imdbItem.id}/img`;

                        newCatalog.push({
                            id: imdbItem.id,
                            type: 'movie',
                            name: imdbItem.name,
                            poster: posterUrl, 
                            description: imdbItem.description,
                            releaseInfo: imdbItem.releaseInfo
                        });
                        console.log(`Matched: ${parsed.title} -> ${imdbItem.id}`);
                        console.log(`Poster: ${posterUrl}`); // Log to check in Termux
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
updateCatalog();
setInterval(updateCatalog, UPDATE_INTERVAL);

console.log(`Addon running on http://localhost:${PORT}`);


