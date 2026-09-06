import { spawn, execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Resident memory samples include every descendant, including Chromium processes. */
async function processes() {
  if (process.platform === "win32") {
    const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress";
    const result = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(result.stdout).map((entry) => ({
      pid: Number(entry.ProcessId), parent: Number(entry.ParentProcessId), rss: Number(entry.WorkingSetSize),
    }));
  }
  if (process.platform === "linux") {
    const entries = await readdir("/proc");
    const records = await Promise.all(entries.filter((entry) => /^\d+$/u.test(entry)).map(async (entry) => {
      try {
        const status = await readFile("/proc/" + entry + "/status", "utf8");
        return { pid: Number(entry), parent: Number(/^PPid:\s+(\d+)/mu.exec(status)?.[1]),
          rss: Number(/^VmRSS:\s+(\d+)/mu.exec(status)?.[1] ?? 0) * 1024 };
      } catch (error) {
        if (error.code === "ENOENT" || error.code === "ESRCH") return undefined;
        throw error;
      }
    }));
    return records.filter(Boolean);
  }
  const result = await execute("ps", ["-axo", "pid=,ppid=,rss="], { maxBuffer: 8 * 1024 * 1024 });
  return result.stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [pid, parent, kib] = line.trim().split(/\s+/u).map(Number);
    return { pid, parent, rss: kib * 1024 };
  });
}

function residentTree(records, rootPid) {
  const children = new Map();
  for (const record of records) {
    const group = children.get(record.parent) ?? [];
    group.push(record);
    children.set(record.parent, group);
  }
  const root = records.find((record) => record.pid === rootPid);
  const queue = root ? [root] : [];
  const seen = new Set();
  let bytes = 0;
  while (queue.length) {
    const record = queue.pop();
    if (seen.has(record.pid)) continue;
    seen.add(record.pid);
    bytes += record.rss;
    queue.push(...(children.get(record.pid) ?? []));
  }
  return { bytes, processCount: seen.size };
}

/** Sampling is explicit, best-effort at 250 ms plus OS-query cost; failures are fatal. */
export async function measureProcess(command, args, options = {}) {
  const started = performance.now();
  const child = spawn(command, args, { ...options, windowsHide: true, stdio: "inherit" });
  let finished = false;
  let peakResidentBytes = 0;
  let maxProcessCount = 0;
  let samples = 0;
  const completion = new Promise((resolve) => {
    child.once("error", (error) => { finished = true; resolve({ error }); });
    child.once("exit", (code, signal) => { finished = true; resolve({ code, signal }); });
  });
  try {
    do {
      const tree = residentTree(await processes(), child.pid);
      peakResidentBytes = Math.max(peakResidentBytes, tree.bytes);
      maxProcessCount = Math.max(maxProcessCount, tree.processCount);
      samples++;
      if (!finished) await new Promise((resolve) => setTimeout(resolve, 250));
    } while (!finished);
  } catch (error) {
    child.kill();
    await completion;
    throw error;
  }
  const result = await completion;
  if (result.error) throw result.error;
  return { ...result, wallMs: performance.now() - started, peakResidentBytes, maxProcessCount, samples };
}
