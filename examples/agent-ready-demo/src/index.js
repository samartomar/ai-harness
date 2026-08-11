import http from "node:http";

const port = Number(process.env.PORT ?? 3000);

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      service: "agent-ready-demo",
      status: "ok",
      message: "A tiny app used to demonstrate AI-Harness repository bootstrapping."
    })
  );
});

server.listen(port, () => {
  console.log(`agent-ready-demo listening on http://localhost:${port}`);
});
