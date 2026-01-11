require('dotenv').config();
const fastify = require('fastify')({ logger: true });
const cors = require('@fastify/cors');
const admin = require('firebase-admin');

// 1. Initialize Firebase Admin
try {
    const serviceAccount = require('./service-account.json');
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('✅ Firebase Admin Initialized');
} catch (error) {
    console.error('❌ Error initializing Firebase Admin. Make sure service-account.json exists:', error.message);
}

const db = admin.firestore();

// 2. Register Middleware
fastify.register(cors, {
    origin: true // In production, restrict this to your dashboard URL
});

// 3. Routes
fastify.get('/health', async () => {
    return { status: 'ok', firebase: admin.apps.length > 0 };
});

// ENDPOINT: Get Feedback
fastify.get('/api/feedback', async (request, reply) => {
    try {
        const snapshot = await db.collection('feedback')
            .orderBy('createdAt', 'desc')
            .get();

        const feedback = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            // Ensure timestamp is serializable
            createdAt: doc.data().createdAt?.toDate() || null
        }));

        return feedback;
    } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to fetch feedback' });
    }
});

// ENDPOINT: Get Stats aggregated from Game Server and Firestore
fastify.get('/api/stats', async (request, reply) => {
    try {
        const GAME_SERVER_URL = process.env.GAME_SERVER_URL || 'https://impostor.me';

        // 1. Fetch live stats from Game Server
        let liveStats = {
            connectedUsers: 0,
            activeMatches: 0,
            usersInLobby: 0,
            usersInMatch: 0
        };

        try {
            const gameServerResponse = await fetch(`${GAME_SERVER_URL}/api/stats`);
            if (gameServerResponse.ok) {
                const data = await gameServerResponse.json();
                liveStats = {
                    connectedUsers: data.connectedUsers,
                    activeMatches: data.activeMatches,
                    usersInLobby: data.usersInLobby,
                    usersInMatch: data.usersInMatch
                };
            }
        } catch (e) {
            console.error('⚠️ Could not fetch live stats from Game Server:', e.message);
        }

        // 2. Fetch historical peak stats from Firestore (last 7 days)
        const historySnapshot = await db.collection('peak_stats')
            .orderBy('date', 'desc')
            .limit(7)
            .get();

        const history = historySnapshot.docs.map(doc => doc.data()).reverse();
        console.log(`📊 [Stats API] History count: ${history.length}`);
        if (history.length > 0) console.log(`📊 [Stats API] Sample history date: ${history[0].date}`);

        // 3. Overall counters
        const totalUsers = (await db.collection('player_stats').count().get()).data().count;
        const totalMatches = (await db.collection('matches').count().get()).data().count;

        const result = {
            live: liveStats,
            history: history,
            totalUsers,
            totalMatches,
            // Still returning legacy fields for compatibility during transition
            activeUsers: liveStats.connectedUsers,
            avgTime: "12m",
            winRatio: "48%"
        };

        console.log(`📊 [Stats API] Final result:`, JSON.stringify(result, null, 2).substring(0, 500) + '...');
        return result;
    } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to fetch dashboard stats' });
    }
});

// =====================
// ANALYTICS ENDPOINTS
// =====================

// ENDPOINT: Game Balance Analytics
fastify.get('/api/analytics/balance', async (request, reply) => {
    try {
        // Sample recent matches for statistics (last 1000 for performance)
        const matchesSnapshot = await db.collection('matches')
            .orderBy('endedAt', 'desc')
            .limit(1000)
            .get();

        const matches = matchesSnapshot.docs.map(doc => doc.data());

        if (matches.length === 0) {
            return {
                impostorWinRate: 0,
                avgDurationMinutes: 0,
                abandonmentRate: 0,
                sampleSize: 0
            };
        }

        // Calculate impostor win rate
        const impostorWins = matches.filter(m => m.winningTeam === 'impostor').length;
        const friendsWins = matches.filter(m => m.winningTeam === 'friends').length;
        const validMatches = impostorWins + friendsWins;
        const impostorWinRate = validMatches > 0 ? (impostorWins / validMatches) * 100 : 0;

        // Calculate average duration
        const matchesWithDuration = matches.filter(m => m.startedAt && m.endedAt);
        const totalDuration = matchesWithDuration.reduce((sum, m) => {
            return sum + (m.endedAt - m.startedAt);
        }, 0);
        const avgDurationMs = matchesWithDuration.length > 0 ? totalDuration / matchesWithDuration.length : 0;
        const avgDurationMinutes = avgDurationMs / 60000;

        // Calculate abandonment rate
        let totalPlayers = 0;
        let abandonedPlayers = 0;
        matches.forEach(m => {
            if (m.players && Array.isArray(m.players)) {
                m.players.forEach(p => {
                    totalPlayers++;
                    if (p.abandoned) abandonedPlayers++;
                });
            }
        });
        const abandonmentRate = totalPlayers > 0 ? (abandonedPlayers / totalPlayers) * 100 : 0;

        return {
            impostorWinRate: Math.round(impostorWinRate * 10) / 10,
            avgDurationMinutes: Math.round(avgDurationMinutes * 10) / 10,
            abandonmentRate: Math.round(abandonmentRate * 10) / 10,
            sampleSize: matches.length
        };
    } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to fetch balance analytics' });
    }
});

// ENDPOINT: Top Players
fastify.get('/api/analytics/players', async (request, reply) => {
    try {
        // Top 10 by points
        const topByPointsSnapshot = await db.collection('player_stats')
            .orderBy('points', 'desc')
            .limit(10)
            .get();

        const topByPoints = topByPointsSnapshot.docs.map(doc => ({
            uid: doc.id,
            ...doc.data()
        }));

        // Top 10 by games played
        const topByGamesSnapshot = await db.collection('player_stats')
            .orderBy('gamesPlayed', 'desc')
            .limit(10)
            .get();

        const topByGames = topByGamesSnapshot.docs.map(doc => ({
            uid: doc.id,
            ...doc.data()
        }));

        return {
            topByPoints,
            topByGames
        };
    } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to fetch player analytics' });
    }
});

// ENDPOINT: Activity/Engagement Analytics
fastify.get('/api/analytics/activity', async (request, reply) => {
    try {
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const weekAgoStart = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);

        // DAU: Users who played today
        const dauSnapshot = await db.collection('player_stats')
            .where('lastPlayedAt', '>=', todayStart)
            .count()
            .get();
        const dau = dauSnapshot.data().count;

        // WAU: Users who played in last 7 days
        const wauSnapshot = await db.collection('player_stats')
            .where('lastPlayedAt', '>=', weekAgoStart)
            .count()
            .get();
        const wau = wauSnapshot.data().count;

        // New users today
        const newTodaySnapshot = await db.collection('player_stats')
            .where('firstSeenAt', '>=', todayStart)
            .count()
            .get();
        const newUsersToday = newTodaySnapshot.data().count;

        // Total users
        const totalUsersSnapshot = await db.collection('player_stats').count().get();
        const totalUsers = totalUsersSnapshot.data().count;

        return {
            dau,
            wau,
            newUsersToday,
            totalUsers,
            dauWauRatio: wau > 0 ? Math.round((dau / wau) * 100) : 0
        };
    } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to fetch activity analytics' });
    }
});

// 4. Start Server
const start = async () => {
    try {
        await fastify.listen({ port: 3001, host: '0.0.0.0' });
        console.log('🚀 Admin Server running at http://localhost:3001');
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();
