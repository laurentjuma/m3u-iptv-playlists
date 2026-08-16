const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const repoRoot = __dirname;
const categoriesPath = path.join(repoRoot, 'stations_categories.json');
const outPath = path.join(repoRoot, 'stations_index.json');

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 60000;
const CONCURRENCY = 6;
const USER_AGENT = 'm3u-iptv-playlists/generate_stations_index';

// The playlists don't live in this repo, they're fetched from wherever the
// category's genre_m3u_link points, so every row costs one request
function fetchText(url, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('http:') ? http : https;
        const options = { headers: { 'User-Agent': USER_AGENT, 'Accept': '*/*' } };

        const request = client.get(url, options, response => {
            const { statusCode, headers } = response;

            // github.com/.../raw/... redirects to raw.githubusercontent.com
            if (statusCode >= 300 && statusCode < 400 && headers.location) {
                response.resume();
                if (redirectsLeft === 0) {
                    reject(new Error('too many redirects'));
                    return;
                }
                resolve(fetchText(new URL(headers.location, url).toString(), redirectsLeft - 1));
                return;
            }

            if (statusCode !== 200) {
                response.resume();
                reject(new Error(`HTTP ${statusCode}`));
                return;
            }

            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('error', reject);
            response.on('end', () => resolve(body));
        });

        request.setTimeout(REQUEST_TIMEOUT_MS, () => {
            request.destroy(new Error(`timed out after ${REQUEST_TIMEOUT_MS}ms`));
        });
        request.on('error', reject);
    });
}

// Function to retry a fetch a few times before giving up on it
async function fetchTextWithRetries(url, label) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await fetchText(url);
        } catch (error) {
            if (attempt === MAX_ATTEMPTS) {
                throw error;
            }
            const delayMs = 1000 * attempt;
            console.log(`  … ${label}: ${error.message} — retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
}

// Pull the display names out of an M3U body (the text after the comma on #EXTINF).
// Entries with no stream URL after the #EXTINF line are left out.
function readChannelNames(m3u) {
    const lines = m3u.split('\n');
    const names = [];
    let linkless = 0;

    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('#EXTINF')) {
            continue;
        }

        const comma = lines[i].indexOf(',');
        if (comma === -1) {
            continue;
        }

        const name = lines[i].slice(comma + 1).trim();
        if (!name) {
            continue;
        }

        // The link is the next non-blank line; another directive means there is none
        let next = i + 1;
        while (next < lines.length && !lines[next].trim()) {
            next++;
        }

        if (next >= lines.length || lines[next].startsWith('#')) {
            linkless++;
            continue;
        }

        names.push(name);
    }

    return { names, linkless };
}

// Function to flatten the catalogue into one row per playlist to fetch
function collectPlaylists(categories, skipped) {
    const playlists = [];

    for (const [category, data] of Object.entries(categories)) {
        const base = data.genre_m3u_link;

        if (!base) {
            console.warn(`! Category "${category}" has no genre_m3u_link, skipping`);
            continue;
        }

        for (const genre of data.genres) {
            if (!genre.genre_m3u_id) {
                skipped.push(`${category}/${genre.name}: no genre_m3u_id`);
                continue;
            }

            // A few rows point somewhere else entirely rather than at the category's host
            const absolute = /^https?:\/\//.test(genre.genre_m3u_id);
            const url = absolute ? genre.genre_m3u_id : base + genre.genre_m3u_id;

            playlists.push({
                id: genre.genre_m3u_id.split('/').pop(),
                label: `${category}/${genre.name}`,
                url
            });
        }
    }

    return playlists;
}

// Function to run the fetches a few at a time instead of firing 200+ at once
async function fetchAll(playlists) {
    const results = new Array(playlists.length);
    let cursor = 0;
    let done = 0;

    async function worker() {
        while (cursor < playlists.length) {
            const slot = cursor++;
            const playlist = playlists[slot];

            try {
                const body = await fetchTextWithRetries(playlist.url, playlist.label);
                results[slot] = { playlist, ...readChannelNames(body) };
            } catch (error) {
                results[slot] = { playlist, error };
            }

            done++;
            if (done % 25 === 0 || done === playlists.length) {
                console.log(`  … ${done}/${playlists.length} playlists fetched`);
            }
        }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    return results;
}

async function generateIndex() {
    const categories = JSON.parse(fs.readFileSync(categoriesPath, 'utf8'));
    const index = {};
    const skipped = [];
    let channelCount = 0;
    let linklessCount = 0;

    const playlists = collectPlaylists(categories, skipped);
    console.log(`Fetching ${playlists.length} playlists, ${CONCURRENCY} at a time`);

    for (const result of await fetchAll(playlists)) {
        const { playlist } = result;

        if (result.error) {
            skipped.push(`${playlist.label}: ${result.error.message} (${playlist.url})`);
            continue;
        }

        if (index[playlist.id]) {
            console.warn(`! Duplicate id "${playlist.id}" (${playlist.label}), overwriting`);
        }

        index[playlist.id] = result.names;
        channelCount += result.names.length;
        linklessCount += result.linkless;
    }

    // Keyed in catalogue order, which the fetches finish out of
    const ordered = {};
    for (const playlist of playlists) {
        if (index[playlist.id]) {
            ordered[playlist.id] = index[playlist.id];
        }
    }

    fs.writeFileSync(outPath, JSON.stringify(ordered), 'utf8');

    console.log(`✓ Wrote ${path.relative(repoRoot, outPath)}`);
    console.log(`  ${Object.keys(ordered).length} playlists, ${channelCount} channels`);
    console.log(`  Omitted ${linklessCount} channels with no link`);

    if (skipped.length) {
        console.log(`\nSkipped ${skipped.length} entries:`);
        skipped.forEach(reason => console.log(`  - ${reason}`));
    }
}

generateIndex().catch(error => {
    console.error(error);
    process.exit(1);
});
