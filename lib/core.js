/**
 * CleverSee（开析）联网搜索客户端 —— 纯逻辑，零 DSH 依赖，可脱离宿主单测。
 *
 * 两个端点（控制台「通过 API Key 调用」给出的 HTTP 形态，Bearer 鉴权）：
 *  - 搜文 UnifiedSearch      POST https://cloud-iqs.aliyuncs.com/search/unified
 *  - 搜图 MultimodalSearch   POST https://cloud-iqs.aliyuncs.com/search/multimodal
 * （POP 网关内部路径分别是 /linked-retrieval/linked-retrieval-entry/v1/iqs/{search,multimodal}/unified，
 *  API Key 模式用上面两个短路径。）
 *
 * 与「模型内置检索」的根本差别：这里没有模型回合。query 进，结构化结果出，按次计费。
 *
 * 实测鉴权失败形态（2026-10-08，无 key / 假 key 各一次）：
 *   HTTP 403 {"requestId":"…","errorCode":"Retrieval.InvalidAPIKey",
 *             "errorMessage":"Incorrect APIKey provided. You can find your api key at https://ipaas.console.aliyun.com/api-key"}
 *
 * 字段来源：阿里云 OpenAPI 元数据（UnifiedSearch / MultimodalSearch schema）+ 控制台示例。
 *  - unified.pageItems[]: link / title / snippet / publishedTime / summary / mainText / markdownText
 *                         / hostname / hostLogo / rerankScore / hostAuthorityScore / correlationTag
 *    unified 请求: query, engineType, numResults, timeRange, category, location, advancedParams,
 *                  contents{mainText,markdownText,summary,rerankScore}
 *  - multimodal.imageItems[]: imageUrl / hostPageUrl / title / publishedTime / width / height
 *    multimodal 请求: query, engineType, advancedParams（当前只开放「文搜图」，图搜图未上线）
 * @module core
 */

export const TEXT_ENDPOINT = "https://cloud-iqs.aliyuncs.com/search/unified";
export const IMAGE_ENDPOINT = "https://cloud-iqs.aliyuncs.com/search/multimodal";

export const DEFAULTS = {
	textEngineType: "CNLiteBasic",
	imageEngineType: "MultimodalSpeed",
	numResults: 8,
	imageMaxResults: 10,
	timeRange: "NoLimit",
	maxCharsPerSource: 1200,
	timeoutMs: 20000,
};

/** 搜文引擎（控制台 + OpenAPI enum 的并集）。 */
export const TEXT_ENGINES = ["CNLiteBasic", "CNAuto", "Generic", "GenericAdvanced", "GlobalAdvanced", "LiteAdvanced", "Deep"];
/** 搜图引擎：官方仅开放文搜图两档；ImageAgent/ImageAgentAdvanced（图搜图）尚未上线。 */
export const IMAGE_ENGINES = ["MultimodalSpeed", "MultimodalSpeedAdvanced"];
export const TIME_RANGES = ["OneDay", "OneWeek", "OneMonth", "OneYear", "NoLimit"];

/** 带 DSH 错误码的普通 Error；插件壳会重抛成 WebError / 工具错误。 */
export class SearchError extends Error {
	constructor(message, code = "WEB_PROVIDER_ERROR", options) {
		super(message, options);
		this.name = "SearchError";
		this.code = code;
	}
}

function clampInt(value, min, max) {
	const n = Number.isFinite(value) ? Math.trunc(value) : min;
	return Math.min(max, Math.max(min, n));
}

/** 归一化 `excludeSites`：数组或逗号串 → 逗号串（官方支持黑白名单，最多 100 域名）。 */
function normalizeExclude(value) {
	if (Array.isArray(value)) {
		const list = value.map((x) => String(x).trim()).filter((x) => x.length > 0).slice(0, 100);
		return list.length > 0 ? list.join(",") : undefined;
	}
	if (typeof value === "string" && value.trim().length > 0) return value.trim();
	return undefined;
}

/** 搜文请求体。 */
export function buildTextRequest(options, query) {
	const body = {
		query,
		engineType: options.textEngineType ?? DEFAULTS.textEngineType,
		numResults: clampInt(options.numResults ?? DEFAULTS.numResults, 1, 50),
		timeRange: options.timeRange ?? DEFAULTS.timeRange,
		contents: {
			mainText: options.wantMainText === true,
			markdownText: false,
			summary: options.wantSummary === true,
			rerankScore: true,
		},
	};
	const exclude = normalizeExclude(options.excludeSites);
	if (exclude !== undefined) body.advancedParams = { excludeSites: exclude };
	if (typeof options.category === "string" && options.category.length > 0) body.category = options.category;
	return body;
}

