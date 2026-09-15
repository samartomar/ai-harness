/** Native Cursor A→B→A startup-guidance acceptance over public-delivered roots. */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createSecureServer } from "node:http2";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const CURSOR = "/home/aih-probe/runtime/cursor-2026.09.10-fd3934a/extracted/dist-package/cursor-agent";
const NODE = "/home/aih-probe/runtime/node/node-v24.18.0-linux-x64/bin/node";
const POINTER = "ai-coding/RULE_ROUTER.md";
const PORT = 43832;
const MAX_COMPRESSED_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_DECOMPRESSED_FRAME_BYTES = 8 * 1024 * 1024;
const KNOWN_EMPTY = new Set(["GetManagedSkills", "GetEffectiveUserPlugins", "GetUserPrivacyMode", "GetMe", "ListMarketplaces", "GetServerConfig", "GetTeamAdminSettingsOrEmptyIfNotInTeam", "GetTeamReposOrEmptyIfNotInTeam", "GetGlobalCommands", "GetCliDownloadUrl"]);

function fail(message) { throw new Error(`native-cursor-policy-delivery: ${message}`); }
function assertion(value, message) { if (!value) fail(message); }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function bytes(value) { return Buffer.isBuffer(value) ? value : Buffer.from(value); }
function vi(value) { const out = []; do { const byte = value % 128; value = Math.floor(value / 128); out.push(byte + (value ? 128 : 0)); } while (value); return Buffer.from(out); }
function field(no, value) { const valueBytes = bytes(value); return Buffer.concat([vi(no * 8 + 2), vi(valueBytes.length), valueBytes]); }
function number(no, value) { return Buffer.concat([vi(no * 8), vi(value)]); }
function message(...parts) { return Buffer.concat(parts); }
function frame(response, payload, flag = 0) { const header = Buffer.alloc(5); header[0] = flag; header.writeUInt32BE(payload.length, 1); response.write(Buffer.concat([header, payload])); }

function protobufFields(source) {
  const fields = []; let offset = 0;
  const variable = () => { let value = 0; let multiplier = 1; for (let count = 0; count < 10; count += 1) { if (offset >= source.length) throw new Error("truncated-varint"); const byte = source[offset++]; value += (byte & 127) * multiplier; if (!(byte & 128)) return value; multiplier *= 128; } throw new Error("varint-limit"); };
  while (offset < source.length) { const tag = variable(); const no = Math.floor(tag / 8); const wire = tag % 8; if (!no) throw new Error("invalid-tag"); let value; if (wire === 0) value = variable(); else if (wire === 2) { const length = variable(); if (offset + length > source.length) throw new Error("truncated-field"); value = source.subarray(offset, offset + length); offset += length; } else if (wire === 1 || wire === 5) { const length = wire === 1 ? 8 : 4; if (offset + length > source.length) throw new Error("truncated-fixed-field"); value = source.subarray(offset, offset + length); offset += length; } else throw new Error("unsupported-wire"); fields.push({ no, wire, value }); }
  return fields;
}
function get(fields, no) { return fields.find((value) => value.no === no)?.value; }
function text(fields, no) { const value = get(fields, no); return Buffer.isBuffer(value) ? value.toString("utf8") : undefined; }
function nested(fields, no) { const value = get(fields, no); if (!Buffer.isBuffer(value)) throw new Error(`missing-message-${no}`); return protobufFields(value); }

function parse(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--provider") return { provider: resolve(argv[++index] ?? "") };
    if (key === "--help") { process.stdout.write("Usage: node tools/verify-policy-delivery-native-cursor.mjs --roots ROOT_A,ROOT_B --output ABSOLUTE_RESULT\n"); process.exit(0); }
    if (!key.startsWith("--") || argv[index + 1] === undefined) fail("expected option values");
    values[key.slice(2)] = argv[++index];
  }
  if (typeof values.output !== "string" || (typeof values.roots !== "string" && typeof values.one !== "string")) fail("--roots and --output are required");
  const roots = typeof values.one === "string" ? [resolve(values.one)] : values.roots.split(",").map((root) => resolve(root));
  if (typeof values.one !== "string" && (roots.length !== 3 || roots[0] !== roots[2] || roots[0] === roots[1])) fail("--roots must be distinct A,B,A roots");
  return { roots, output: resolve(values.output) };
}

