import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createSecureServer } from "node:http2";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { basename, join, resolve } from "node:path";
const PORT = 43833,
  CURSOR =
    "/home/aih-probe/runtime/cursor-2026.09.10-fd3934a/extracted/dist-package/cursor-agent",
  NODE = "/home/aih-probe/runtime/node/node-v24.18.0-linux-x64/bin/node";
const MAX_COMPRESSED_FRAME_BYTES = 4 * 1024 * 1024,
  MAX_PENDING_REQUEST_BYTES = 8 * 1024 * 1024,
  MAX_DECOMPRESSED_FRAME_BYTES = 8 * 1024 * 1024;
const fail = (x) => {
    throw Error(`native-cursor-mcp: ${x}`);
  },
  assert = (x, m) => {
    if (!x) fail(m);
  },
  hash = (x) => createHash("sha256").update(x).digest("hex"),
  b = (x) => (Buffer.isBuffer(x) ? x : Buffer.from(x)),
  vi = (n) => {
    const o = [];
    do {
      const q = n % 128;
      n = Math.floor(n / 128);
      o.push(q + (n ? 128 : 0));
    } while (n);
    return Buffer.from(o);
  },
  f = (n, x) => Buffer.concat([vi(n * 8 + 2), vi(b(x).length), b(x)]),
  num = (n, x) => Buffer.concat([vi(n * 8), vi(x)]),
  msg = (...x) => Buffer.concat(x),
  frame = (r, p, flag = 0) => {
    assert(p.length <= MAX_COMPRESSED_FRAME_BYTES, "response-frame-limit");
    const h = Buffer.alloc(5);
    h[0] = flag;
    h.writeUInt32BE(p.length, 1);
    r.write(Buffer.concat([h, p]));
  };
function fields(s) {
  let i = 0,
    o = [];
  const v = () => {
    let n = 0,
      m = 1;
    for (let k = 0; k < 10; k++) {
      if (i >= s.length) throw Error("truncated");
      const z = s[i++];
      n += (z & 127) * m;
      if (!(z & 128)) return n;
      m *= 128;
    }
    throw Error("varint");
  };
  while (i < s.length) {
    const t = v(),
      n = Math.floor(t / 8),
      w = t % 8;
    if (!n) throw Error("invalid-tag");
    let x;
    if (w === 0) x = v();
    else if (w === 2) {
      const l = v();
      if (i + l > s.length) throw Error("truncated-field");
      x = s.subarray(i, i + l);
      i += l;
    } else if (w === 1 || w === 5) {
      const l = w === 1 ? 8 : 4;
      if (i + l > s.length) throw Error("truncated-fixed-field");
      x = s.subarray(i, i + l);
      i += l;
    } else throw Error("wire");
    o.push({ n, w, x });
  }
  return o;
}
const get = (x, n) => x.find((y) => y.n === n)?.x,
  str = (x, n) => {
    const v = get(x, n);
    return Buffer.isBuffer(v) ? v.toString("utf8") : undefined;
  },
  nested = (x, n) => fields(get(x, n));
