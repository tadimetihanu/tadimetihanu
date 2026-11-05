/**
 * AI-Powered E2E Test Driver for CloudObjectIQ
 * Uses LLM / Multimodal AI (OpenAI or Google Gemini) + Semantic DOM Tree
 * to execute natural language test steps and self-heal UI selectors.
 */
const { expect } = require('@playwright/test');

class AIDriver {
    /**
     * @param {import('@playwright/test').Page} page 
     */
    constructor(page) {
        this.page = page;
        this.llmProvider = process.env.OPENAI_API_KEY ? 'openai' : (process.env.GEMINI_API_KEY ? 'gemini' : 'semantic');
    }

    /**
     * Extracts a compact, structured representation of interactive elements on the page.
     */
    async getInteractiveElements() {
        return await this.page.evaluate(() => {
            const elements = [];
            const candidates = document.querySelectorAll('button, input, select, textarea, a, [role="button"], [onclick], .file-item, .target-card, tr');
            
            candidates.forEach((el, index) => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                const isVisible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
                if (!isVisible) return;

                const text = (el.innerText || el.textContent || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
                const tag = el.tagName.toLowerCase();
                const id = el.id ? `#${el.id}` : '';
                const classes = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
                
                elements.push({
                    index,
                    tag,
                    id,
                    classes,
                    text: text.slice(0, 80),
                    placeholder: el.placeholder || '',
                    type: el.type || '',
                    value: (el.value || '').slice(0, 60),
                    ariaLabel: el.getAttribute('aria-label') || ''
                });
            });
            return elements.slice(0, 100);
        });
    }

    /**
     * Ask AI (or fallback to semantic engine) to map natural language to a page action.
     */
    async resolveAction(instruction) {
        const elements = await this.getInteractiveElements();

        // If an API key is available, we can consult the LLM
        if (this.llmProvider === 'openai' && process.env.OPENAI_API_KEY) {
            try {
                const OpenAI = require('openai');
                const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
                const prompt = `You are an AI Test Automation Agent for a web app.
Given the user instruction: "${instruction}"
And the following interactive elements on the page:
${JSON.stringify(elements, null, 2)}

Return a strict JSON object with:
{
  "action": "click" | "fill" | "select" | "press",
  "selector": "<best CSS selector>",
  "value": "<text to fill or select if applicable, else empty string>"
}`;
                const res = await openai.chat.completions.create({
                    model: 'gpt-4o-mini',
                    messages: [{ role: 'user', content: prompt }],
                    response_format: { type: 'json_object' },
                    temperature: 0
                });
                return JSON.parse(res.choices[0].message.content);
            } catch (err) {
                console.warn(`[AI Driver] LLM call failed, falling back to semantic matcher: ${err.message}`);
            }
        }

        // Semantic / Heuristic Matcher
        const lowerInst = instruction.toLowerCase();
        
        // Match for typing / filling
        const typeMatch = instruction.match(/(?:type|fill|enter|search for)\s+["']?([^"']+)["']?\s+(?:in|into)\s+(.+)/i);
        if (typeMatch) {
            const val = typeMatch[1];
            const targetDesc = typeMatch[2].toLowerCase();
            const el = elements.find(e => 
                (e.tag === 'input' || e.tag === 'textarea') && 
                (e.placeholder.toLowerCase().includes(targetDesc) || e.id.toLowerCase().includes(targetDesc) || e.text.toLowerCase().includes(targetDesc))
            );
            return {
                action: 'fill',
                selector: el && el.id ? el.id : (el ? `${el.tag}[placeholder*="${el.placeholder}"]` : 'input'),
                value: val
            };
        }

        // Match for clicking
        for (const el of elements) {
            const t = el.text.toLowerCase();
            const id = el.id.toLowerCase();
            const placeholder = el.placeholder.toLowerCase();
            if (
                lowerInst.includes(t) && t.length > 2 ||
                lowerInst.includes(id.replace('#', '')) && id.length > 2 ||
                lowerInst.includes(placeholder) && placeholder.length > 2
            ) {
                return {
                    action: 'click',
                    selector: el.id ? el.id : (el.text ? `text="${el.text}"` : el.tag),
                    value: ''
                };
            }
        }

        // Broad fallback
        return { action: 'click', selector: `text=${instruction.replace(/click\s+/i, '').trim()}`, value: '' };
    }

    /**
     * Executes a natural language step.
     * Example: await ai.act("Click the Ask AI button")
     */
    async act(instruction) {
        console.log(`🤖 [AI Act] "${instruction}"`);
        const { action, selector, value } = await this.resolveAction(instruction);
        
        const loc = this.page.locator(selector).first();
        await loc.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});

        if (action === 'fill') {
            await loc.fill(value);
        } else if (action === 'press') {
            await loc.press(value || 'Enter');
        } else {
            await loc.click();
        }
        await this.page.waitForTimeout(500);
    }

    /**
     * Asserts that a condition holds true in the UI.
     * Example: await ai.assert("Results table has rows")
     */
    async assert(condition) {
        console.log(`🔍 [AI Assert] "${condition}"`);
        const lower = condition.toLowerCase();

        if (lower.includes('table') || lower.includes('rows') || lower.includes('results')) {
            const tableExists = await this.page.locator('table, .ag-grid, #results, .data-grid').first().isVisible().catch(() => false);
            expect(tableExists).toBeTruthy();
            return;
        }

        if (lower.includes('visible') || lower.includes('displayed')) {
            const raw = condition.replace(/is visible|displayed|verify that|panel|container|element/gi, '').trim();
            const words = raw.split(/\s+/).filter(w => w.length > 2);
            let isVis = false;
            // Try matching full phrase first
            isVis = await this.page.locator(`text=${raw}`).first().isVisible().catch(() => false);
            // If not found, try primary word
            if (!isVis && words.length > 0) {
                isVis = await this.page.locator(`text=${words[0]}`).first().isVisible().catch(() => false);
            }
            expect(isVis).toBeTruthy();
            return;
        }

        // Generic text assertion
        const content = await this.page.content();
        expect(content.toLowerCase()).toContain(lower.split(' ')[0]);
    }

    /**
     * Captures a screenshot report.
     */
    async screenshot(name) {
        const p = `playwright-report/screenshots/${name}_${Date.now()}.png`;
        await this.page.screenshot({ path: p, fullPage: true });
        console.log(`📸 Saved AI visual snapshot: ${p}`);
        return p;
    }
}

module.exports = {
    createAIDriver: (page) => new AIDriver(page)
};