/** 搜图（文搜图）请求体。 */
export function buildImageRequest(options, query) {
	const body = {
		query,
		engineType: options.imageEngineType ?? DEFAULTS.imageEngineType,
	};
	const exclude = normalizeExclude(options.excludeSites);
	if (exclude !== undefined) body.advancedParams = { excludeSites: exclude };
	return body;
}

/**
 * unified.pageItems → 来源列表（按 url 去重，保留引擎的 rerank 序）。
 * @param items - 响应 pageItems
 * @param options - maxCharsPerSource / wantSummary / wantMainText
 */
export function mapPageItems(items, options = {}) {
	const maxChars = clampInt(options.maxCharsPerSource ?? DEFAULTS.maxCharsPerSource, 200, 8000);
	const seen = new Set();
	/** @type {any[]} */
	const sources = [];
	let dropped = 0;
	for (const item of items ?? []) {
		const url = typeof item?.link === "string" ? item.link : "";
		if (url.length === 0 || seen.has(url)) {
			dropped++;
			continue;
		}
		seen.add(url);
		/** @type {any} */
		const source = { url };
		if (typeof item.title === "string" && item.title.length > 0) source.title = item.title;
		const text = pickText(item, options, maxChars);
		if (text !== undefined) source.snippet = text;
		if (typeof item.publishedTime === "string" && item.publishedTime.length > 0) source.publishedAt = item.publishedTime;
		if (typeof item.hostname === "string" && item.hostname.length > 0) source.hostname = item.hostname;
		if (Number.isFinite(item.rerankScore)) source.score = item.rerankScore;
		sources.push(source);
	}
	return { sources, dropped };
}

/**
 * multimodal.imageItems → 图片结果列表。
 * `url` 一律是**图片直链**，`pageUrl` 是来源网页（版权溯源用）。
 * @param items - 响应 imageItems
 */
export function mapImageItems(items, options = {}) {
	const cap = clampInt(options.imageMaxResults ?? DEFAULTS.imageMaxResults, 1, 50);
	const seen = new Set();
	/** @type {any[]} */
	const results = [];
	for (const item of items ?? []) {
		const url = typeof item?.imageUrl === "string" ? item.imageUrl : "";
		if (url.length === 0 || seen.has(url) || results.length >= cap) continue;
		seen.add(url);
		/** @type {any} */
		const entry = { url };
		if (typeof item.title === "string" && item.title.length > 0) entry.title = item.title;
		if (typeof item.hostPageUrl === "string" && item.hostPageUrl.length > 0) entry.pageUrl = item.hostPageUrl;
		if (typeof item.publishedTime === "string" && item.publishedTime.length > 0) entry.publishedAt = item.publishedTime;
		if (Number.isFinite(item.width)) entry.width = item.width;
		if (Number.isFinite(item.height)) entry.height = item.height;
		results.push(entry);
	}
	return { results, total: Number.isFinite(options?.total) ? options.total : undefined };
}

/** 选一份给模型看的正文：mainText > summary > snippet，统一截断。 */
function pickText(item, options, maxChars) {
	const prefer = options.wantMainText === true ? item.mainText : options.wantSummary === true ? item.summary : undefined;
	const raw = typeof prefer === "string" && prefer.length > 0 ? prefer : item.snippet;
	if (typeof raw !== "string" || raw.length === 0) return undefined;
	if (raw.length <= maxChars) return raw;
	return `${raw.slice(0, maxChars)}…[截断，原文 ${raw.length} 字]`;
}

