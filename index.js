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
