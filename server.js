const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const port = Number(process.env.PORT) || 3000;
const htmlPath = path.join(__dirname, 'Tracking.html');
const faviconPath = path.join(__dirname, 'favicon.svg');
// Comma-separated access keys supplied only by the deployment environment.
// Leaving this unset keeps local development open.
const accessKeys = (process.env.TRACKER_ACCESS_KEYS || '')
    .split(',')
    .map(key => key.trim())
    .filter(Boolean);
const accessSessions = new Map();
const accessSessionLifetimeMs = 14 * 24 * 60 * 60 * 1000;
// Keep long-term tracking data in a separate persistent directory when the
// app is deployed, while still using this folder during local development.
const statePath = process.env.TRACKER_STATE_PATH || path.join(__dirname, 'tracker-state.json');
const nameCache = new Map();
const nameLookupInFlight = new Set();
const avatarCache = new Map();
const avatarLookupInFlight = new Set();
const pointHistory = new Map();
const leaguePointHistory = new Map();
const pointTrackingStart = new Map();
const leagueTrackingStart = new Map();
const pointSignatures = new Map();
const pointLastUpdated = new Map();
const clanActivityState = new Map();
const leagueActivityState = new Map();
const enchantLoadoutCache = new Map();
const enchantLookupInFlight = new Set();
const enchantRefreshMs = 10 * 60 * 1000;
const enchantLoadoutSchemaVersion = 3;
let enchantLastRefreshedAt = 0;
let enchantLastScannedCount = 0;
let enchantRefreshPromise = null;
let enchantRefreshTimer = null;
let saveTimer = null;

function parseCookies(request) {
    return Object.fromEntries((request.headers.cookie || '')
        .split(';')
        .map(item => item.trim().split('='))
        .filter(([key, value]) => key && value));
}

function isAccessAuthorized(request) {
    if (!accessKeys.length) return true;
    const token = parseCookies(request).tracker_access;
    const expiresAt = token && accessSessions.get(token);
    if (!expiresAt || expiresAt <= Date.now()) {
        if (token) accessSessions.delete(token);
        return false;
    }
    return true;
}

function keyIsValid(candidate) {
    const value = Buffer.from(candidate || '');
    return accessKeys.some(key => {
        const expected = Buffer.from(key);
        return value.length === expected.length && crypto.timingSafeEqual(value, expected);
    });
}

function renderAccessPage(response, invalid = false) {
    const message = invalid ? '<p class="error">That access key is not valid.</p>' : '';
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>T0IXHub Tracking · Access</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at top,#25164c,#080b17 65%);color:#f7f5ff;font:16px Arial,sans-serif}.card{width:min(390px,calc(100% - 40px));padding:34px;border:1px solid #5e4b9b;border-radius:18px;background:#121426e8;box-shadow:0 22px 70px #0008}h1{margin:0 0 8px;font-size:29px}.accent{color:#6ef0c2}p{color:#adb6d5;line-height:1.5}.error{color:#ff8aa8}input,button{box-sizing:border-box;width:100%;padding:14px;border-radius:10px;font-size:16px}input{margin:14px 0;border:1px solid #4b4271;background:#090b15;color:#fff}button{border:0;background:linear-gradient(90deg,#875dff,#35cdeb);color:#fff;font-weight:800;cursor:pointer}</style></head><body><main class="card"><div class="accent">T0IXHUB · PRIVATE TRACKER</div><h1>Enter access key</h1><p>This tracker is private. Enter the access key you were given to continue.</p>${message}<form method="post" action="/access"><input name="key" type="password" autocomplete="current-password" autofocus required placeholder="Access key"><button type="submit">Enter tracker</button></form></main></body></html>`);
}

async function readRequestBody(request) {
    let body = '';
    for await (const chunk of request) {
        body += chunk;
        if (body.length > 4_096) throw new Error('Request body too large.');
    }
    return body;
}

function restoreNumericMap(target, entries) {
    for (const [key, value] of entries || []) target.set(Number(key), value);
}