function parse(a) {
  const v = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--help") {
      process.stdout.write(
        "Usage: node tools/verify-policy-delivery-native-mcp-cursor.mjs --root ROOT --output FILE\n",
      );
      process.exit();
    }
    if (!a[i].startsWith("--") || a[i + 1] === undefined) fail("args");
    v[a[i].slice(2)] = a[++i];
  }
  assert(v.root && v.output, "root/output");
  return { root: resolve(v.root), output: resolve(v.output) };
}
function snapshot(root) {
  const paths = [".cursor/mcp.json", ".aih-config.json"];
  return Object.fromEntries(
    paths.map((p) => [
      p,
      existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : null,
    ]),
  );
}
function parseGraphResult(content) {
  return JSON.parse(content.split("\n<mcp-structured-result>", 1)[0]);
}
async function provider(cfg, events) {
  let stage = 0,
    tools = {};
  const server = createSecureServer(
    {
      key: readFileSync(cfg.key),
      cert: readFileSync(cfg.cert),
      allowHTTP1: true,
    },
    (req, res) => {
      let p = Buffer.alloc(0),
        run = req.url === "/agent.v1.AgentService/Run";
      if (run) {
        events.push({
          type: "provider-run",
          httpVersion: req.httpVersion,
          requestCompression: req.headers["connect-content-encoding"],
        });
        res.writeHead(200, {
          "content-type": "application/connect+proto",
          "connect-protocol-version": "1",
        });
      }
      const emit = (x) => events.push(x);
      function call(which) {
        const t = tools[which];
        assert(t, `missing tool ${which}`);
        const input =
          which === "build"
            ? { repo_root: cfg.root, full_rebuild: true }
            : { repo_root: cfg.root };
        const a = msg(
          f(1, t.name),
          f(2, msg(f(1, "repo_root"), f(2, f(3, cfg.root)))),
          ...(which === "build"
            ? [f(2, msg(f(1, "full_rebuild"), f(2, num(4, 1))))]
            : []),
          f(3, `fixture-${which}`),
          f(4, t.provider),
          f(5, t.toolName),
          f(9, t.server),
        );
        const id = which === "build" ? 2 : 4;
        stage = which === "build" ? 1 : 2;
        emit({ type: "request-mcp", which, tool: t, input });
        frame(res, f(2, msg(num(1, id), f(15, `fixture-${which}`), f(11, a))));
      }
      function dispatch(q) {
        const x = fields(q);
        if (stage === 0 && get(x, 1)) {
          frame(
            res,
            f(
              2,
              msg(
                num(1, 3),
                f(15, "fixture-state"),
                f(36, f(1, "code-review-graph")),
              ),
            ),
          );
          stage = 0.5;
          return;
        }
        if (!get(x, 2)) return;
        const e = nested(x, 2),
          id = get(e, 1),
          eid = str(e, 15);
        emit({
          type: "exec-received",
          stage,
          id,
          execId: eid,
          execIdCorrelation:
            eid === undefined ? "omitted-by-client" : "present",
          fields: e.map((z) => z.n),
        });
        if (stage === 0.5) {
          assert(id === 3, "state id");
          assert(
            eid === undefined || eid === "fixture-state",
            "state correlation",
          );
          const stateResult = nested(e, 36);
          assert(get(stateResult, 1), "native mcp state error");
          const state = nested(stateResult, 1),
            servers = state.filter((z) => z.n === 1).map((z) => fields(z.x)),
            srv = servers.find((z) => str(z, 2) === "code-review-graph");
          assert(srv, "native code-review-graph not discovered");
          const defs = srv
            .filter((z) => z.n === 5)
            .map((z) => fields(z.x))
            .map((z) => ({
              name: str(z, 1),
              provider: str(z, 4),
              toolName: str(z, 5),
              server: str(srv, 2),
            }));
          emit({ type: "mcp-state", definitions: defs });
          tools.build = defs.find(
            (z) => z.toolName === "build_or_update_graph_tool",
          );
          tools.stats = defs.find(
            (z) => z.toolName === "list_graph_stats_tool",
          );
          assert(tools.build && tools.stats, "required graph tools missing");
          call("build");
          return;
        }
        const which = stage === 1 ? "build" : "stats",
          expectedId = stage === 1 ? 2 : 4;
        assert(id === expectedId, "mcp id correlation");
        assert(
          eid === undefined || eid === `fixture-${which}`,
          "mcp exec id correlation",
        );
        const result = nested(e, 11);
        assert(get(result, 1), "native mcp error");
        const success = nested(result, 1);
        assert((get(success, 2) ?? 0) === 0, "native mcp is_error");
        const content = success
          .filter((z) => z.n === 1)
          .map((z) => fields(z.x))
          .map((z) => {
            const q = get(z, 1);
            return q ? str(fields(q), 1) : undefined;
          })
          .filter(Boolean);
        assert(content.length > 0, "empty mcp result");
        const graphs = content.map(parseGraphResult);
        assert(
          graphs.every((value) => value?.status === "ok"),
          "graph mcp reported failure",
        );
        assert(
          which !== "stats" ||
            graphs.some((value) => value.summary?.includes(basename(cfg.root))),
          "graph stats root mismatch",
        );
        emit({
          type: "mcp-result",
          which,
          id,
          execId: eid,
          execIdCorrelation:
            eid === undefined ? "omitted-by-client" : "matched",
          content,
          graphs,
        });
        if (stage === 1) {
          call("stats");
          return;
        }
        frame(res, f(1, f(1, f(1, "fixture complete"))));
        frame(res, f(1, f(14, Buffer.alloc(0))));
        frame(res, Buffer.from("{}"), 2);
        res.end();
        stage = 3;
      }
      req.on("data", (c) => {
        try {
          p = Buffer.concat([p, c]);
          assert(p.length <= MAX_PENDING_REQUEST_BYTES, "request-buffer-limit");
          while (run && p.length >= 5) {
            const l = p.readUInt32BE(1);
            assert(l <= MAX_COMPRESSED_FRAME_BYTES, "request-frame-limit");
            if (p.length < l + 5) return;
            const q = p.subarray(5, l + 5),
              flag = p[0];
            p = p.subarray(l + 5);
            emit({ type: "incoming-frame", flag, size: l });
            if (flag === 0) dispatch(q);
            else if (flag === 1) {
              assert(
                req.headers["connect-content-encoding"] === "gzip",
                "unsupported request compression",
              );
              dispatch(
                gunzipSync(q, {
                  maxOutputLength: MAX_DECOMPRESSED_FRAME_BYTES,
                }),
              );
            } else fail("unsupported request frame flag");
          }
        } catch (e) {
          emit({
            type: "provider-error",
            message: e instanceof Error ? e.message : String(e),
          });
          res.end();
        }
      });
      req.on("end", () => {
        if (run) return;
        const method = req.url?.split("/").at(-1);
        if (req.url === "/auth/exchange_user_api_key") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            '{"accessToken":"eyJhbGciOiJub25lIn0.eyJleHAiOjQxMDI0NDQ4MDB9.","refreshToken":"fixture"}',
          );
        } else if (
          [
            "AvailableModels",
            "GetUsableModels",
            "GetDefaultModelForCli",
          ].includes(method)
        ) {
          res.writeHead(200, { "content-type": "application/proto" });
          res.end(
            method === "AvailableModels"
              ? f(1, "fixture-model")
              : f(1, f(1, "fixture-model")),
          );
        } else {
          res.writeHead(200, { "content-type": "application/proto" });
          res.end();
        }
      });
    },
  );
  await new Promise((ok, bad) => {
    server.once("error", bad);
    server.listen(PORT, "127.0.0.1", ok);
  });
  return server;
}
async function main() {
  const { root, output } = parse(process.argv.slice(2));
  assert(
    process.platform === "linux" && existsSync(root) && !existsSync(output),
    "platform/root/output",
  );
  const before = snapshot(root),
    events = [],
    home = mkdtempSync(join(tmpdir(), "aih-cursor-mcp-")),
    key = join(home, "k"),
    cert = join(home, "c");
  const report = {
    home,
    schemaVersion: 1,
    purpose:
      "native Cursor code-review-graph MCP build and stats via public projected config",
    root,
    before,
    publicConfigSha256: Object.fromEntries(
      Object.entries(before).map(([path, value]) => [
        path,
        value === null ? null : hash(value),
      ]),
    ),
    cursor: {
      path: CURSOR,
      sha256: hash(readFileSync(CURSOR)),
    },
    node: {
      path: NODE,
      sha256: hash(readFileSync(NODE)),
    },
    status: "failed",
    events,
  };
  try {
    assert(
      spawnSync(
        "/usr/bin/openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          key,
          "-out",
          cert,
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=IP:127.0.0.1",
        ],
        { stdio: "ignore" },
      ).status === 0,
      "cert",
    );
    const env = {
      PATH: "/home/aih-probe/lane4-mcp-runtime/bin:/usr/bin:/bin",
      HOME: home,
      USER: "aih-probe",
      LOGNAME: "aih-probe",
      CURSOR_CONFIG_DIR: join(home, ".cursor"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"),
      UV_CACHE_DIR: "/home/aih-probe/lane4-mcp-runtime/uv-cache",
      CURSOR_API_KEY: "fixture-key",
      CURSOR_API_ENDPOINT: `https://127.0.0.1:${PORT}`,
      NODE_EXTRA_CA_CERTS: cert,
      CI: "1",
      NO_COLOR: "1",
      TERM: "dumb",
    };
    const version = spawnSync(CURSOR, ["--version"], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 8000,
    });
    report.cursor.version = {
      exitCode: version.status,
      stdout: version.stdout,
      stderr: version.stderr,
    };
    assert(version.status === 0, "cursor version");
    const approval = spawnSync(CURSOR, ["mcp", "enable", "code-review-graph"], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 8000,
    });
    report.approval = {
      exitCode: approval.status,
      stdout: approval.stdout,
      stderr: approval.stderr,
    };
    assert(approval.status === 0, "mcp enable");
    mkdirSync(env.XDG_CACHE_HOME, { recursive: true });
    symlinkSync(
      "/home/aih-probe/lane4-mcp-runtime/uv-cache",
      join(env.XDG_CACHE_HOME, "uv"),
    );
    report.uvCacheLink = join(env.XDG_CACHE_HOME, "uv");
    const server = await provider({ root, key, cert }, events);
    try {
      const run = await new Promise((done) => {
        const c = spawn(
          CURSOR,
          [
            "--print",
            "--trust",
            "--force",
            "--approve-mcps",
            "--model",
            "fixture-model",
            "Give a concise status update.",
          ],
          { cwd: root, env },
        );
        let out = "",
          err = "";
        const timer = setTimeout(() => {
          c.kill("SIGKILL");
          done({ timeout: true, code: null, out, err });
        }, 45000);
        c.stdout.on("data", (x) => (out += x));
        c.stderr.on("data", (x) => (err += x));
        c.on("close", (code) => {
          clearTimeout(timer);
          done({ timeout: false, code, out, err });
        });
      });
      report.client = run;
    } finally {
      await new Promise((ok) => server.close(ok));
    }
    report.after = snapshot(root);
    report.configUnchanged =
      JSON.stringify(before) === JSON.stringify(report.after);
    assert(report.client.code === 0 && !report.client.timeout, "client");
    assert(
      events.some((x) => x.type === "mcp-result" && x.which === "build") &&
        events.some((x) => x.type === "mcp-result" && x.which === "stats"),
      "missing native calls",
    );
    assert(!events.some((x) => x.type === "provider-error"), "provider error");
    assert(report.configUnchanged, "public root config changed");
    report.status = "passed";
  } catch (e) {
    report.failure = e.message;
    report.after = snapshot(root);
    report.configUnchanged =
      JSON.stringify(before) === JSON.stringify(report.after);
  } finally {
    // Retain the isolated native home as an evidence artifact.
  }
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  process.stdout.write(
    JSON.stringify({ status: report.status, output }) + "\n",
  );
  process.exitCode = report.status === "passed" ? 0 : 1;
}
await main();