async function provider(configPath) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  let stage = 0;
  let notesSessionId;
  const server = createSecureServer({ key: readFileSync(config.key), cert: readFileSync(config.cert), allowHTTP1: true }, (request, response) => {
    const run = request.url === "/agent.v1.AgentService/Run";
    let pending = Buffer.alloc(0);
    if (run) { emit({ type: "provider-run", route: request.url, httpVersion: request.httpVersion, requestCompression: request.headers["connect-content-encoding"] }); response.writeHead(200, { "content-type": "application/connect+proto", "connect-protocol-version": "1" }); }
    const complete = () => { frame(response, field(1, field(1, field(1, "fixture complete")))); frame(response, field(1, field(14, Buffer.alloc(0)))); frame(response, Buffer.from("{}"), 2); response.end(); };
    const requestRead = (id, source) => frame(response, field(2, message(number(1, id), field(15, `fixture-read-${id}`), field(7, message(field(1, source), field(2, `fixture-read-${id}`))))));
    const requestContext = () => frame(response, field(2, message(number(1, 4), field(15, "fixture-context"), field(10, field(2, notesSessionId)))));
    const dispatch = (payload) => {
      const fields = protobufFields(payload);
      if (get(fields, 1)) {
        const initial = payload.toString("utf8");
        const runRequest = nested(fields, 1);
        notesSessionId = text(runRequest, 5);
        const action = nested(runRequest, 2);
        const userAction = nested(action, 1);
        const inlineContext = get(userAction, 2);
        const referenceBytes = get(action, 17);
        const type = stage === 0 ? "initial-request" : "restart-initial-request";
        emit({ type, pointerPresent: initial.includes(POINTER), policyGuidancePresent: initial.includes("policy-required-guidance.md"), requiredSkillPresent: initial.includes(config.skillName), runRequestFields: runRequest.map((entry) => entry.no), actionFields: action.map((entry) => entry.no), userActionFields: userAction.map((entry) => entry.no), hasInlineContext: Buffer.isBuffer(inlineContext), hasContextReferences: Buffer.isBuffer(referenceBytes), excludeWorkspaceContext: get(runRequest, 12), initialSha256: hash(payload), initialBytes: payload.length, printableStrings: initial.match(/[ -~]{8,}/g) ?? [] });
        if (stage !== 0) throw new Error("unexpected-run-restart-before-context-resolution");
        if (Buffer.isBuffer(inlineContext) || Buffer.isBuffer(referenceBytes)) throw new Error("unexpected-nonlegacy-context-transport");
        if (typeof notesSessionId !== "string" || notesSessionId === "") throw new Error("startup-context-session-id-missing");
        stage = 1.5;
        requestContext();
        return;
      }
      if (get(fields, 2)) {
        const execution = nested(fields, 2); const id = get(execution, 1);
        emit({ type: "execution", stage, id, fields: execution.map((entry) => entry.no) });
        if (stage === 1.5 && id === 4) {
          const execId = text(execution, 15);
          if (execId !== undefined && execId !== "fixture-context") throw new Error("native-context-result-correlation-mismatch");
          emit({ type: "native-context-correlation", id, execId, execIdCorrelation: execId === undefined ? "omitted-by-client" : "matched" });
          const contextResult = nested(execution, 10);
          if (!get(contextResult, 1)) throw new Error("native-context-result-not-success");
          const context = get(nested(contextResult, 1), 1);
          if (!Buffer.isBuffer(context)) throw new Error("native-context-result-missing-context");
          const contextFields = protobufFields(context);
          const rules = contextFields.filter((entry) => entry.no === 2 && Buffer.isBuffer(entry.value)).map((entry) => protobufFields(entry.value));
          const skills = contextFields.filter((entry) => entry.no === 29 && Buffer.isBuffer(entry.value)).map((entry) => protobufFields(entry.value));
          const expectedRuleBody = Buffer.from(config.reads[0].bodyBase64, "base64").toString("utf8");
          const selectedRule = rules.find((rule) => text(rule, 1) === config.reads[0].absolutePath);
          const selectedSkill = skills.find((skill) => text(skill, 1) === config.reads[2].absolutePath);
          const selectedRuleBody = text(selectedRule ?? [], 2);
          const ruleValues = { bridgeBodyNormalizedEquivalent: selectedRuleBody?.trimEnd() === expectedRuleBody.trimEnd(), rulePathExact: Boolean(selectedRule), pointerPresent: selectedRuleBody?.includes(POINTER) === true, policyGuidancePresent: selectedRuleBody?.includes("policy-required-guidance.md") === true, selectedRuleBodySha256: selectedRuleBody === undefined ? undefined : hash(selectedRuleBody), expectedRuleBodySha256: hash(expectedRuleBody), selectedRuleBodyBytes: selectedRuleBody === undefined ? undefined : Buffer.byteLength(selectedRuleBody), expectedRuleBodyBytes: Buffer.byteLength(expectedRuleBody), contextSha256: hash(context), contextBytes: context.length };
          const skillValues = { skillPathExact: Boolean(selectedSkill), requiredSkillPresent: text(selectedSkill ?? [], 1)?.includes(config.skillName) === true, description: text(selectedSkill ?? [], 3) };
          emit({ type: "native-rules-blob", transport: "legacy-request-context", ...ruleValues });
          emit({ type: "native-skills-blob", transport: "legacy-request-context", ...skillValues });
          if (!ruleValues.bridgeBodyNormalizedEquivalent || !ruleValues.pointerPresent || !ruleValues.policyGuidancePresent || !skillValues.requiredSkillPresent) throw new Error("native-legacy-context-missing-selected-guidance");
          stage = 2.5;
          requestRead(5, config.reads[1].absolutePath);
          return;
        }
        if (stage < 2.5 || !Number.isInteger(id) || id !== 5 + (stage - 2.5)) throw new Error("unexpected-execution-order");
        const readIndex = 1 + (stage - 2.5);
        const expectedExecId = `fixture-read-${id}`;
        const execId = text(execution, 15);
        if (execId !== undefined && execId !== expectedExecId) throw new Error("native-read-result-correlation-mismatch");
        const result = nested(execution, 7);
        if (!get(result, 1)) throw new Error("native-read-result-not-success");
        const success = nested(result, 1);
        const context = get(success, 2) ?? get(success, 5);
        if (!Buffer.isBuffer(context)) throw new Error("native-read-result-missing-content");
        const expectedRead = config.reads[readIndex];
        const values = { id, execId, execIdCorrelation: execId === undefined ? "omitted-by-client" : "matched", returnedPath: text(success, 1), requestedPath: expectedRead.absolutePath, pathExact: text(success, 1) === expectedRead.absolutePath, contentExact: context.equals(Buffer.from(expectedRead.base64, "base64")), contentSha256: hash(context), contentBytes: context.length };
        const type = readIndex === 1 ? "native-policy-guidance-read" : readIndex === 2 ? "native-skill-read" : "native-selected-content-read";
        emit({ type, ...values });
        if (!values.pathExact || !values.contentExact) throw new Error("native-selected-guidance-read-mismatch");
        if (readIndex + 1 < config.reads.length) { stage += 1; requestRead(5 + (readIndex), config.reads[readIndex + 1].absolutePath); return; }
        stage = 3; complete();
        return;
      }
    };
    request.on("data", (chunk) => {
      try {
        pending = Buffer.concat([pending, chunk]);
        if (pending.length > MAX_PENDING_REQUEST_BYTES) throw new Error("request-buffer-limit");
        while (run && pending.length >= 5) { const size = pending.readUInt32BE(1); if (size > MAX_COMPRESSED_FRAME_BYTES) throw new Error("request-frame-limit"); if (pending.length < size + 5) return; const flag = pending[0]; const payload = pending.subarray(5, size + 5); pending = pending.subarray(size + 5); emit({ type: "incoming-frame", flag, size }); if (flag === 0) dispatch(payload); else if (flag === 1) { if (request.headers["connect-content-encoding"] !== "gzip") throw new Error("unsupported-request-compression"); dispatch(gunzipSync(payload, { maxOutputLength: MAX_DECOMPRESSED_FRAME_BYTES })); } else throw new Error("unsupported-request-frame-flag"); }
      } catch (error) { emit({ type: "provider-error", message: error instanceof Error ? error.message : String(error) }); response.end(); }
    });
    request.on("end", () => {
      if (run) return;
      const method = request.url?.split("/").at(-1);
      if (request.url === "/auth/exchange_user_api_key") { const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url"); response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ accessToken: `${part({ alg: "none" })}.${part({ exp: 4102444800 })}.`, refreshToken: "fixture" })); }
      else if (request.url?.includes(".AnalyticsService/")) { response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); }
      else if (KNOWN_EMPTY.has(method)) { response.writeHead(200, { "content-type": "application/proto" }); response.end(); }
      else if (["AvailableModels", "GetUsableModels", "GetDefaultModelForCli"].includes(method)) { response.writeHead(200, { "content-type": "application/proto" }); response.end(method === "AvailableModels" ? field(1, "fixture-model") : field(1, field(1, "fixture-model"))); }
      else { emit({ type: "unknown-route", route: request.url }); response.writeHead(501, { "content-type": "application/json" }); response.end(JSON.stringify({ code: "unimplemented", message: "fixture route unavailable" })); }
    });
  });
  server.on("error", (error) => emit({ type: "server-error", message: error.message }));
  server.on("session", (session) => session.on("error", (error) => emit({ type: "session-error", message: error.message })));
  server.on("connection", (socket) => emit({ type: "tcp-connection", remoteAddress: socket.remoteAddress }));
  server.on("secureConnection", (socket) => emit({ type: "tls-secure", protocol: socket.getProtocol(), authorized: socket.authorized }));
  server.on("tlsClientError", (error) => emit({ type: "tls-client-error", code: error.code, message: error.message }));
  server.listen(PORT, "127.0.0.1", () => emit({ type: "provider-ready" }));
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}

