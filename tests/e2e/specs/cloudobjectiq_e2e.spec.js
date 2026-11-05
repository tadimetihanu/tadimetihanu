// @ts-check
const { test, expect } = require('@playwright/test');
const { createAIDriver } = require('../helpers/ai_driver');

test.describe('CloudObjectIQ - AI-Powered End-to-End Test Suite', () => {

    test('01: App Launch & Initial Interface Verification', async ({ page }) => {
        const ai = createAIDriver(page);

        console.log('🚀 Step 1: Navigating to CloudObjectIQ...');
        await page.goto('/');

        // If login screen is shown, click Sign In and wait for reload
        const loginBtn = page.locator('#login-btn, button:has-text("Sign Into Data Lake")').first();
        if (await loginBtn.isVisible()) {
            console.log('🔑 Authenticating session...');
            await Promise.all([
                page.waitForNavigation({ timeout: 10000 }).catch(() => {}),
                loginBtn.click()
            ]);
            await page.waitForTimeout(1500);
        }

        // Verify page title and main layout elements
        await expect(page).toHaveTitle(/CloudObjectIQ|Data/i);
        await expect(page.getByRole('heading', { name: 'CloudObjectIQ' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Cloud Targets' })).toBeVisible();
        await expect(page.getByText('Object Explorer').locator('visible=true').first()).toBeVisible();

        await ai.screenshot('01_app_launch');
    });

    test('02: Target Selection & ORC File Query Generation', async ({ page }) => {
        const ai = createAIDriver(page);
        await page.goto('/');

        console.log('🎯 Step 2: Selecting Cloud Target...');
        // Locate target (cloudflare1 or first target in list)
        const targetCard = page.locator('.target-item, [onclick*="selectTarget"], #target-list > *').first();
        if (await targetCard.isVisible()) {
            await targetCard.click();
            await page.waitForTimeout(1000);
        }

        console.log('📁 Step 3: Clicking on a file in Object Explorer...');
        // Look for any file item, especially .orc or .parquet
        const orcFile = page.locator('text=.orc, text=.parquet, .file-name').first();
        if (await orcFile.isVisible()) {
            await orcFile.click();
            await page.waitForTimeout(1000);

            // Verify query editor automatically populated with read_orc or read_parquet
            const queryEditor = page.locator('#query-editor, textarea');
            const editorVal = await queryEditor.inputValue().catch(() => '');
            console.log(`📝 Generated SQL: ${editorVal}`);
            expect(editorVal.toLowerCase()).toMatch(/select|read_orc|read_parquet/);
        }

        await ai.screenshot('02_file_selected');
    });

    test('03: Ask AI Feature, Highlighting & Natural Language Workflow', async ({ page }) => {
        const ai = createAIDriver(page);
        await page.goto('/');

        console.log('💡 Step 4: Testing Ask AI button...');
        const askAiBtn = page.locator('#ai-btn, button:has-text("Ask AI")').first();
        if (await askAiBtn.isVisible()) {
            const aiInput = page.locator('#ai-prompt, input[placeholder*="Search here" i]').first();
            await askAiBtn.click();
            await page.waitForTimeout(500);

            if (await aiInput.isVisible()) {
                const isFocused = await aiInput.evaluate(el => el === document.activeElement || el.classList.contains('highlight'));
                console.log(`✨ AI Input focused/highlighted: ${isFocused}`);
                expect(isFocused).toBeTruthy();
            }
        }

        await ai.screenshot('03_ask_ai_highlighted');
    });

    test('04: Query Execution & Results Grid Rendering', async ({ page }) => {
        const ai = createAIDriver(page);
        await page.goto('/');

        console.log('⚡ Step 5: Executing SQL query in editor...');
        const queryEditor = page.locator('#query-editor, textarea').first();
        if (await queryEditor.isVisible()) {
            // Set a guaranteed lightweight query
            await queryEditor.fill("SELECT 1 AS test_id, 'CloudObjectIQ AI Test' AS status, CURRENT_TIMESTAMP AS tested_at;");
            
            const runBtn = page.locator('#run-btn, button:has-text("Run"), button:has-text("Execute")').first();
            if (await runBtn.isVisible()) {
                await runBtn.click();
                await page.waitForTimeout(1500);

                // Verify result grid or status
                const resultsArea = page.locator('#results, .ag-grid, table, .status-bar').first();
                await expect(resultsArea).toBeVisible();
            }
        }

        await ai.screenshot('04_query_executed');
    });

    test('05: Admin Center & Spark Jobs View Access', async ({ page }) => {
        const ai = createAIDriver(page);
        await page.goto('/');

        console.log('🛡️ Step 6: Checking Admin Center Navigation...');
        const adminBtn = page.locator('text="Admin Center", text="Admin", #admin-btn, [onclick*="showAdmin"]').first();
        if (await adminBtn.isVisible()) {
            await adminBtn.click();
            await page.waitForTimeout(1000);

            // Verify admin overlay or tabs (Spark Jobs, Catalog, Telemetry)
            const adminOverlay = page.locator('#admin-overlay, .admin-container, text="Spark Jobs"').first();
            await expect(adminOverlay).toBeVisible();
        }

        await ai.screenshot('05_admin_center');
    });
});
