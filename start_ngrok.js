const ngrok = require('@ngrok/ngrok');
require('dotenv').config();

async function startTunnel() {
    const authtoken = process.env.NGROK_AUTHTOKEN || '3I1gQXvu3xoo2jYoqfrLh1nOQNb_3fm9JGe9rzUs1aX1LZ7BA';
    const domain = process.env.NGROK_DOMAIN;
    const port = process.env.PORT || 4000;

    console.log('🚀 [Ngrok] Initializing official ngrok tunnel on port ' + port + '...');
    try {
        let listener;
        if (domain) {
            try {
                console.log(`🏷️ Attempting to bind custom domain: ${domain}`);
                listener = await ngrok.forward({ addr: port, authtoken, domain });
            } catch (domainErr) {
                console.warn(`⚠️ Custom domain '${domain}' requires a paid Ngrok plan. Falling back to assigned static domain...`);
                listener = await ngrok.forward({ addr: port, authtoken });
            }
        } else {
            listener = await ngrok.forward({ addr: port, authtoken });
        }

        const publicUrl = listener.url();
        console.log('===================================================');
        console.log('✅ OFFICIAL NGROK TUNNEL ONLINE');
        console.log(`🌐 Public URL: ${publicUrl}`);
        console.log(`📡 Forwarding to: http://localhost:${port}`);
        console.log('===================================================');

        // Keep process alive
        process.stdin.resume();
    } catch (err) {
        console.error('❌ [Ngrok] Tunnel start failed:', err.message);
        process.exit(1);
    }
}

startTunnel();
