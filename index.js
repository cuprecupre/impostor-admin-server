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
            .limit(50)
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

// ENDPOINT: Get Stats
fastify.get('/api/stats', async (request, reply) => {
    try {
        const usersCount = (await db.collection('users').count().get()).data().count;
        const matchesCount = (await db.collection('matches').count().get()).data().count;

        return {
            activeUsers: usersCount,
            totalMatches: matchesCount,
            avgTime: "15m",
            winRatio: "52%"
        };
    } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Failed to fetch stats' });
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