function rootSnapshot(root) {
  const bridge = join(root, ".cursor", "rules", "00-canon.mdc");
  const guidance = join(root, "ai-coding", "policy-required-guidance.md");
  const skillName = basename(root).toLowerCase().startsWith("harbor") ? "tdd-workflow" : "security-review";
  const skill = join(root, ".cursor", "skills", skillName, "SKILL.md");
  const bridgeBytes = readFileSync(bridge); const guidanceBytes = readFileSync(guidance); const skillBytes = readFileSync(skill);
  const bridgeText = bridgeBytes.toString("utf8");
  const frontmatterEnd = bridgeText.indexOf("\n---\n", 4);
  assertion(bridgeText.startsWith("---\n") && frontmatterEnd >= 0, "Cursor bridge frontmatter is malformed");
  const bridgeBody = bridgeText.slice(frontmatterEnd + 5).replace(/^\n/, "");
  const readRegularFileNoFollow = (file) => {
    let descriptor;
    try {
      descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ELOOP") return undefined;
      throw error;
    }
    try {
      if (!fstatSync(descriptor).isFile()) return undefined;
      return readFileSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  };
  const cursorTree = (path, prefix = "") => readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const relative = `${prefix}${entry.name}`; const full = join(path, entry.name);
    if (entry.isDirectory()) return cursorTree(full, `${relative}/`);
    const content = readRegularFileNoFollow(full);
    return [content === undefined ? `${relative}:unsupported` : `${relative}:${hash(content)}`];
  }).sort();
  const receipt = JSON.parse(readFileSync(join(root, "ai-coding", "policy-required-guidance.receipt.json"), "utf8"));
  const selected = [...new Set(receipt.components.flatMap((component) => component.paths)
    .filter((path) => path.startsWith(".cursor/") && path.endsWith(".md") && !path.includes("/skills/")))].sort();
  return {
    bridge,
    guidance,
    skill,
    skillName,
    bridgeSha256: hash(bridgeBytes),
    guidanceSha256: hash(guidanceBytes),
    skillSha256: hash(skillBytes),
    cursorTree: cursorTree(join(root, ".cursor")),
    reads: [
      { path: ".cursor/rules/00-canon.mdc", base64: bridgeBytes.toString("base64"), bodyBase64: Buffer.from(bridgeBody).toString("base64") },
      { path: "ai-coding/policy-required-guidance.md", base64: guidanceBytes.toString("base64") },
      { path: `.cursor/skills/${skillName}/SKILL.md`, base64: skillBytes.toString("base64") },
      ...selected.map((path) => ({ path, base64: readFileSync(join(root, path)).toString("base64") })),
    ],
  };
}