function loadState() {
    try {
        if (!fs.existsSync(statePath)) return;
        const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        restoreNumericMap(pointHistory, saved.pointHistory);
        restoreNumericMap(leaguePointHistory, saved.leaguePointHistory);
        restoreNumericMap(pointTrackingStart, saved.pointTrackingStart);
        restoreNumericMap(leagueTrackingStart, saved.leagueTrackingStart);
        restoreNumericMap(clanActivityState, saved.clanActivityState);
        restoreNumericMap(leagueActivityState, saved.leagueActivityState);
        restoreNumericMap(nameCache, saved.nameCache);
        restoreNumericMap(avatarCache, saved.avatarCache);
        // Version the cache so a parser improvement never leaves the UI showing
        // stale, incorrectly-shaped loadouts after a server restart.
        if (saved.enchantLoadoutSchemaVersion === enchantLoadoutSchemaVersion) {
            restoreNumericMap(enchantLoadoutCache, saved.enchantLoadoutCache);
            enchantLastRefreshedAt = Number(saved.enchantLastRefreshedAt) || 0;
            enchantLastScannedCount = Number(saved.enchantLastScannedCount) || 0;
        }
        for (const [key, value] of saved.pointSignatures || []) pointSignatures.set(key, value);
        for (const [key, value] of saved.pointLastUpdated || []) pointLastUpdated.set(key, value);
        console.log('Restored saved tracker state.');
    } catch (error) {
        console.warn('Could not restore tracker state:', error.message);
    }
}

async function saveState() {
    const state = {
        version: 1,
        savedAt: Date.now(),
        pointHistory: [...pointHistory],
        leaguePointHistory: [...leaguePointHistory],
        pointTrackingStart: [...pointTrackingStart],
        leagueTrackingStart: [...leagueTrackingStart],
        clanActivityState: [...clanActivityState],
        leagueActivityState: [...leagueActivityState],
        pointSignatures: [...pointSignatures],
        pointLastUpdated: [...pointLastUpdated],
        nameCache: [...nameCache],
        avatarCache: [...avatarCache],
        enchantLoadoutSchemaVersion,
        enchantLoadoutCache: [...enchantLoadoutCache],
        enchantLastRefreshedAt,
        enchantLastScannedCount
    };
    try {
        await fs.promises.writeFile(statePath, JSON.stringify(state), 'utf8');
    } catch (error) {
        console.warn('Could not save tracker state:', error.message);
    }
}

function queueStateSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        void saveState();
    }, 1000);
}

function getPointUpdatedAt(key, members) {
    const signature = members
        .map(member => `${member.userId}:${member.points}`)
        .sort()
        .join('|');

    if (pointSignatures.get(key) !== signature) {
        pointSignatures.set(key, signature);
        pointLastUpdated.set(key, Date.now());
    }

    return pointLastUpdated.get(key);
}

function addHourlyGains(members, historyStore = pointHistory, trackingStartStore = pointTrackingStart) {
    const now = Date.now();
    const minute = 60 * 1000;
    const historyRetention = 24 * 60 * minute;

    return members.map(member => {
        const history = historyStore.get(member.userId) || [];
        const gainFor = duration => {
            const reference = [...history].reverse().find(entry => entry.timestamp <= now - duration);
            return reference ? member.points - reference.points : null;
        };
        const hourlyGain = gainFor(60 * minute);
        const sixHourGain = gainFor(6 * 60 * minute);
        const twelveHourGain = gainFor(12 * 60 * minute);
        const dayGain = gainFor(24 * 60 * minute);
        const trackingStart = trackingStartStore.get(member.userId) || { timestamp: now, points: member.points };
        if (!trackingStartStore.has(member.userId)) trackingStartStore.set(member.userId, trackingStart);

        // One sample per minute supports 24-hour gains without large memory use.
        if (!history.length || now - history[history.length - 1].timestamp >= minute) {
            history.push({ timestamp: now, points: member.points });
            queueStateSave();
        }
        historyStore.set(member.userId, history.filter(entry => entry.timestamp >= now - historyRetention - (2 * minute)));

        return {
            ...member,
            hourlyGain,
            sixHourGain,
            twelveHourGain,
            dayGain,
            trackedGain: member.points - trackingStart.points
        };
    });
}

