/**
 * dsh-tool-cleversee 验收测试。
 *
 *   node plugins/dsh-tool-cleversee/test/live.test.mjs            # 无 key：跑 fixture 映射 + 鉴权失败路径
 *   $env:CLEVERSEE_API_KEY=… ; node …/live.test.mjs live           # 有 key：两个端点各打真实请求
 *
 * key 只从环境读，绝不打印。
 */
import { DEFAULTS, IMAGE_ENDPOINT, SearchError, TEXT_ENDPOINT, buildImageRequest, buildTextRequest, mapImageItems, mapPageItems, searchImagesOnce, searchMany, searchManyImages, searchTextOnce } from "../lib/core.js";

const KEY = process.env.CLEVERSEE_API_KEY;
const WANT_LIVE = process.argv[2] === "live";
let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
	if (ok) {
		pass++;
		console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
	} else {
		fail++;
		console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
	}
};

// ── 1. 请求体构造 ───────────────────────────────────────────────────────────────
console.log("\n[1] request bodies");
const textBody = buildTextRequest({ numResults: 5, wantMainText: true, excludeSites: ["www.360doc.com", "weibo.com"], category: "金融" }, "杭州美食");
check("unified body shape", textBody.query === "杭州美食" && textBody.engineType === DEFAULTS.textEngineType && textBody.numResults === 5 && textBody.contents.mainText === true && textBody.contents.summary === false && textBody.contents.rerankScore === true && textBody.timeRange === "NoLimit", JSON.stringify(textBody));
check("advancedParams.excludeSites joined", textBody.advancedParams?.excludeSites === "www.360doc.com,weibo.com");
check("category passed through", textBody.category === "金融");
const imgBody = buildImageRequest({ imageEngineType: "MultimodalSpeedAdvanced" }, "狮子");
check("multimodal body is minimal", JSON.stringify(imgBody) === JSON.stringify({ query: "狮子", engineType: "MultimodalSpeedAdvanced" }), JSON.stringify(imgBody));

// ── 2. 响应映射（用官方 OpenAPI responseDemo 的字段） ───────────────────────────
console.log("\n[2] response mapping against official demo payloads");
const unifiedDemo = {
	pageItems: [
		{ title: "上海车展大佬齐聚 问界成为话题中心", link: "https://hea.china.com/articles/20250427/202504271666343.html", snippet: "2025上海车展期间，最火爆的无疑是问界品牌…", publishedTime: "2025-04-27T20:36:04+08:00", hostname: "中华网", rerankScore: 0.7786493301391602, summary: "增强摘要：…", mainText: "正文：…" },
		{ title: "重复条目", link: "https://hea.china.com/articles/20250427/202504271666343.html" },
		{ title: "无链接", snippet: "x" },
	],
	queryContext: { engineType: "Generic" },
	searchInformation: { searchTime: 1028 },
	costCredits: { search: { genericTextSearch: 1, liteAdvancedTextSearch: 0 }, valueAdded: { summary: 1, advanced: 0 } },
};
const mapped = mapPageItems(unifiedDemo.pageItems, { maxCharsPerSource: 1200 });
check("dedupe by url + drop empty url", mapped.sources.length === 1 && mapped.dropped === 2, `sources=${mapped.sources.length} dropped=${mapped.dropped}`);
const s0 = mapped.sources[0];
check("url/title/snippet/publishedAt/hostname/score mapped", s0.url.includes("hea.china.com") && s0.title.startsWith("上海车展") && s0.snippet.includes("上海车展") && s0.publishedAt === "2025-04-27T20:36:04+08:00" && s0.hostname === "中华网" && Math.abs(s0.score - 0.7786) < 1e-3);
const wantMain = mapPageItems(unifiedDemo.pageItems, { wantMainText: true, maxCharsPerSource: 1200 }).sources[0];
const wantSum = mapPageItems(unifiedDemo.pageItems, { wantSummary: true, maxCharsPerSource: 1200 }).sources[0];
check("wantMainText picks mainText, wantSummary picks summary", wantMain.snippet.startsWith("正文") && wantSum.snippet.startsWith("增强摘要"), `main="${wantMain.snippet}" summary="${wantSum.snippet}"`);
const clipped = mapPageItems([{ link: "https://e.com/a", mainText: "x".repeat(5000) }], { wantMainText: true, maxCharsPerSource: 300 }).sources[0];
check("long text truncated with marker", clipped.snippet.length < 400 && clipped.snippet.includes("截断"), `${clipped.snippet.length} chars`);

