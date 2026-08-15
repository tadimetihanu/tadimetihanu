
try {
    const { OpenAI } = require('openai');
    console.log("OpenAI module found");
} catch (e) {
    console.error("OpenAI module NOT found:", e.message);
}
