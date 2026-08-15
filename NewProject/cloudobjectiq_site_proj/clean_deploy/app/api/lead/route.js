// app/api/lead/route.js
import { promises as fs } from "fs";
import path from "path";

export async function POST(request) {
  try {
    const data = await request.json();
    const leadsFile = path.join(process.cwd(), "data", "leads.json");
    let leads = [];
    try {
      const existing = await fs.readFile(leadsFile, "utf-8");
      leads = JSON.parse(existing);
    } catch (e) {
      // file may not exist yet
    }
    leads.push({ ...data, submittedAt: new Date().toISOString() });
    await fs.mkdir(path.dirname(leadsFile), { recursive: true });
    await fs.writeFile(leadsFile, JSON.stringify(leads, null, 2), "utf-8");
    return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