function addActivityStats(members, activityStore) {
    const now = Date.now();
    const idleThreshold = 10 * 60 * 1000;

    return members.map(member => {
        let state = activityStore.get(member.userId);
        if (!state) {
            state = {
                lastPoints: member.points,
                lastChangeAt: now,
                lastSampleAt: now,
                mode: 'uptime',
                uptimeMs: 0,
                downtimeMs: 0
            };
            activityStore.set(member.userId, state);
            return { ...member, uptimeMs: 0, downtimeMs: 0, activity: 'uptime' };
        }

        const elapsed = now - state.lastSampleAt;
        if (state.mode === 'uptime') state.uptimeMs += elapsed;
        else state.downtimeMs += elapsed;

        if (member.points !== state.lastPoints) {
            state.lastPoints = member.points;
            state.lastChangeAt = now;
            state.mode = 'uptime';
        } else if (now - state.lastChangeAt >= idleThreshold) {
            state.mode = 'downtime';
        }

        state.lastSampleAt = now;
        return { ...member, uptimeMs: state.uptimeMs, downtimeMs: state.downtimeMs, activity: state.mode };
    });
}

async function getLeagueData() {
    const response = await fetch('https://ps99.biggamesapi.io/v1/leagues/players');
    if (!response.ok) throw new Error('Could not load league players.');

    const result = await response.json();
    const players = result.data?.players || [];
    const requiresRobloxLookup = players
        .filter(player => !player.DisplayName || player.DisplayName === String(player.UserID))
        .map(player => player.UserID);
    const cachedNames = new Map(
        requiresRobloxLookup
            .filter(userId => nameCache.has(userId))
            .map(userId => [userId, nameCache.get(userId)])
    );

    // Keep the points leaderboard quick: missing Roblox names load in the
    // background and are served from cache on the next five-second refresh.
    if (requiresRobloxLookup.length) {
        void resolveRobloxNames(requiresRobloxLookup);
    }
    const leagueUserIds = players.map(player => player.UserID);
    const cachedAvatars = new Map(
        leagueUserIds.filter(userId => avatarCache.has(userId)).map(userId => [userId, avatarCache.get(userId)])
    );
    void resolveRobloxAvatars(leagueUserIds);

    const members = players.map(player => ({
        userId: player.UserID,
        displayName: player.DisplayName && player.DisplayName !== String(player.UserID)
            ? player.DisplayName
            : cachedNames.get(player.UserID) || String(player.UserID),
        group: player.League?.Name || 'Unknown',
        avatarUrl: cachedAvatars.get(player.UserID) || null,
        points: player.Points || 0
    }));

    const rankedMembers = addActivityStats(
        addHourlyGains(members, leaguePointHistory, leagueTrackingStart),
        leagueActivityState
    )
        .sort((a, b) => b.points - a.points);

    return {
        name: 'League leaderboard',
        groupLabel: 'League',
        memberCount: members.length,
        updatedAt: getPointUpdatedAt('league', rankedMembers),
        members: rankedMembers
    };
}

function getInventoryView(payload) {
    const data = payload?.data || payload;
    return data?.views?.inventory || data?.inventory || null;
}

function normaliseEnchants(payload) {
    const inventory = getInventoryView(payload);
    if (!inventory || inventory.available === false) return null;
    // The public inventory shape is data.equipped.enchants.list. Keep the
    // fallbacks to tolerate older snapshots without losing valid players.
    const equipped = inventory.data?.equipped || inventory.equipped || {};
    const enchantData = equipped.enchants || inventory.data?.enchants || inventory.enchants || [];
    const entries = Array.isArray(enchantData) ? enchantData : (enchantData.list || []);
    return entries
        .filter(enchant => enchant && (enchant.displayName || enchant.name || enchant.id))
        .map(enchant => ({
            slot: Number.isFinite(Number(enchant.slot)) ? Number(enchant.slot) : null,
            id: String(enchant.id || enchant.displayName || enchant.name),
            name: String(enchant.displayName || enchant.name || enchant.id),
            level: enchant.level ?? enchant.tier ?? null,
            paid: Boolean(enchant.paid),
            icon: typeof enchant.icon === 'string' ? enchant.icon : null
        }))
        .sort((a, b) => (a.slot ?? 999) - (b.slot ?? 999));
}

async function fetchPublicEnchantLoadout(player) {
    const userId = Number(player.UserID);
    try {
        const response = await fetch(`https://ps99.biggamesapi.io/v1/players/${userId}?include=inventory`);
        if (!response.ok) return null;
        const payload = await response.json();
        const enchants = normaliseEnchants(payload);
        if (!enchants) return null;
        return {
            userId,
            displayName: player.DisplayName && player.DisplayName !== String(userId)
                ? player.DisplayName
                : nameCache.get(userId) || String(userId),
            league: player.League?.Name || 'Unknown',
            points: player.Points || 0,
            globalRank: player.globalRank || null,
            avatarUrl: avatarCache.get(userId) || null,
            enchants
        };
    } catch (error) {
        console.warn(`Could not fetch enchant loadout for ${userId}:`, error.message);
        return null;
    }
}