const imageDemo = {
	requestId: "sdfsd234-2vxcg345-345vc",
	queryContext: { originalQuery: { query: "阿里巴巴" } },
	searchInformation: { total: 13, searchTime: 700 },
	imageItems: [
		{ publishedTime: "2022-07-05T00:54:42+08:00", title: "阿里巴巴现在以主业上为主", imageUrl: "http://pic.rmb.bdstatic.com/bjh/bb87f566c0c/241218/f7936f25837b20211e5ef88d7980c143.jpeg", hostPageUrl: "http://mbd.baidu.com/newspage/data/dtlandingsuper?nid=dt_4541580238898912926", height: 1330, width: 1000 },
		{ imageUrl: "http://example.com/dup.jpeg" },
		{ imageUrl: "http://example.com/dup.jpeg" },
		{ title: "缺 imageUrl", height: 1 },
	],
};
const images = mapImageItems(imageDemo.imageItems, { imageMaxResults: 10 });
check("image dedupe + drop missing url", images.results.length === 2, `results=${images.results.length}`);
const i0 = images.results[0];
check("imageUrl→url, hostPageUrl→pageUrl, w/h/time", i0.url.includes("bdstatic") && i0.pageUrl.includes("mbd.baidu") && i0.width === 1000 && i0.height === 1330 && i0.publishedAt.startsWith("2022-07-05"));
check("imageMaxResults caps", mapImageItems(imageDemo.imageItems, { imageMaxResults: 1 }).results.length === 1);

// ── 3. 空结果与鉴权失败必须响亮报错 ─────────────────────────────────────────────
console.log("\n[3] loud failures");
const emptyMapped = mapPageItems([], {});
check("empty pageItems → 0 sources（抛错由 searchTextOnce 的守卫负责）", emptyMapped.sources.length === 0 && emptyMapped.dropped === 0);
try {
	await searchTextOnce({ apiKey: "" }, "x");
	check("missing key must throw", false);
} catch (e) {
	check("missing key → WEB_PROVIDER_CREDENTIAL_MISSING", e instanceof SearchError && e.code === "WEB_PROVIDER_CREDENTIAL_MISSING", e.code);
}
if (WANT_LIVE) {
	try {
		await searchImagesOnce({ apiKey: "invalid-test-key" }, "狮子");
		check("bad key must throw", false);
	} catch (e) {
		check("bad key → WEB_PROVIDER_ERROR with 403/InvalidAPIKey text", e.code === "WEB_PROVIDER_ERROR" && /403|InvalidAPIKey|鉴权/.test(e.message), String(e.message).slice(0, 150));
	}
} else {
	check("offline run does not send a bad-key request", true);
}

// ── 4. 真实调用（需要 key） ─────────────────────────────────────────────────────
if (!WANT_LIVE) {
	console.log(`\n[4] live calls skipped (pass "live" with CLEVERSEE_API_KEY set)\n     endpoints: ${TEXT_ENDPOINT} | ${IMAGE_ENDPOINT}`);
} else if (!KEY) {
	console.log("\n[4] live requested but CLEVERSEE_API_KEY is not set — aborting live section");
	fail++;
} else {
	console.log("\n[4] live calls");
	const t0 = Date.now();
	const text = await searchMany({ apiKey: KEY, numResults: 5 }, ["2026年10月 诺贝尔物理学奖 获得者"], undefined, 10);
	console.log(`  搜文: ${text.sources.length} 条 in ${Date.now() - t0}ms engine=${text.engineType} 引擎耗时=${text.searchTimeMs}ms credits=${JSON.stringify(text.credits)}`);
	for (const s of text.sources.slice(0, 3)) console.log(`    · ${s.title ?? ""} | ${s.publishedAt ?? "无时间"} | ${(s.snippet ?? "").slice(0, 60)}…\n      ${s.url}`);
	check("搜文带摘要与时间", text.sources.some((s) => s.snippet !== undefined) && text.sources.some((s) => s.publishedAt !== undefined));
	const t1 = Date.now();
	const imgs = await searchManyImages({ apiKey: KEY, imageMaxResults: 5 }, ["狮子 草原 奔跑"], undefined, 5);
	console.log(`  搜图: ${imgs.images.length} 张 in ${Date.now() - t1}ms engine=${imgs.engineType} 候选总数=${imgs.total} 耗时=${imgs.searchTimeMs}ms`);
	for (const i of imgs.images.slice(0, 3)) console.log(`    · ${i.title ?? "(无标题)"} ${i.width ?? "?"}×${i.height ?? "?"}\n      img  ${i.url}\n      page ${i.pageUrl ?? "-"}`);
	check("搜图给出图片直链+来源页", imgs.images.every((i) => /^https?:/.test(i.url)) && imgs.images.some((i) => i.pageUrl !== undefined));
	const t2 = Date.now();
	const adv = await searchManyImages({ apiKey: KEY, imageEngineType: "MultimodalSpeedAdvanced", imageMaxResults: 3 }, ["狮子"], undefined, 3);
	console.log(`  搜图增强版: ${adv.images.length} 张 in ${Date.now() - t2}ms engine=${adv.engineType}`);
	const t3 = Date.now();
	const ge = await searchMany({ apiKey: KEY, textEngineType: "GenericAdvanced", numResults: 10 }, ["大语言模型 agent 综述 2026"], undefined, 12);
	console.log(`  搜文 GenericAdvanced: ${ge.sources.length} 条 in ${Date.now() - t3}ms credits=${JSON.stringify(ge.credits)}`);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
