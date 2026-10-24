/**
 * Plugin-owned request diagnostics are written to a sidecar JSONL file, never to a DSH
 * conversation log. DSH only accepts known session event types; provider diagnostics
 * belong in the plugin-records area instead.
 *
 * @module dsh-tool-cleversee/record
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/** DSH 数据根目录（与 harness 的 `dshHomePath()` 同语义：`$DSH_HOME` 或 `~/.dsh`）。 */
export function dshHome() {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

/**
 * 默认记账目录：`<DSH_HOME>/plugin-records/<包名>`。
 * @param pkg - 插件包名。
 * @returns 目录绝对路径。
 */
export function defaultRecordDir(pkg) {
	return join(dshHome(), "plugin-records", pkg);
}

/**
 * 解析本次记账落点。
 * @param pkg - 插件包名。
 * @param config - 当前权威配置段。
 * @returns 目标目录；`recordRequests: false` 时返回 null（不记账）。
 */
export function recordDirFor(pkg, config) {
	if (config.recordRequests === false) return null;
	const wanted = typeof config.recordDir === "string" && config.recordDir.length > 0 ? config.recordDir : defaultRecordDir(pkg);
	const resolved = resolve(wanted);
	// 兜底：就算有人把目录配到会话日志区，也绝不往那儿写。
	const sessionsRoot = resolve(join(dshHome(), "sessions"));
	if (resolved === sessionsRoot || resolved.startsWith(sessionsRoot + sep)) return defaultRecordDir(pkg);
	return resolved;
}

const readyDirs = new Set();

/**
 * 追加一条请求记录，形如 `{ at, cwd, sessionSeq, endpoint, body }`。
 * API Key 走 HTTP header，不在请求体里，所以记录天然不含密钥。
 * 写盘失败一律吞掉：记账不能把检索搞挂。
 * @param ctx - 插件上下文，仅用于取当前会话的 seq 做关联（拿不到就记 null）。
 * @param request - 即将发出的请求描述。
 * @param dir - `recordDirFor()` 的结果，null 表示不记账。
 * @returns 实际写入的行（供测试断言）；未写入时为 null。
 */
export function appendRequestRecord(ctx, request, dir) {
	if (dir === null || dir === undefined) return null;
	try {
		if (!readyDirs.has(dir)) {
			mkdirSync(dir, { recursive: true });
			readyDirs.add(dir);
		}
		const session = ctx.get("agents")?.currentInitiator()?.session;
		const line = JSON.stringify({
			at: Date.now(),
			cwd: process.cwd(),
			sessionSeq: typeof session?.seq === "number" ? session.seq : null,
			...request,
		});
		appendFileSync(join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), `${line}\n`, "utf8");
		return line;
	} catch {
		return null;
	}
}