function scheduleEnchantRefresh() {
    if (enchantRefreshTimer) clearTimeout(enchantRefreshTimer);
    enchantRefreshTimer = setTimeout(async () => {
        try {
            await refreshLeagueEnchantLoadouts();
        } catch (error) {
            console.warn('Scheduled enchant loadout refresh failed:', error.message);
            scheduleEnchantRefresh();
        }
    }, enchantRefreshMs);
}

async function refreshLeagueEnchantLoadouts() {
    if (enchantRefreshPromise) return enchantRefreshPromise;
    enchantRefreshPromise = (async () => {
        const leaderboardResponse = await fetch('https://ps99.biggamesapi.io/v1/leagues/players');
        if (!leaderboardResponse.ok) throw new Error('Could not load league players for enchant scan.');
        // This aggregate has no pagination: BIG Games returns up to its top 500
        // league contributors in one response. Keep the cap explicit in case
        // the endpoint ever returns additional records.
        const players = ((await leaderboardResponse.json()).data?.players || [])
            .slice(0, 500)
            .map((player, index) => ({ ...player, globalRank: index + 1 }));
        const idsMissingNames = players
            .filter(player => !player.DisplayName || player.DisplayName === String(player.UserID))
            .map(player => player.UserID);
        if (idsMissingNames.length) void resolveRobloxNames(idsMissingNames);
        void resolveRobloxAvatars(players.map(player => player.UserID));

        // A small worker pool keeps the scan courteous to the public API.
        const results = [];
        const queue = [...players];
        const worker = async () => {
            while (queue.length) {
                const player = queue.shift();
                const userId = Number(player.UserID);
                enchantLookupInFlight.add(userId);
                const loadout = await fetchPublicEnchantLoadout(player);
                enchantLookupInFlight.delete(userId);
                if (loadout) results.push(loadout);
            }
        };
        await Promise.all(Array.from({ length: 12 }, worker));
        enchantLoadoutCache.clear();
        for (const loadout of results) enchantLoadoutCache.set(loadout.userId, loadout);
        enchantLastRefreshedAt = Date.now();
        enchantLastScannedCount = players.length;
        queueStateSave();
        if (enchantRefreshTimer) clearTimeout(enchantRefreshTimer);
        // Once the tab has been used, keep its cache warm without touching the
        // five-second points polling loop.
        scheduleEnchantRefresh();
    })();

    try {
        await enchantRefreshPromise;
    } finally {
        enchantRefreshPromise = null;
    }
}

async function getLeagueEnchantLoadouts() {
    const stale = !enchantLastRefreshedAt || Date.now() - enchantLastRefreshedAt >= enchantRefreshMs;
    if (stale) await refreshLeagueEnchantLoadouts();
    return {
        refreshedAt: enchantLastRefreshedAt,
        refreshEveryMinutes: enchantRefreshMs / 60000,
        scanning: Boolean(enchantRefreshPromise),
        scannedPlayerCount: enchantLastScannedCount,
        playerCount: enchantLoadoutCache.size,
        players: [...enchantLoadoutCache.values()]
            .map(player => ({ ...player, avatarUrl: avatarCache.get(player.userId) || player.avatarUrl || null }))
            .sort((a, b) => b.points - a.points)
    };
}

async function getRobloxName(userId) {
    const cached = nameCache.get(userId);
    if (cached) return cached;

    try {
        const response = await fetch(`https://users.roblox.com/v1/users/${userId}`);
        if (!response.ok) return String(userId);

        const user = await response.json();
        const name = user.displayName || user.name || String(userId);
        nameCache.set(userId, name);
        return name;
    } catch {
        return String(userId);
    }
}