/** 把服务端错误体转成一句可行动的话。 */
function describeError(status, payload, kind) {
	const code = typeof payload?.errorCode === "string" ? payload.errorCode : undefined;
	const message = typeof payload?.errorMessage === "string" ? payload.errorMessage : typeof payload?.message === "string" ? payload.message : undefined;
	const requestId = typeof payload?.requestId === "string" ? payload.requestId : undefined;
	const tail = [];
	if (message) tail.push(message);
	if (requestId) tail.push(`requestId=${requestId}`);
	let hint = "";
	if (code === "Retrieval.InvalidAPIKey" || status === 401 || status === 403) {
		hint = " 鉴权失败：在 CleverSee 控制台（aisearch.aliyun.com → 联网搜索 → API配置）创建/复制 API Key，确认服务已开通且账户未欠费；然后把 key 存成 DSH 凭据 CLEVERSEE_API_KEY，或写进 tool-cleversee 的 apiKey。";
	} else if (typeof code === "string" && /Param|Invalid/i.test(code)) {
		hint = ` 参数被拒：${kind === "image" ? "搜图" : "搜文"}当前支持的 engineType 见工具入参说明（搜图只有 MultimodalSpeed / MultimodalSpeedAdvanced，图搜图未开放）。去掉可选参数重试一次通常就能过。`;
	}
	return `CleverSee ${kind === "image" ? "搜图" : "搜文"}失败（HTTP ${status}${code ? ` ${code}` : ""}）${tail.length > 0 ? `: ${tail.join(" · ")}` : ""}.${hint}`;
}

/** 发一次请求并解析；两种 kind 共用。 */
async function post(endpoint, apiKey, body, signal, kind, recordRequest) {
	recordRequest?.({ endpoint, body });
	let response;
	try {
		response = await fetch(endpoint, {
			method: "POST",
			redirect: "error",
			headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify(body),
			...(signal === undefined ? {} : { signal }),
		});
	} catch (error) {
		if (signal?.aborted === true || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))) throw new SearchError("CleverSee 检索被取消", "WEB_ABORTED", { cause: error });
		throw new SearchError(`CleverSee 请求未能发出: ${String(error)}（endpoint=${JSON.stringify(endpoint)}）`, "WEB_PROVIDER_ERROR", { cause: error });
	}
	const text = await response.text();
	let payload;
	try {
		payload = JSON.parse(text);
	} catch {
		payload = undefined;
	}
	// 201 = 结果被绿网过滤过一部分，官方口径仍按成功计费
	if (!response.ok) throw new SearchError(describeError(response.status, payload, kind), "WEB_PROVIDER_ERROR");
	return payload ?? {};
}

function requireKey(options) {
	const apiKey = options.apiKey;
	if (typeof apiKey !== "string" || apiKey.length === 0) {
		throw new SearchError(`CleverSee 检索没有可用 API Key（凭据名 "${options.apiKeyEnv ?? "CLEVERSEE_API_KEY"}"）。请在 Settings > Models 存入凭据、或在启动环境导出该变量、或在 tool-cleversee 配置里写 apiKey。`, "WEB_PROVIDER_CREDENTIAL_MISSING");
	}
	return apiKey;
}

/** 一次搜文。 */
export async function searchTextOnce(options, query, signal) {
	const apiKey = requireKey(options);
	const body = buildTextRequest(options, query);
	const payload = await post(options.textEndpoint ?? TEXT_ENDPOINT, apiKey, body, signal, "text", options.recordRequest);
	const mapped = mapPageItems(payload.pageItems, options);
	if (mapped.sources.length === 0) {
		throw new SearchError(`CleverSee 对 "${query}" 没有返回可用结果（engineType=${body.engineType}${payload.requestId ? `, requestId=${payload.requestId}` : ""}）。换 engineType 或放宽 timeRange 再试。`, "WEB_PROVIDER_UNUSABLE");
	}
	return {
		sources: mapped.sources,
		engineType: payload.queryContext?.engineType ?? body.engineType,
		searchTimeMs: Number.isFinite(payload.searchInformation?.searchTime) ? payload.searchInformation.searchTime : undefined,
		credits: payload.costCredits,
	};
}

/** 一次搜图（文搜图）。 */
export async function searchImagesOnce(options, query, signal) {
	const apiKey = requireKey(options);
	const body = buildImageRequest(options, query);
	const payload = await post(options.imageEndpoint ?? IMAGE_ENDPOINT, apiKey, body, signal, "image", options.recordRequest);
	const mapped = mapImageItems(payload.imageItems, { ...options, total: payload.searchInformation?.total });
	if (mapped.results.length === 0) {
		throw new SearchError(`CleverSee 没有为 "${query}" 找到图片（engineType=${body.engineType}${payload.requestId ? `, requestId=${payload.requestId}` : ""}）。可以换更具体的描述或换 MultimodalSpeedAdvanced。`, "WEB_PROVIDER_UNUSABLE");
	}
	return {
		results: mapped.results,
		total: payload.searchInformation?.total,
		engineType: body.engineType,
		searchTimeMs: Number.isFinite(payload.searchInformation?.searchTime) ? payload.searchInformation.searchTime : undefined,
	};
}

