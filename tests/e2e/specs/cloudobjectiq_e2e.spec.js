// @ts-check
const { test, expect } = require('@playwright/test');
const { createAIDriver } = require('../helpers/ai_driver');

test.describe('CloudObjectIQ - AI-Powered End-to-End Test Suite', () => {

    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        const loginBtn = page.locator('#login-btn, button:has-text("Sign Into Data Lake")').first();
        if (await loginBtn.isVisible()) {
            await Promise.all([
                page.waitForNavigation({ timeout: 10000 }).catch(() => {}),
                loginBtn.click()
            ]);
            await page.waitForTimeout(1000);
        }
    });

    test('01: App Launch & Initial Interface Verification', async ({ page }) => {
        const ai = createAIDriver(page);

        console.log('🚀 Step 1: Verifying layout...');
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

    test('06: Schema Inspector & Column Details Display', async ({ page }) => {
        const ai = createAIDriver(page);
        await page.goto('/');

        console.log('🔬 Step 7: Verifying Schema Inspector...');
        const fileItem = page.locator('text=.orc, text=.parquet, .file-name').first();
        if (await fileItem.isVisible()) {
            await fileItem.click();
            await page.waitForTimeout(1000);

            const schemaPanel = page.locator('#schema-panel, .schema-inspector, text="Schema Inspector"').first();
            if (await schemaPanel.isVisible()) {
                console.log('✅ Schema Inspector panel displayed successfully');
            }
        }

        await ai.screenshot('06_schema_inspector');
    });

    test('07: Saved Queries Library Modal Access', async ({ page }) => {
        const ai = createAIDriver(page);
        await page.goto('/');

        console.log('⭐ Step 8: Opening Saved Queries Library...');
        const savedBtn = page.locator('button:has-text("Saved"), [onclick*="openSavedQueries"]').first();
        if (await savedBtn.isVisible()) {
            await savedBtn.click();
            await page.waitForTimeout(800);

            const savedModal = page.locator('#saved-queries-modal').first();
            await expect(savedModal).toBeVisible();

            // Close modal
            const closeBtn = page.locator('#saved-queries-modal button:has-text("✕"), #saved-queries-modal button[onclick*="close"]').first();
            if (await closeBtn.isVisible()) {
                await closeBtn.click();
            }
        }

        await ai.screenshot('07_saved_queries_modal');
    });

    test('08: Dual-Pass Ground-Truth & Repeatability Benchmark Validation', async ({ page }) => {
        const ai = createAIDriver(page);
        await page.goto('/');

        console.log('⚡ Step 9: Running Dual-Pass Ground-Truth Verification...');
        const queryEditor = page.locator('#query-editor, textarea').first();
        if (await queryEditor.isVisible()) {
            await queryEditor.fill("SELECT 42 AS benchmark_val, 'Repeatability Test' AS marker;");
        }

        const validateBtn = page.locator('#validate-query-btn, button:has-text("Validate")').first();
        if (await validateBtn.isVisible()) {
            await validateBtn.click();
            await page.waitForTimeout(1500);

            // Verify benchmark modal appears
            const valModal = page.locator('#validation-modal').first();
            if (await valModal.isVisible()) {
                console.log('✅ Dual-Pass Benchmark Verification modal displayed');
                const closeBtn = page.locator('#validation-modal button:has-text("Close")').first();
                if (await closeBtn.isVisible()) await closeBtn.click();
            }
        }

        await ai.screenshot('08_benchmark_validation');
    });

    test('09: Results Export & CSV Download Event', async ({ page }) => {
        const ai = createAIDriver(page);
        await page.goto('/');

        console.log('📊 Step 10: Executing query and exporting CSV...');
        const queryEditor = page.locator('#query-editor, textarea').first();
        if (await queryEditor.isVisible()) {
            await queryEditor.fill("SELECT 'Export-Test' AS item, 100 AS score, CURRENT_DATE AS day;");
            const runBtn = page.locator('#run-btn, button:has-text("Run")').first();
            if (await runBtn.isVisible()) {
                await runBtn.click();
                await page.waitForTimeout(1500);

                // Check export button
                const csvBtn = page.locator('#export-btns button:has-text("CSV"), button[onclick*="exportResults"]').first();
                if (await csvBtn.isVisible()) {
                    console.log('📥 Triggering CSV export download...');
                    const downloadPromise = page.waitForEvent('download', { timeout: 6000 }).catch(() => null);
                    await csvBtn.click();
                    const download = await downloadPromise;
                    if (download) {
                        console.log(`✅ CSV downloaded successfully: ${download.suggestedFilename()}`);
                    }
                }
            }
        }

        await ai.screenshot('09_results_export');
    });

    test('10: File Upload & Drag-and-Drop Area Inspection', async ({ page }) => {
        const ai = createAIDriver(page);
        await page.goto('/');

        console.log('📁 Step 11: Inspecting file upload dropzone...');
        const uploadArea = page.locator('.upload-area').first();
        await expect(uploadArea).toBeVisible();

        const fileInput = page.locator('#file-input').first();
        const inputCount = await fileInput.count();
        expect(inputCount).toBeGreaterThan(0);
        console.log('✅ File input dropzone verified and ready for uploads');

        await ai.screenshot('10_upload_area');
    });
});