async function resolveRobloxNames(userIds) {
    const uniqueIds = [...new Set(userIds)];
    const missingIds = uniqueIds.filter(userId =>
        !nameCache.has(userId) && !nameLookupInFlight.has(userId)
    );
    missingIds.forEach(userId => nameLookupInFlight.add(userId));

    // Roblox accepts up to 50 IDs per bulk request.
    const batches = [];
    for (let index = 0; index < missingIds.length; index += 50) {
        batches.push(missingIds.slice(index, index + 50));
    }

    await Promise.all(batches.map(async batch => {
        try {
            const response = await fetch('https://users.roblox.com/v1/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userIds: batch, excludeBannedUsers: false })
            });

            if (!response.ok) throw new Error(`Roblox returned ${response.status}`);

            const result = await response.json();
            const foundIds = new Set();
            for (const user of result.data || []) {
                nameCache.set(user.id, user.displayName || user.name || String(user.id));
                foundIds.add(user.id);
            }
            for (const userId of batch) {
                if (!foundIds.has(userId)) nameCache.set(userId, String(userId));
            }
        } catch (error) {
            console.warn('Bulk Roblox name lookup failed:', error.message);
        } finally {
            batch.forEach(userId => nameLookupInFlight.delete(userId));
        }
    }));

    return new Map(uniqueIds.map(userId => [userId, nameCache.get(userId) || String(userId)]));
}