/**
 * 多查询并发搜文，按 url 去重合并。
 * @param options - 见 searchTextOnce
 * @param queries - 查询词
 * @param signal - AbortSignal
 * @param maxSources - 合并后保留条数
 */
export async function searchMany(options, queries, signal, maxSources) {
	const settled = await Promise.all(queries.map(async (q) => {
		try {
			return { query: q, ok: true, result: await searchTextOnce(options, q, signal) };
		} catch (error) {
			if (error instanceof SearchError && error.code === "WEB_ABORTED") throw error;
			return { query: q, ok: false, error };
		}
	}));
	return mergeTextResults(settled, maxSources);
}

/** 多查询并发搜图，按图片直链去重合并。 */
export async function searchManyImages(options, queries, signal, maxResults) {
	const settled = await Promise.all(queries.map(async (q) => {
		try {
			return { query: q, ok: true, result: await searchImagesOnce(options, q, signal) };
		} catch (error) {
			if (error instanceof SearchError && error.code === "WEB_ABORTED") throw error;
			return { query: q, ok: false, error };
		}
	}));
	const seen = new Set();
	/** @type {any[]} */
	const images = [];
	const errors = [];
	let truncated = false;
	let engineType;
	let searchTimeMs;
	let total;
	for (const entry of settled) {
		if (!entry.ok) {
			errors.push(`${entry.query}: ${entry.error.message}`);
			continue;
		}
		engineType ??= entry.result.engineType;
		if (typeof entry.result.searchTimeMs === "number") searchTimeMs = Math.max(searchTimeMs ?? 0, entry.result.searchTimeMs);
		if (Number.isFinite(entry.result.total)) total = (total ?? 0) + entry.result.total;
		for (const item of entry.result.results) {
			if (seen.has(item.url)) continue;
			seen.add(item.url);
			if (images.length >= maxResults) {
				truncated = true;
				continue;
			}
			images.push({ ...item, query: entry.query });
		}
	}
	if (images.length === 0) {
		throw new SearchError(errors.length > 0 ? `CleverSee 搜图全部 ${queries.length} 个查询都失败：\n- ${errors.join("\n- ")}` : "CleverSee 搜图没有返回任何结果", errors.length > 0 ? "WEB_PROVIDER_ERROR" : "WEB_PROVIDER_UNUSABLE");
	}
	return { images, truncated, errors, engineType, searchTimeMs, total };
}

/** 合并多查询的搜文结果（保留先出现者 = 各查询内部的 rerank 序）。 */
function mergeTextResults(settled, maxSources) {
	const seen = new Set();
	/** @type {any[]} */
	const merged = [];
	const errors = [];
	let truncated = false;
	let engineType;
	let searchTimeMs;
	const credits = { calls: 0, summary: 0, advanced: 0 };
	for (const entry of settled) {
		if (!entry.ok) {
			errors.push(`${entry.query}: ${entry.error.message}`);
			continue;
		}
		engineType ??= entry.result.engineType;
		if (typeof entry.result.searchTimeMs === "number") searchTimeMs = Math.max(searchTimeMs ?? 0, entry.result.searchTimeMs);
		const c = entry.result.credits;
		if (c) {
			credits.summary += c.valueAdded?.summary ?? 0;
			credits.advanced += c.valueAdded?.advanced ?? 0;
		}
		// 官方计费口径是「按成功调用（HTTP 200/201）次数结算」，而 CNLiteBasic 档的
		// costCredits.search 实测回传 0，所以 calls 直接按成功查询数计——这正是账单口径本身。
		credits.calls += 1;
		for (const source of entry.result.sources) {
			if (seen.has(source.url)) continue;
			seen.add(source.url);
			if (merged.length >= maxSources) {
				truncated = true;
				continue;
			}
			merged.push({ ...source, query: entry.query });
		}
	}
	if (merged.length === 0) {
		throw new SearchError(errors.length > 0 ? `CleverSee 全部 ${settled.length} 个查询都失败：\n- ${errors.join("\n- ")}` : "CleverSee 没有返回任何结果", errors.length > 0 ? "WEB_PROVIDER_ERROR" : "WEB_PROVIDER_UNUSABLE");
	}
	return { sources: merged, truncated, errors, engineType, searchTimeMs, credits };
}