async function runRoot(root, ordinal) {
  const source = rootSnapshot(root);
  const fixture = mkdtempSync(join(tmpdir(), `aih-cursor-guidance-${ordinal}-`));
  const home = join(fixture, "home");
  const key = join(home, "localhost.key"); const cert = join(home, "localhost.crt");
  const configPath = join(fixture, "fixture.json");
  const result = { root, skill: source.skillName, bridge: source.bridge, guidance: source.guidance, bridgeSha256: source.bridgeSha256, guidanceSha256: source.guidanceSha256, skillSha256: source.skillSha256, status: "failed", sourceUnchanged: false, explicitReadOnlyTrust: true, providerEvents: [], providerStderr: "" };
  let provider;
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const certificate = spawnSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { stdio: "ignore" });
    assertion(certificate.status === 0, "certificate generation failed");
    writeFileSync(configPath, JSON.stringify({ root, key, cert, skillName: source.skillName, reads: source.reads.map((entry) => ({ ...entry, absolutePath: join(root, entry.path) })) }), { mode: 0o600 });
    const env = { PATH: "/home/aih-probe/runtime/node/node-v24.18.0-linux-x64/bin:/home/aih-probe/runtime/bin:/usr/bin:/bin", HOME: home, USER: "aih-probe", LOGNAME: "aih-probe", CURSOR_CONFIG_DIR: join(home, ".cursor"), XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"), CURSOR_API_KEY: "fixture-key", CURSOR_API_ENDPOINT: `https://127.0.0.1:${PORT}`, NODE_EXTRA_CA_CERTS: cert, CI: "1", NO_COLOR: "1", TERM: "dumb" };
    for (const directory of [env.CURSOR_CONFIG_DIR, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME]) mkdirSync(directory, { recursive: true, mode: 0o700 });
    provider = spawn(NODE, [resolve(process.argv[1]), "--provider", configPath], { env, stdio: ["ignore", "pipe", "pipe"] });
    let client; let pending = ""; provider.stdout.on("data", (chunk) => { pending += chunk; for (;;) { const index = pending.indexOf("\n"); if (index < 0) break; const line = pending.slice(0, index); pending = pending.slice(index + 1); try { const event = JSON.parse(line); result.providerEvents.push(event); if (event.type === "provider-error" && client?.pid) client.kill("SIGTERM"); } catch {} } });
    provider.stderr.on("data", (chunk) => (result.providerStderr = (result.providerStderr + chunk).slice(-4000)));
    const readyAt = Date.now() + 5000; while (!result.providerEvents.some((event) => event.type === "provider-ready") && Date.now() < readyAt) await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
    assertion(result.providerEvents.some((event) => event.type === "provider-ready"), "provider did not start");
    client = spawn(CURSOR, ["--print", "--trust", "--force", "--mode", "ask", "--model", "fixture-model", "Give a concise status update."], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let stderr = ""; client.stdout.on("data", (chunk) => (output += chunk)); client.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-4000)));
    const exited = await new Promise((resolveExit) => { const timer = setTimeout(() => { client.kill("SIGKILL"); resolveExit({ code: null, timeout: true }); }, 40000); client.once("close", (code) => { clearTimeout(timer); resolveExit({ code, timeout: false }); }); client.once("error", () => { clearTimeout(timer); resolveExit({ code: null, timeout: false }); }); });
    const initial = result.providerEvents.find((event) => event.type === "initial-request");
    const rules = result.providerEvents.find((event) => event.type === "native-rules-blob");
    const skills = result.providerEvents.find((event) => event.type === "native-skills-blob");
    const guidanceRead = result.providerEvents.find((event) => event.type === "native-policy-guidance-read");
    const skillRead = result.providerEvents.find((event) => event.type === "native-skill-read");
    const selectedReads = result.providerEvents.filter((event) => event.type === "native-selected-content-read");
    result.client = { ...exited, output, stderr };
    result.initialRequestWasContextFree = initial?.pointerPresent === false;
    result.nativeContextPointer = rules?.pointerPresent === true;
    result.nativePolicyGuidanceInstruction = rules?.policyGuidancePresent === true;
    result.nativeRequiredSkillIdentity = skills?.requiredSkillPresent === true;
    result.nativeParsedBridgeBodyNormalizedEquivalent = rules?.bridgeBodyNormalizedEquivalent === true;
    result.nativeGuidanceReadExact = guidanceRead?.contentExact === true && guidanceRead?.pathExact === true;
    result.nativeSkillReadExact = skillRead?.contentExact === true && skillRead?.pathExact === true;
    result.nativeSelectedContentReadsExact = selectedReads.length === source.reads.length - 3 && selectedReads.every((event) => event.contentExact === true && event.pathExact === true);
    result.sourceUnchanged = hash(readFileSync(source.bridge)) === source.bridgeSha256 && hash(readFileSync(source.guidance)) === source.guidanceSha256 && hash(readFileSync(source.skill)) === source.skillSha256 && JSON.stringify(rootSnapshot(root).cursorTree) === JSON.stringify(source.cursorTree);
    result.status = exited.code === 0 && !exited.timeout && result.initialRequestWasContextFree && result.nativeContextPointer && result.nativePolicyGuidanceInstruction && result.nativeRequiredSkillIdentity && result.nativeParsedBridgeBodyNormalizedEquivalent && result.nativeGuidanceReadExact && result.nativeSkillReadExact && result.nativeSelectedContentReadsExact && result.sourceUnchanged ? "passed" : "failed";
  } catch (error) { result.failure = error instanceof Error ? error.message : String(error); }
  finally {
    provider?.kill("SIGTERM");
    if (result.status === "passed") rmSync(fixture, { recursive: true, force: true });
    else result.retainedDiagnosticFixture = fixture;
  }
  return result;
}

