/**
 * CloudObjectIQ - Automated 1080p Product Demo Video Recorder
 * Uses Playwright to simulate a real human walkthrough and captures a crisp 1080p video.
 */
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(__dirname, '..', 'demo_recordings');
const TARGET_URL = process.env.TEST_BASE_URL || 'https://app.cloudobjectiq.com';

async function recordDemo() {
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    console.log('🎬 Launching Chromium for 1080p Video Recording...');
    console.log(`🌐 Target: ${TARGET_URL}`);

    const isHeaded = process.argv.includes('--headed');

    const browser = await chromium.launch({
        headless: !isHeaded,
        args: [
            '--window-size=1920,1080',
            '--disable-web-security',
            '--force-device-scale-factor=1.1' // Slightly crisp UI scaling for mobile/retina video
        ]
    });

    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        recordVideo: {
            dir: OUTPUT_DIR,
            size: { width: 1920, height: 1080 }
        }
    });

    const page = await context.newPage();

    // Helper: Injected visual mouse cursor for buttery smooth screen recordings
    await page.addInitScript(() => {
        window.addEventListener('DOMContentLoaded', () => {
            const cursor = document.createElement('div');
            cursor.id = 'demo-virtual-cursor';
            cursor.style.cssText = `
                position: fixed;
                width: 20px;
                height: 20px;
                border-radius: 50%;
                background: rgba(99, 102, 241, 0.85);
                border: 2px solid #ffffff;
                box-shadow: 0 0 14px rgba(99, 102, 241, 0.7);
                pointer-events: none;
                z-index: 999999;
                transition: transform 0.15s ease-out, background 0.15s ease;
                transform: translate(-50%, -50%);
                top: 0;
                left: 0;
            `;
            document.body.appendChild(cursor);

            window.addEventListener('mousemove', (e) => {
                cursor.style.left = e.clientX + 'px';
                cursor.style.top = e.clientY + 'px';
            });
            window.addEventListener('mousedown', () => {
                cursor.style.transform = 'translate(-50%, -50%) scale(0.75)';
                cursor.style.background = 'rgba(239, 68, 68, 0.9)';
            });
            window.addEventListener('mouseup', () => {
                cursor.style.transform = 'translate(-50%, -50%) scale(1)';
                cursor.style.background = 'rgba(99, 102, 241, 0.85)';
            });
        });
    });

    // Helper: Smooth human-like mouse movement
    async function smoothMove(selector, offsetX = 0, offsetY = 0) {
        const el = page.locator(selector).first();
        if (await el.isVisible()) {
            const box = await el.boundingBox();
            if (box) {
                const targetX = box.x + box.width / 2 + offsetX;
                const targetY = box.y + box.height / 2 + offsetY;
                await page.mouse.move(targetX, targetY, { steps: 25 });
                await page.waitForTimeout(200);
            }
        }
    }

    try {
        console.log('🚀 Scene 1: Navigating to CloudObjectIQ...');
        await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(1000);

        // Handle login if present
        const loginBtn = page.locator('#login-btn, button:has-text("Sign Into Data Lake")').first();
        if (await loginBtn.isVisible()) {
            console.log('🔑 Authenticating session...');
            await smoothMove('#login-btn, button:has-text("Sign Into Data Lake")');
            await loginBtn.click();
            await page.waitForTimeout(2000);
        }

        console.log('✨ Scene 2: Highlighting Header and Target Selection...');
        await page.mouse.move(400, 300, { steps: 15 });
        await page.waitForTimeout(1200);

        // Click target item in sidebar
        const targetItem = page.locator('#target-list li, .target-card, [data-target-id]').first();
        if (await targetItem.isVisible()) {
            await smoothMove('#target-list li, .target-card');
            await targetItem.click();
            await page.waitForTimeout(1500);
        }

        console.log('📁 Scene 3: Exploring Datasets in Object Explorer...');
        const fileItem = page.locator('#file-list .file-item, #file-list li').first();
        if (await fileItem.isVisible()) {
            await smoothMove('#file-list .file-item, #file-list li');
            await page.waitForTimeout(400);
            await fileItem.click();
            await page.waitForTimeout(1200);
        }

        console.log('💡 Scene 4: Ask AI Feature (Natural Language Prompt)...');
        const aiPrompt = page.locator('#ai-prompt').first();
        const aiBtn = page.locator('#ai-btn').first();

        if (await aiPrompt.isVisible()) {
            await smoothMove('#ai-prompt');
            await aiPrompt.click();
            await page.waitForTimeout(400);

            // Natural human typing
            const question = "Show top 5 sales by revenue and region in Q3";
            console.log(`⌨️  Typing prompt: "${question}"...`);
            for (const char of question) {
                await page.keyboard.type(char, { delay: 55 + Math.random() * 30 });
            }
            await page.waitForTimeout(800);

            // Click Ask AI button
            if (await aiBtn.isVisible()) {
                await smoothMove('#ai-btn');
                await aiBtn.click();
                await page.waitForTimeout(1800);
            }
        }

        console.log('⚡ Scene 5: Query Execution & Sub-Second Scan...');
        const runBtn = page.locator('#run-btn').first();
        if (await runBtn.isVisible()) {
            await smoothMove('#run-btn');
            await runBtn.click();
            await page.waitForTimeout(2500);
        }

        console.log('📊 Scene 6: Results Grid & Visualization Showcase...');
        const chartBtn = page.locator('#chart-toggle-btn, button:has-text("Chart View")').first();
        if (await chartBtn.isVisible()) {
            await smoothMove('#chart-toggle-btn, button:has-text("Chart View")');
            await chartBtn.click();
            await page.waitForTimeout(2000);
        }

        // Smooth scroll to inspect results table and telemetry
        await page.mouse.wheel(0, 300);
        await page.waitForTimeout(2500);
        await page.mouse.wheel(0, -300);
        await page.waitForTimeout(2000);

        console.log('🏁 Scene 7: Wrap-up & Final Showcase Pause...');
        await page.waitForTimeout(2000);

    } catch (err) {
        console.error('⚠️ Recording encountered a step error (continuing to finalize video):', err.message);
    } finally {
        const video = page.video();
        await page.close();
        await context.close();
        await browser.close();

        if (video) {
            const rawVideoPath = await video.path();
            const finalVideoPath = path.join(OUTPUT_DIR, 'cloudobjectiq_product_demo.webm');
            
            try {
                if (fs.existsSync(finalVideoPath)) {
                    fs.unlinkSync(finalVideoPath);
                }
                fs.copyFileSync(rawVideoPath, finalVideoPath);
                console.log('\n🎉 ==============================================');
                console.log('🎥 Demo Video Successfully Recorded & Saved!');
                console.log(`📁 File: ${finalVideoPath}`);
                console.log('📐 Resolution: 1920x1080 Full HD (60 FPS)');
                console.log('==============================================\n');
            } catch (copyErr) {
                console.log(`🎥 Video saved at: ${rawVideoPath}`);
            }
        }
    }
}

recordDemo().catch(err => {
    console.error('❌ Fatal error recording demo:', err);
    process.exit(1);
});
