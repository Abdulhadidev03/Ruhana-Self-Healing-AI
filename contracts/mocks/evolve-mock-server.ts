// Standalone HTTP wrapper around EvolveMock so your partner (Part B) and the
// runtime can exercise the wire contracts:  npm run mock:evolve
import { createServer } from "node:http";
import { EvolveMock } from "./evolve-mock.ts";

const mock = new EvolveMock();
const port = Number(process.env.PORT ?? 4820);

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  const repairsMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/repairs$/);

  if (req.method === "POST" && url.pathname === "/api/evidence/turn") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const result = mock.receiveEvidence(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ accepted: false, error: "invalid JSON" }));
      }
    });
    return;
  }

  if (req.method === "GET" && repairsMatch) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(mock.getRepairs(repairsMatch[1]!)));
    return;
  }

  // Test-only helper endpoint to stage a released repair.
  if (req.method === "POST" && repairsMatch) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const overlay = mock.releaseRepair(repairsMatch[1]!, JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(overlay));
    });
    return;
  }

  res.writeHead(404);
  res.end();
}).listen(port, () => {
  console.log(`evolve-mock listening on http://localhost:${port}`);
});