async function resolveRobloxAvatars(userIds) {
    const uniqueIds = [...new Set(userIds)];
    const missingIds = uniqueIds.filter(userId =>
        !avatarCache.has(userId) && !avatarLookupInFlight.has(userId)
    );
    missingIds.forEach(userId => avatarLookupInFlight.add(userId));

    const batches = [];
    for (let index = 0; index < missingIds.length; index += 100) {
        batches.push(missingIds.slice(index, index + 100));
    }

    await Promise.all(batches.map(async batch => {
        try {
            const query = new URLSearchParams({
                userIds: batch.join(','),
                size: '48x48',
                format: 'Png',
                isCircular: 'false'
            });
            const response = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?${query}`);
            if (!response.ok) throw new Error(`Roblox thumbnails returned ${response.status}`);

            const result = await response.json();
            for (const avatar of result.data || []) {
                if (avatar.imageUrl?.startsWith('https://')) {
                    avatarCache.set(avatar.targetId, avatar.imageUrl);
                }
            }
        } catch (error) {
            console.warn('Roblox avatar lookup failed:', error.message);
        } finally {
            batch.forEach(userId => avatarLookupInFlight.delete(userId));
        }
    }));
}

async function getPlayerData(userId) {
    const [clanResponse, robloxResponse] = await Promise.all([
        fetch(`https://ps99.biggamesapi.io/v1/clans/players/${userId}`),
        fetch(`https://users.roblox.com/v1/users/${userId}`)
    ]);

    if (!clanResponse.ok) {
        throw new Error(`Could not load points (HTTP ${clanResponse.status}).`);
    }
    if (!robloxResponse.ok) {
        throw new Error(`Could not load Roblox profile (HTTP ${robloxResponse.status}).`);
    }

    const clanData = await clanResponse.json();
    const robloxUser = await robloxResponse.json();
    const player = clanData.data?.player;

    if (!player) {
        throw new Error('Player was not found in the clan data.');
    }

    return {
        displayName: robloxUser.displayName || robloxUser.name,
        username: robloxUser.name,
        points: player.ActiveBattlePoints,
        clan: player.Clan?.Name || null
    };
}

async function getClanData(clanId = 'c0ld') {
    const [clanResponse, playersResponse] = await Promise.all([
        fetch(`https://ps99.biggamesapi.io/api/clan/${encodeURIComponent(clanId)}`),
        fetch('https://ps99.biggamesapi.io/v1/clans/players')
    ]);

    if (!clanResponse.ok || !playersResponse.ok) {
        throw new Error('Could not load clan roster.');
    }

    const clanResult = await clanResponse.json();
    const playersResult = await playersResponse.json();
    const clan = clanResult.data;
    const playerLookup = new Map(
        (playersResult.data?.players || [])
            .filter(player => player.Clan?.Name?.toLowerCase() === clan.Name.toLowerCase())
            .map(player => [player.UserID, player])
    );
    // The owner is returned separately by this endpoint, not inside Members.
    const memberIds = [...new Set([clan.Owner, ...clan.Members.map(member => member.UserID)])];
    const requiresRobloxLookup = memberIds.filter(userId => {
        const name = playerLookup.get(userId)?.DisplayName;
        return !name || name === String(userId);
    });
    // Do not delay the live points response for names. Missing names are resolved
    // in the background and are available from the cache on a later refresh.
    const robloxNames = new Map(
        requiresRobloxLookup
            .filter(userId => nameCache.has(userId))
            .map(userId => [userId, nameCache.get(userId)])
    );
    if (requiresRobloxLookup.length) {
        void resolveRobloxNames(requiresRobloxLookup);
    }
    const cachedAvatars = new Map(
        memberIds.filter(userId => avatarCache.has(userId)).map(userId => [userId, avatarCache.get(userId)])
    );
    void resolveRobloxAvatars(memberIds);

    const rankedMembers = addActivityStats(addHourlyGains(memberIds.map(userId => {
        const player = playerLookup.get(userId);
        return {
            userId,
            displayName: player?.DisplayName && player.DisplayName !== String(userId)
                ? player.DisplayName
                : robloxNames.get(userId) || String(userId),
                username: player?.DisplayName || null,
                group: clan.Name,
                avatarUrl: cachedAvatars.get(userId) || null,
                points: player?.ActiveBattlePoints || 0
        };
    })), clanActivityState).sort((a, b) => b.points - a.points);

    return {
        name: clan.Name,
        groupLabel: 'Clan',
        memberCount: memberIds.length,
        updatedAt: getPointUpdatedAt(`clan:${clan.Name.toLowerCase()}`, rankedMembers),
        members: rankedMembers
    };
}

loadState();

const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (accessKeys.length && !isAccessAuthorized(request)) {
        if (url.pathname === '/access' && request.method === 'POST') {
            try {
                const form = new URLSearchParams(await readRequestBody(request));
                if (keyIsValid(form.get('key'))) {
                    const token = crypto.randomBytes(32).toString('hex');
                    accessSessions.set(token, Date.now() + accessSessionLifetimeMs);
                    response.writeHead(303, {
                        Location: '/',
                        'Set-Cookie': `tracker_access=${token}; Max-Age=${accessSessionLifetimeMs / 1000}; Path=/; HttpOnly; Secure; SameSite=Lax`
                    });
                    response.end();
                    return;
                }
            } catch (error) {
                console.warn('Access key request failed:', error.message);
            }
            renderAccessPage(response, true);
            return;
        }

        if (url.pathname === '/access') {
            renderAccessPage(response);
            return;
        }

        response.writeHead(303, { Location: '/access', 'Cache-Control': 'no-store' });
        response.end();
        return;
    }

    if (url.pathname === '/' || url.pathname === '/Tracking.html') {
        fs.readFile(htmlPath, (error, html) => {
            if (error) {
                response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                response.end('Could not read Tracking.html.');
                return;
            }

            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(html);
        });
        return;
    }

    if (url.pathname === '/favicon.svg') {
        fs.readFile(faviconPath, (error, icon) => {
            if (error) {
                response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                response.end('Favicon not found.');
                return;
            }
            response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=604800' });
            response.end(icon);
        });
        return;
    }

    if (url.pathname === '/api/clan') {
        const clanId = url.searchParams.get('name') || 'c0ld';
        if (!/^[a-zA-Z0-9_-]{1,32}$/.test(clanId)) {
            response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ error: 'Invalid clan tag.' }));
            return;
        }
        try {
            const data = await getClanData(clanId);
            response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify(data));
        } catch (error) {
            response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    if (url.pathname === '/api/league') {
        try {
            const data = await getLeagueData();
            response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify(data));
        } catch (error) {
            response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    if (url.pathname === '/api/league/enchants') {
        try {
            const data = await getLeagueEnchantLoadouts();
            response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify(data));
        } catch (error) {
            response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    const historyMatch = url.pathname.match(/^\/api\/history\/(\d+)$/);
    if (historyMatch) {
        const historyStore = url.searchParams.get('scope') === 'league'
            ? leaguePointHistory
            : pointHistory;
        const history = historyStore.get(Number(historyMatch[1])) || [];
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ history }));
        return;
    }

    const match = url.pathname.match(/^\/api\/player\/(\d+)$/);
    if (!match) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not found.');
        return;
    }

    try {
        const data = await getPlayerData(match[1]);
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(data));
    } catch (error) {
        response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: error.message }));
    }
});

server.listen(port, () => {
    console.log(`Tracker running at http://localhost:${port}`);
});

process.on('SIGINT', () => {
    console.log('\nSaving tracker state…');
    saveState().finally(() => server.close(() => process.exit(0)));
});
