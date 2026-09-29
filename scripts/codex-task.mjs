#!/usr/bin/env node
const base = process.env.GEO_OPS_URL || "http://localhost:4318/api";
const [command, taskId, ...args] = process.argv.slice(2);

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, { headers: { "content-type": "application/json" }, ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "请求失败");
  return body;
}

if (command === "list") {
  console.log(JSON.stringify(await request("/codex/tasks"), null, 2));
} else if (command === "show" && taskId) {
  console.log(JSON.stringify(await request(`/codex/tasks/${taskId}`), null, 2));
} else if (command === "review" && taskId) {
  const [decision, ...issues] = args;
  const result = await request(`/codex/tasks/${taskId}/complete`, { method: "POST", body: JSON.stringify({ pass: decision === "pass", issues, rewriteInstructions: decision === "pass" ? [] : issues }) });
  console.log(JSON.stringify(result, null, 2));
} else if (command === "write" && taskId) {
  const [file] = args;
  if (!file) throw new Error("需要包含 title、summary、body 的 JSON 文件路径");
  const payload = JSON.parse(await (await import("node:fs/promises")).readFile(file, "utf8"));
  console.log(JSON.stringify(await request(`/codex/tasks/${taskId}/complete`, { method: "POST", body: JSON.stringify(payload) }), null, 2));
} else {
  console.log("用法：node scripts/codex-task.mjs list | show <taskId> | review <taskId> pass|fail [问题…] | write <taskId> <article.json>");
}
