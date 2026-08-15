const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

async function test() {
    console.log("Testing Internal API Health without auth...");
    const res = await fetch(`http://localhost:8000/api/v1/health`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    });
    console.log("Status:", res.status);
    console.log("Body:", await res.text());

    console.log("Testing Internal API workspace/list without auth...");
    const wRes = await fetch(`http://localhost:8000/api/v1/workspaces/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    });
    console.log("Status:", wRes.status);
    console.log("Body:", await wRes.text());
}

test().catch(console.error);
