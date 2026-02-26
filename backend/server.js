require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const twilio = require('twilio');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Twilio client
const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

// WhatsApp sender number (must be registered with Twilio)
const FROM_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886';

// Middleware
app.use(cors());
app.use(express.json());

// Rate limiting to prevent abuse
const limiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 10, // Limit each IP to 10 requests per windowMs
    message: { error: 'Too many requests, please try again later.' }
});

app.use('/api/', limiter);

// In-memory store for recent alerts (for debouncing)
const recentAlerts = new Map();

// Validation function
function validatePhoneNumber(phone) {
    // E.164 format validation
    const e164Regex = /^\+?[1-9]\d{1,14}$/;
    return e164Regex.test(phone.replace(/\s/g, ''));
}

// Format phone number to E.164
function formatPhoneNumber(phone) {
    let cleaned = phone.replace(/\D/g, '');
    if (!cleaned.startsWith('+')) {
        // Assume US number if no country code provided
        if (cleaned.length === 10) {
            cleaned = '1' + cleaned;
        }
        cleaned = '+' + cleaned;
    }
    return cleaned;
}

// Send WhatsApp message via Twilio
async function sendWhatsAppMessage(to, message) {
    try {
        const formattedNumber = formatPhoneNumber(to);

        const result = await client.messages.create({
            body: message,
            from: FROM_NUMBER,
            to: `whatsapp:${formattedNumber}`
        });

        return {
            success: true,
            sid: result.sid,
            status: result.status
        };
    } catch (error) {
        console.error('Twilio Error:', error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

// API Routes

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Send emergency alert
app.post('/api/send-alert', async (req, res) => {
    try {
        const { contacts, location, timestamp, userName } = req.body;

        // Validate required fields
        if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
            return res.status(400).json({ error: 'No contacts provided' });
        }

        if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number') {
            return res.status(400).json({ error: 'Invalid location data' });
        }

        // Check for recent alerts (debounce)
        const alertKey = `${timestamp}-${location.lat.toFixed(3)}-${location.lng.toFixed(3)}`;
        if (recentAlerts.has(alertKey)) {
            return res.status(429).json({ error: 'Duplicate alert detected. Please wait before sending another alert.' });
        }

        // Add to recent alerts
        recentAlerts.set(alertKey, Date.now());

        // Clean up old entries (older than 5 minutes)
        const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
        for (const [key, time] of recentAlerts.entries()) {
            if (time < fiveMinutesAgo) {
                recentAlerts.delete(key);
            }
        }

        // Create message content
        const mapsLink = `https://maps.google.com/?q=${location.lat},${location.lng}`;
        const formattedTime = new Date(timestamp).toLocaleString();

        const message = `🚨 *EMERGENCY ALERT* 🚨

An accident has been detected for *${userName || 'User'}*!

📍 *Location:* ${mapsLink}
🕐 *Time:* ${formattedTime}

⚠️ *IMPORTANT:* This is an automated emergency alert. Please respond or dispatch help immediately!

---
Sent via Smart Accident Alert System`;

        // Send messages to all contacts
        const results = [];
        for (const contact of contacts) {
            const phone = contact.phone || contact;
            const name = contact.name || 'Emergency Contact';

            if (!validatePhoneNumber(phone)) {
                results.push({
                    phone,
                    name,
                    success: false,
                    error: 'Invalid phone number format'
                });
                continue;
            }

            const result = await sendWhatsAppMessage(phone, message);
            results.push({
                phone,
                name,
                ...result
            });

            // Small delay between messages to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        // Determine overall status
        const successful = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;

        res.json({
            success: true,
            message: `Alerts sent: ${successful} successful, ${failed} failed`,
            results,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Server Error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Send test message
app.post('/api/test-message', async (req, res) => {
    try {
        const { phone, name } = req.body;

        if (!phone) {
            return res.status(400).json({ error: 'Phone number required' });
        }

        const formattedPhone = formatPhoneNumber(phone);

        const message = `🧪 *Test Message*\n\nThis is a test from the Smart Accident Alert System.\n\nIf you receive this, your WhatsApp integration is working correctly!\n\n✅ System Status: Operational`;

        const result = await sendWhatsAppMessage(formattedPhone, message);

        res.json({
            success: result.success,
            message: result.success ? 'Test message sent!' : 'Failed to send test message',
            details: result
        });

    } catch (error) {
        console.error('Test Error:', error);
        res.status(500).json({ error: 'Failed to send test message' });
    }
});

// Get Twilio webhook status
app.get('/api/status', (req, res) => {
    res.json({
        status: 'operational',
        twilioConfigured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
        features: {
            emergencyAlerts: true,
            testMessages: true,
            rateLimiting: true
        }
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Accident Alert Backend Server running on port ${PORT}`);
    console.log(`📱 WhatsApp integration: ${process.env.TWILIO_ACCOUNT_SID ? 'Configured' : 'Not configured'}`);
});