async function main() {
  const parsed = parse(process.argv.slice(2));
  if (parsed.provider) return provider(parsed.provider);
  assertion(process.platform === "linux", "requires native Linux or WSL2 execution");
  const version = spawnSync(CURSOR, ["--version"], { encoding: "utf8" });
  assertion(version.status === 0 && version.stdout.trim() !== "", "Cursor version inspection failed");
  const binaryHash = spawnSync("/usr/bin/sha256sum", [CURSOR], { encoding: "utf8" });
  assertion(binaryHash.status === 0 && /^[a-f0-9]{64}\s/.test(binaryHash.stdout), "Cursor binary hash inspection failed");
  const report = { schemaVersion: 1, purpose: "native Cursor public-guidance A-to-B-to-A startup through legacy RequestContext plus exact native required-file reads", cursor: { path: CURSOR, version: version.stdout.trim(), sha256: binaryHash.stdout.slice(0, 64) }, roots: parsed.roots, status: "failed", runs: [] };
  for (let index = 0; index < parsed.roots.length; index += 1) report.runs.push(await runRoot(parsed.roots[index], index));
  report.status = report.runs.every((run) => run.status === "passed") ? "passed" : "failed";
  writeFileSync(parsed.output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ status: report.status, output: parsed.output })}\n`);
  process.exitCode = report.status === "passed" ? 0 : 1;
}

await main();
