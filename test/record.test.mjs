/**
 * Offline regression test for request recording. No API key or DSH restart is required.
 * Ensure private diagnostics stay out of DSH conversation logs.
 */
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRequestRecord, defaultRecordDir, recordDirFor } from "../lib/record.js";

const PKG = "dsh-tool-cleversee";
let failed = 0;
const check = (label, ok, extra = "") => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  [${extra}]` : ""}`);
	if (!ok) failed++;
};

// 把 DSH_HOME 指到临时目录，避免碰到真实数据
const home = mkdtempSync(join(tmpdir(), "dsh-home-"));
process.env.DSH_HOME = home;

// 1) 落点：默认在 plugin-records 下，绝不在 sessions 下
check("默认记账目录 = <DSH_HOME>/plugin-records/<包名>", recordDirFor(PKG, {}) === join(home, "plugin-records", PKG));
check("默认记账目录不在会话日志区", !recordDirFor(PKG, {}).startsWith(join(home, "sessions")));

// 2) 开关与自定义
check("recordRequests:false → 不记账", recordDirFor(PKG, { recordRequests: false }) === null);
check("recordDir 可自定义", recordDirFor(PKG, { recordDir: join(home, "my-records") }) === join(home, "my-records"));

// 3) 兜底：有人把目录配到会话日志区，也必须回退
check("recordDir 指向 sessions 会被回退", recordDirFor(PKG, { recordDir: join(home, "sessions", "--D-x--", "session-y") }) === defaultRecordDir(PKG));

// 4) 真实写入：session.append 一旦被动就抛（雷针），记账本身要正常落盘
let appendCalls = 0;
const ctx = {
	get: (name) => name === "agents" ? {
		currentInitiator: () => ({
			session: {
				seq: 7,
				append: () => {
					appendCalls++;
					throw new Error("插件不得往会话日志 append 事件");
				},
			},
		}),
	} : undefined,
};
const line = appendRequestRecord(ctx, { endpoint: "https://example.invalid/search/unified", body: { queries: ["测试"] } }, recordDirFor(PKG, {}));
check("写出一行记录", typeof line === "string" && line.length > 0);
check("没有调用 session.append", appendCalls === 0);
const parsed = line ? JSON.parse(line) : {};
check("记录带 sessionSeq（用于对回会话）", parsed.sessionSeq === 7);
check("记录含 endpoint 与请求体", parsed.endpoint === "https://example.invalid/search/unified" && Array.isArray(parsed.body?.queries));
const files = readdirSync(defaultRecordDir(PKG));
check("按 UTC 日期分文件", files.length === 1 && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(files[0]), files.join(","));

// 5) 静态防回归：index.js 里不许再出现往会话日志 append 的写法
const src = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
check("index.js 不含 session.append(", !src.includes("session.append("));
check("index.js 不含自造事件类型", !/\.append\(\s*["'`][a-z][a-z-]*\//.test(src));

// 6) 记账失败绝不能把检索搞挂
let threw = false;
try {
	appendRequestRecord(ctx, { endpoint: "x" }, "\0 非法路径 \0");
} catch {
	threw = true;
}
check("写盘异常被吞掉，不影响检索", !threw);

console.log(failed === 0 ? "\n✅ 全部通过" : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
