/**
 *@Author: JH-Ahua
 *@CreateTime: 2026/4/14 10:41
 *@email: admin@bugpk.com
 *@blog: www.jiuhunwl.cn
 *@Api: api.bugpk.com
 *@tip: 抖音解析cloudflare workers版
 */
const DEFAULT_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

// 详情接口专用移动端 UA：配合 api.amemv.com 免 Cookie 详情接口使用（视频/图集/实况通用）
const MOBILE_UA =
    "Mozilla/5.0 (Linux; Android 13; 2210132C Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36";

const REDIRECT_DONE_HOSTS = {
    "www.douyin.com": true,
};

const PLATFORM_HOSTS = {
    "www.douyin.com": true,
    "www.iesdouyin.com": true,
};

const CORS_HEADERS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Content-Type",
    "cache-control": "no-cache, no-store, must-revalidate",
    "content-type": "application/json; charset=utf-8",
};

// 原画播放地址模板：传入 vid 拼接后 302 即为原画直链
// improve_bitrate=1 是关键参数：部分作品会 302 到 tos-cn-v-* 原始源对象
const ORIGINAL_PLAY_ENDPOINT = "https://www.douyin.com/aweme/v1/play/";
// 批量转换 vid 时的并发数与单次上限（防止超出 Workers 子请求配额，超出的回退拼接地址）
const VID_RESOLVE_CONCURRENCY = 8;
const VID_RESOLVE_MAX_COUNT = 30;
// 每个视频最多探测体积的档位数量
const VARIANT_PROBE_LIMIT = 6;

export default {
    async fetch(request) {
        if (request.method === "OPTIONS") {
            return new Response(null, {status: 204, headers: CORS_HEADERS});
        }

        try {
            const input = await getInputUrl(request);
            if (!input) {
                return jsonResponse(400, "请输入抖音链接");
            }

            const result = await parseShareText(input);
            return new Response(JSON.stringify(result), {
                status: result.code >= 500 ? 500 : 200,
                headers: CORS_HEADERS,
            });
        } catch (error) {
            return new Response(
                JSON.stringify(output(500, `服务异常：${safeErrorMessage(error)}`)),
                {
                    status: 500,
                    headers: CORS_HEADERS,
                }
            );
        }
    },
};

async function getInputUrl(request) {
    const url = new URL(request.url);
    const fromQuery = url.searchParams.get("url");
    if (fromQuery && fromQuery.trim()) {
        return fromQuery.trim();
    }

    if (request.method === "POST") {
        const contentType = request.headers.get("content-type") || "";

        if (contentType.includes("application/json")) {
            const body = await request.json().catch(() => null);
            if (body && typeof body.url === "string" && body.url.trim()) {
                return body.url.trim();
            }
        }

        if (
            contentType.includes("application/x-www-form-urlencoded") ||
            contentType.includes("multipart/form-data")
        ) {
            const form = await request.formData().catch(() => null);
            const value = form?.get("url");
            if (typeof value === "string" && value.trim()) {
                return value.trim();
            }
        }

        if (contentType.startsWith("text/plain")) {
            const text = (await request.text().catch(() => "")).trim();
            if (text) {
                return text;
            }
        }
    }

    return "";
}

async function parseShareText(text) {
    const shareUrl = extractFirstUrl(text);
    if (!shareUrl) {
        return output(400, "未在文本中识别到有效链接");
    }

    const resolved = await followRedirectsToPlatform(shareUrl);
    if (!resolved) {
        return output(400, "无法解析重定向或链接不属于抖音");
    }

    const resolvedHost = host(resolved);
    if (!resolvedHost || !PLATFORM_HOSTS[resolvedHost]) {
        return output(400, "该链接不是抖音网页链接");
    }

    const realUrl = extractVideoAddress(resolved);
    const awemeId = getVideoId(realUrl);
    if (!awemeId) {
        return output(400, `链接格式错误，无法提取ID。处理后的链接: ${realUrl}`);
    }

    const detailResult = await fetchAwemeDetail(awemeId);
    if (!detailResult.ok) {
        const data = detailResult.reason ? {reason: detailResult.reason} : {};
        return output(500, detailResult.reason ? `请求失败（${detailResult.reason}）` : "请求失败", data);
    }

    const payload = await buildLegacyFormatData(detailResult.detail.aweme_detail, awemeId);
    const ok =
        (payload.type === "video" && payload.url) ||
        ((payload.type === "image" || payload.type === "live") &&
            Array.isArray(payload.images) &&
            payload.images.length > 0);

    if (!ok) {
        return output(404, "解析失败，未找到有效内容", []);
    }

    return output(200, "解析成功", payload);
}

function output(code, msg, data = []) {
    return {code, msg, data};
}

function jsonResponse(code, msg, data = []) {
    return new Response(JSON.stringify(output(code, msg, data)), {
        status: code >= 500 ? 500 : 200,
        headers: CORS_HEADERS,
    });
}

function safeErrorMessage(error) {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    return String(error || "unknown");
}

function extractFirstUrl(text) {
    const match = text.match(
        /\bhttps?:\/\/(?:www\.|[-a-zA-Z0-9.@:%_+~#=]{1,256}\.[a-zA-Z0-9()]{1,6})\b(?:[-a-zA-Z0-9()@:%_+.~#?&/=]*)?/i
    );
    return match ? match[0] : null;
}

async function followRedirectsToPlatform(startUrl, max = 8) {
    let current = startUrl;
    for (let i = 0; i < max; i += 1) {
        const currentHost = host(current);
        if (currentHost && REDIRECT_DONE_HOSTS[currentHost]) {
            return current;
        }

        const next = await requestLocation(current);
        if (!next) {
            break;
        }
        current = next;
    }

    const finalHost = host(current);
    return finalHost && PLATFORM_HOSTS[finalHost] ? current : null;
}

async function requestLocation(url) {
    const response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        headers: {
            "user-agent": DEFAULT_UA,
            accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
            "accept-language": "zh-CN,zh;q=0.9",
        },
    }).catch(() => null);

    if (!response || response.status < 300 || response.status >= 400) {
        return null;
    }

    const location = response.headers.get("location");
    if (!location) {
        return null;
    }

    try {
        return new URL(location, url).toString();
    } catch {
        return null;
    }
}

function buildOriginalPlayUrl(vid, ratio = "default") {
    if (!vid) {
        return null;
    }

    const params = new URLSearchParams({
        video_id: String(vid),
        line: "0",
        ratio,
        watermark: "0",
        media_type: "4",
        vr_type: "0",
        improve_bitrate: "1",
        is_play_url: "1",
        source: "PackSourceEnum_AWEME_DETAIL",
    });
    return `${ORIGINAL_PLAY_ENDPOINT}?${params.toString()}`;
}

// 原画核心逻辑：传入视频 vid，请求原画播放端点，302 直出原画 CDN 直链
// 这个破原画接口竟然还有人卖四位数，真是穷疯了
async function resolveOriginalVideoUrl(vid, ratio = "default") {
    const fallbackUrl = buildOriginalPlayUrl(vid, ratio);
    if (!fallbackUrl) {
        return null;
    }

    let current = fallbackUrl;
    try {
        for (let i = 0; i < 3; i += 1) {
            const next = await requestLocation(current);
            if (!next) {
                break;
            }
            current = next;
        }
    } catch {
        return fallbackUrl;
    }

    return current === fallbackUrl ? fallbackUrl : toHttps(current) || fallbackUrl;
}

// 从 video 信息中提取 vid（优先 play_addr.uri，兼容 playAddr[0].uri 与 video.uri）
function extractVidFromVideoInfo(videoInfo) {
    if (!isObject(videoInfo)) {
        return null;
    }
    if (isObject(videoInfo.play_addr) && videoInfo.play_addr.uri) {
        return String(videoInfo.play_addr.uri);
    }
    if (Array.isArray(videoInfo.playAddr) && isObject(videoInfo.playAddr[0]) && videoInfo.playAddr[0].uri) {
        return String(videoInfo.playAddr[0].uri);
    }
    if (typeof videoInfo.uri === "string" && videoInfo.uri) {
        return videoInfo.uri;
    }
    return null;
}

// 批量转换 vid：去重 + 缓存 + 并发控制 + 数量上限，超出上限的 vid 不在结果中（由调用方回退拼接地址）
async function resolveVidBatch(vidList) {
    const uniqueVids = [...new Set(vidList.filter(Boolean))];
    const limitedVids = uniqueVids.slice(0, VID_RESOLVE_MAX_COUNT);
    const cache = new Map();
    if (!limitedVids.length) {
        return cache;
    }

    let index = 0;
    const workers = Array.from(
        {length: Math.min(VID_RESOLVE_CONCURRENCY, limitedVids.length)},
        async () => {
            while (index < limitedVids.length) {
                const vid = limitedVids[index];
                index += 1;
                cache.set(vid, await resolveOriginalVideoUrl(vid));
            }
        }
    );
    await Promise.all(workers);
    return cache;
}

function extractVideoAddress(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return url;
    }

    const cleanPath = parsed.pathname.replace(/\/+$/, "");
    const normalized = `${parsed.protocol}//${parsed.host}${cleanPath}`;

    if (
        parsed.host === "www.douyin.com" ||
        parsed.host === "www.iesdouyin.com"
    ) {
        const modalId = parsed.searchParams.get("modal_id");
        if (modalId) {
            return `${normalized}?modal_id=${encodeURIComponent(modalId)}`;
        }
    }

    return normalized;
}

function getVideoId(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }

    for (const key of ["vid", "id", "modal_id", "v", "s", "pid"]) {
        const value = parsed.searchParams.get(key);
        if (value) {
            return value;
        }
    }

    const parts = parsed.pathname.split("/").filter(Boolean);
    let last = parts[parts.length - 1];
    if (!last) {
        return null;
    }
    if (last.endsWith(".html")) {
        last = last.slice(0, -5);
    }
    return last || null;
}

async function fetchAwemeDetail(awemeId) {
    // 免 Cookie 详情接口：api.amemv.com（无签名、无游客 Cookie 依赖）。
    // 视频返回 play_addr.uri + bit_rate，图集返回 images[].url_list（原图），实况另含 images[].video，三种类型通用。
    if (typeof awemeId !== "string" || !/^[1-9][0-9]{15,19}$/.test(awemeId)) {
        return {ok: false, reason: "请输入作品 aweme_id，而不是合集 mix_id"};
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
        const params = new URLSearchParams({
            aweme_id: awemeId,
            aid: "6383",
            device_platform: "web",
            version_code: "190500",
            version_name: "19.5.0",
        });
        const response = await fetch(
            `https://api.amemv.com/aweme/v1/aweme/detail/?${params.toString()}`,
            {
                method: "GET",
                redirect: "follow",
                headers: {
                    "user-agent": MOBILE_UA,
                    accept: "application/json, text/plain, */*",
                },
                signal: controller.signal,
            }
        );
        if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            return {ok: false, reason: `详情接口 HTTP ${response.status}`};
        }
        const json = await response.json().catch(() => null);
        if (!json || typeof json !== "object" || Array.isArray(json) || typeof json.status_code !== "number") {
            return {ok: false, reason: "详情接口缺少有效 status_code"};
        }
        if (json.status_code !== 0) {
            return {ok: false, reason: `详情接口 status_code=${json.status_code}`};
        }
        const detail = json.aweme_detail;
        if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
            return {ok: false, reason: "详情接口未返回 aweme_detail（不能据此断言作品已删除）"};
        }
        if (String(detail.aweme_id || "") !== awemeId) {
            return {ok: false, reason: "详情接口返回的作品 ID 不匹配"};
        }
        // 保留完整上游对象，继续交给原有媒体选取/格式化流程；此处不裁剪图文和 Live Photo。
        return {ok: true, detail: json};
    } catch (error) {
        return {
            ok: false,
            reason: controller.signal.aborted ? "详情请求超时" : `详情请求失败：${safeErrorMessage(error)}`,
        };
    } finally {
        clearTimeout(timer);
    }
}

async function buildLegacyFormatData(detail, fallbackVideoId) {
    const title = stringValue(detail?.desc);

    const authorArr = isObject(detail?.author) ? detail.author : {};
    const avatarThumb = isObject(authorArr.avatar_thumb) ? authorArr.avatar_thumb : {};
    const avatars = Array.isArray(avatarThumb.url_list) ? avatarThumb.url_list : [];
    const author = {
        name: stringValue(authorArr.nickname),
        id: stringValue(authorArr.uid || authorArr.unique_id || authorArr.short_id),
        avatar: stringValue(avatars[0]),
    };

    const music = isObject(detail?.music) ? detail.music : {};
    const musicPlay = isObject(music.play_url) ? music.play_url : {};
    const musicCoverSource = isObject(music.cover_thumb)
        ? music.cover_thumb
        : isObject(music.cover_thumb_medium)
            ? music.cover_thumb_medium
            : {};
    const musicOut = {
        title: stringValue(music.title || music.music_name),
        author: stringValue(music.author || music.owner_nickname),
        url: toHttps(stringValue(Array.isArray(musicPlay.url_list) ? musicPlay.url_list[0] : "")) || "",
        cover:
            toHttps(
                stringValue(
                    Array.isArray(musicCoverSource.url_list) ? musicCoverSource.url_list[0] : ""
                )
            ) || "",
    };

    const video = isObject(detail?.video) ? detail.video : null;
    // 契约要求秒：抖音原始 duration 为毫秒，>=1000 视为毫秒归一为秒
    let duration = video && Number.isFinite(Number(video.duration))
        ? Number(video.duration)
        : null;
    if (duration !== null && duration >= 1000) {
        duration = Math.round(duration / 1000 * 100) / 100;
    }

    const createTime = normalizeCreateTime(detail?.create_time ?? detail?.createTime);

    const result = {
        type: "unknown",
        title,
        desc: title,
        author,
        cover: "",
        url: null,
        quality: "",
        duration,
        size: 0,
        size_label: "",
        create_time: createTime,
        publish_time: formatPublishTime(createTime),
        video_backup: [],
        video_variants: [],
        images: [],
        live_photo: [],
        music: musicOut,
        extra: {},
    };

    let images = Array.isArray(detail?.images) ? detail.images : [];
    if (!images.length && Array.isArray(detail?.image_list)) {
        images = detail.image_list;
    }

    if (images.length) {
        result.type = "image";
        const liveCandidates = [];
        for (const img of images) {
            if (!isObject(img)) {
                continue;
            }

            const imgUrl = pickImageListItemUrl(img);
            if (imgUrl) {
                result.images.push(imgUrl);
            }

            const videoInfo = isObject(img.video) ? img.video : {};
            let liveVideoUrl = extractLivePhotoVideoUrl(videoInfo);
            if (liveVideoUrl) {
                liveVideoUrl = toHttps(liveVideoUrl.replace(/playwm/g, "play")) || "";
            }
            if (imgUrl && liveVideoUrl) {
                liveCandidates.push({
                    image: imgUrl,
                    fallbackUrl: liveVideoUrl,
                    vid: extractVidFromVideoInfo(videoInfo),
                });
            }
        }

        // 多视频 vid 全部转 302 后的原画直链，拿不到的回退原地址
        const vidMap = await resolveVidBatch(liveCandidates.map((item) => item.vid));
        for (const item of liveCandidates) {
            const resolved = item.vid ? vidMap.get(item.vid) : null;
            result.live_photo.push({image: item.image, video: ensureVideoMimeType(resolved || item.fallbackUrl)});
        }

        if (result.live_photo.length) {
            result.type = "live";
        }
    } else {
        result.type = "video";
        const videoInfo = await extractHighestQualityVideo(detail);

        const playUri = extractVidFromVideoInfo(video);
        let main = videoInfo.url;
        if (main) {
            main = toHttps(main.replace(/playwm/g, "play"));
        }

        // 主地址已经在 extractHighestQualityVideo 里按
        // “真实分辨率 → 同分辨率体积 → 原画优先” 选好，这里只负责输出标签
        result.quality = videoInfo.label || videoInfo.gearName || "";
        main = ensureVideoMimeType(main);

        if (main) {
            result.url = main;
            // 最佳档位的体积已经探测过，避免重复 HEAD
            result.size = Number(videoInfo.size) > 0 ? Number(videoInfo.size) : await probeVideoSize(main);
            result.size_label = formatSizeLabel(result.size);
        }

        const backups = [];
        for (const candidate of videoInfo.backup) {
            const converted = ensureVideoMimeType(toHttps(candidate.replace(/playwm/g, "play")));
            if (converted && converted !== result.url && !backups.includes(converted)) {
                backups.push(converted);
            }
        }
        result.video_backup = backups;
        result.video_variants = videoInfo.variants || [];
        result.video_id = playUri || fallbackVideoId;
    }

    const cover = pickCover(detail);
    result.cover = cover ? toHttps(cover) || "" : "";

    return result;
}

function pickImageListItemUrl(img) {
    let raw = "";
    if (Array.isArray(img.urlList) && typeof img.urlList[0] === "string") {
        raw = img.urlList[0];
    } else if (Array.isArray(img.url_list) && typeof img.url_list[0] === "string") {
        raw = img.url_list[0];
    } else if (Array.isArray(img.url_list) && img.url_list.length) {
        const last = img.url_list[img.url_list.length - 1];
        raw = typeof last === "string" ? last : "";
    }

    return raw ? toHttps(raw) : null;
}

function extractLivePhotoVideoUrl(videoInfo) {
    let liveVideoUrl = null;
    let v26Candidate = null;

    if (Array.isArray(videoInfo.playAddr)) {
        for (const addr of videoInfo.playAddr) {
            if (!isObject(addr) || typeof addr.src !== "string") {
                continue;
            }
            if (addr.src.includes("v3-web")) {
                liveVideoUrl = addr.src;
                break;
            }
            if (!v26Candidate && addr.src.includes("v26-web")) {
                v26Candidate = addr.src;
            }
        }

        if (!liveVideoUrl && v26Candidate) {
            liveVideoUrl = v26Candidate.replace(/:\/\/([^/]+)/, "://v26-luna.douyinvod.com");
        }

        if (!liveVideoUrl) {
            if (isObject(videoInfo.playAddr[1]) && typeof videoInfo.playAddr[1].src === "string") {
                liveVideoUrl = videoInfo.playAddr[1].src;
            } else if (isObject(videoInfo.playAddr[0]) && typeof videoInfo.playAddr[0].src === "string") {
                liveVideoUrl = videoInfo.playAddr[0].src;
            }
        }
    }

    if (!liveVideoUrl && isObject(videoInfo.play_addr) && Array.isArray(videoInfo.play_addr.url_list)) {
        let v26 = null;
        for (const candidate of videoInfo.play_addr.url_list) {
            if (typeof candidate !== "string") {
                continue;
            }
            if (candidate.includes("v3-web")) {
                liveVideoUrl = candidate;
                break;
            }
            if (!v26 && candidate.includes("v26-web")) {
                v26 = candidate;
            }
        }

        if (!liveVideoUrl && v26) {
            liveVideoUrl = v26.replace(/:\/\/([^/]+)/, "://v26-luna.douyinvod.com");
        }

        if (!liveVideoUrl) {
            if (typeof videoInfo.play_addr.url_list[1] === "string") {
                liveVideoUrl = videoInfo.play_addr.url_list[1];
            } else if (typeof videoInfo.play_addr.url_list[0] === "string") {
                liveVideoUrl = videoInfo.play_addr.url_list[0];
            }
        }
    }

    if (!liveVideoUrl && typeof videoInfo.playApi === "string" && videoInfo.playApi) {
        liveVideoUrl = videoInfo.playApi;
    }

    return liveVideoUrl || null;
}

function collectPlayUrlCandidatesFromBitRateItem(rateItem) {
    const candidates = [];

    if (Array.isArray(rateItem.playAddr)) {
        for (const item of rateItem.playAddr) {
            if (isObject(item) && typeof item.src === "string" && item.src) {
                candidates.push(item.src);
            }
        }
    }

    if (!candidates.length && isObject(rateItem.play_addr) && Array.isArray(rateItem.play_addr.url_list)) {
        for (const item of rateItem.play_addr.url_list) {
            if (typeof item === "string" && item) {
                candidates.push(item);
            }
        }
    }

    return candidates;
}

// 汇总视频所有可用档位：
// 1) video.bit_rate / bitRateList 的每一档（含 H.264 / HEVC、540p~4K）
// 2) vid 走 improve_bitrate=1 的 302 结果（可能是 tos-cn-v-* 原始源对象）
async function extractVideoVariants(video) {
    const variants = [];
    const seen = new Set();

    let bitRateList = [];
    if (Array.isArray(video.bitRateList) && video.bitRateList.length) {
        bitRateList = video.bitRateList;
    } else if (Array.isArray(video.bit_rate) && video.bit_rate.length) {
        bitRateList = video.bit_rate;
    }

    for (const rateItem of bitRateList) {
        if (!isObject(rateItem)) {
            continue;
        }

        const candidates = collectPlayUrlCandidatesFromBitRateItem(rateItem);
        if (!candidates.length) {
            continue;
        }

        const picked = pickBestPlayCandidate(candidates);
        if (!picked) {
            continue;
        }

        const url = toHttps(picked.replace(/playwm/g, "play"));
        const key = variantKey(url);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);

        const playAddr = isObject(rateItem.play_addr) ? rateItem.play_addr : {};
        variants.push({
            url,
            width: Number(playAddr.width || rateItem.width || 0) || 0,
            height: Number(playAddr.height || rateItem.height || 0) || 0,
            bit_rate: Number(rateItem.bitRate || rateItem.bit_rate || 0) || 0,
            quality_type: Number(rateItem.quality_type || 0) || 0,
            gear_name: stringValue(rateItem.gearName || rateItem.gear_name || ""),
            codec: rateItem.is_h265 || rateItem.is_bytevc1 ? "h265" : "h264",
            format: stringValue(rateItem.format || "mp4"),
            is_original: isOriginalSourceUrl(url),
            source: "bit_rate",
            size: 0,
            size_label: "",
        });
    }

    const vid = extractVidFromVideoInfo(video);
    const resolved = await resolveOriginalVideoUrl(vid);
    if (resolved) {
        const url = toHttps(resolved.replace(/playwm/g, "play"));
        const key = variantKey(url);
        const isOriginal = isOriginalSourceUrl(url);

        if (seen.has(key)) {
            const existing = variants.find((item) => variantKey(item.url) === key);
            if (existing && isOriginal) {
                existing.is_original = true;
                existing.quality_type = 64;
                existing.gear_name = "original";
            }
        } else {
            seen.add(key);
            const playAddr = isObject(video.play_addr) ? video.play_addr : {};
            variants.push({
                url,
                width: Number(playAddr.width || video.width || 0) || 0,
                height: Number(playAddr.height || video.height || 0) || 0,
                bit_rate: 0,
                quality_type: isOriginal ? 64 : 0,
                gear_name: isOriginal ? "original" : "",
                codec: video.is_h265 || video.is_bytevc1 ? "h265" : "h264",
                format: "mp4",
                is_original: isOriginal,
                source: "play_302",
                size: 0,
                size_label: "",
            });
        }
    }

    return variants;
}

// 从一档的多个候选地址里挑最稳的一个：v3-web 优先，v26-web 换域名，否则第一个
function pickBestPlayCandidate(candidates) {
    let v3Link = null;
    let v26Link = null;

    for (const candidate of candidates) {
        if (!candidate) {
            continue;
        }
        if (!v3Link && candidate.includes("v3-web")) {
            v3Link = candidate;
        }
        if (!v26Link && candidate.includes("v26-web")) {
            v26Link = candidate;
        }
    }

    if (v3Link) {
        return v3Link;
    }
    if (v26Link) {
        return v26Link.replace(/:\/\/([^/]+)/, "://v26-luna.douyinvod.com");
    }
    return candidates[0];
}

// 同一对象的去重 key：忽略 CDN 域名和签名，只保留 tos bucket + object id
function variantKey(url) {
    if (typeof url !== "string") {
        return "";
    }
    const match = url.match(/\/video\/tos\/cn\/([^/?]+\/[^/?]+)/);
    return match ? match[1] : url;
}

// 是否抖音原始源对象（tos-cn-v-*）；tos-cn-ve-* / tos-cn-vd-* 都是转码/分发对象
function isOriginalSourceUrl(url) {
    return typeof url === "string" && url.includes("/tos-cn-v-");
}

// 画质标签：优先标 original，其次按短边归一到 540p/720p/1080p/1440p/2160p
function variantLabel(variant) {
    if (variant?.is_original) {
        return "original";
    }

    const label = resolutionLabel(variant?.width, variant?.height);
    if (label) {
        return label;
    }

    const gear = stringValue(variant?.gear_name);
    if (gear) {
        return gear;
    }

    const bitRate = Number(variant?.bit_rate) || 0;
    return bitRate > 0 ? `${Math.round(bitRate / 1000)}kbps` : "";
}

// 分辨率短边 → 常见画质档位标签
function resolutionLabel(width, height) {
    const w = Number(width) || 0;
    const h = Number(height) || 0;
    if (w <= 0 || h <= 0) {
        return "";
    }

    const short = Math.min(w, h);
    if (short >= 2000) return "2160p";
    if (short >= 1400) return "1440p";
    if (short >= 1000) return "1080p";
    if (short >= 700) return "720p";
    if (short >= 500) return "540p";
    return `${short}p`;
}

// 档位排序：真实分辨率降序 → 同分辨率体积降序 → 原画优先 → 码率降序
function sortVideoVariants(variants) {
    variants.sort((a, b) => {
        const pa = (Number(a.width) || 0) * (Number(a.height) || 0);
        const pb = (Number(b.width) || 0) * (Number(b.height) || 0);
        if (pa !== pb) {
            return pb - pa;
        }

        const sa = Number(a.size) || 0;
        const sb = Number(b.size) || 0;
        if (sa > 0 || sb > 0) {
            if (sa !== sb) {
                return sb - sa;
            }
        }

        if (Boolean(a.is_original) !== Boolean(b.is_original)) {
            return a.is_original ? -1 : 1;
        }

        return (Number(b.bit_rate) || 0) - (Number(a.bit_rate) || 0);
    });
}

// 选择要探测体积的档位：原画必测，其余每个画质档位取码率最高的一条
function selectProbeCandidates(variants, limit = VARIANT_PROBE_LIMIT) {
    const indices = [];
    const tierCandidates = new Map();

    variants.forEach((variant, index) => {
        if (variant.is_original) {
            if (!indices.includes(index)) {
                indices.push(index);
            }
            return;
        }

        const label = resolutionLabel(variant.width, variant.height);
        const key = label || variant.gear_name || variantKey(variant.url);
        const currentIndex = tierCandidates.get(key);
        if (currentIndex === undefined) {
            tierCandidates.set(key, index);
            return;
        }

        const current = variants[currentIndex];
        if ((Number(variant.bit_rate) || 0) > (Number(current.bit_rate) || 0)) {
            tierCandidates.set(key, index);
        }
    });

    const ordered = [...tierCandidates.values()]
        .map((index) => ({
            index,
            pixels: (Number(variants[index].width) || 0) * (Number(variants[index].height) || 0),
        }))
        .sort((a, b) => b.pixels - a.pixels);

    for (const item of ordered) {
        if (!indices.includes(item.index)) {
            indices.push(item.index);
        }
        if (indices.length >= limit) {
            break;
        }
    }

    return indices;
}

// 并发探测选中的档位体积（HEAD，不下载正文）
async function probeVariantSizes(variants, limit = VARIANT_PROBE_LIMIT) {
    const indices = selectProbeCandidates(variants, limit);
    await Promise.all(
        indices.map(async (index) => {
            const variant = variants[index];
            variant.size = await probeVideoSize(variant.url);
            variant.size_label = formatSizeLabel(variant.size);
        })
    );
}

// 同画质档位只保留最优档位：体积最大者优先；体积未知时原画优先，其次码率
function dedupeVideoVariants(variants) {
    const byTier = new Map();

    for (const variant of variants) {
        const label = resolutionLabel(variant.width, variant.height);
        const key = label || variant.gear_name || variantKey(variant.url);
        const current = byTier.get(key);
        if (!current || isBetterVariant(variant, current)) {
            byTier.set(key, variant);
        }
    }

    return [...byTier.values()];
}

function isBetterVariant(a, b) {
    const sa = Number(a.size) || 0;
    const sb = Number(b.size) || 0;
    if (sa > 0 || sb > 0) {
        if (sa !== sb) {
            return sa > sb;
        }
    }

    if (Boolean(a.is_original) !== Boolean(b.is_original)) {
        return Boolean(a.is_original);
    }

    return (Number(a.bit_rate) || 0) > (Number(b.bit_rate) || 0);
}

// 单个档位转成统一 JSON 契约里的对象
function formatVariantOutput(variant) {
    const label = variantLabel(variant);
    return {
        label,
        quality: label,
        url: variant.url,
        bit_rate: Number(variant.bit_rate) || 0,
        width: Number(variant.width) || 0,
        height: Number(variant.height) || 0,
        format: variant.format || "mp4",
        codec: variant.codec || "",
        quality_type: Number(variant.quality_type) || 0,
        gear_name: variant.gear_name || "",
        size: Number(variant.size) || 0,
        size_label: variant.size_label || "",
        is_original: Boolean(variant.is_original),
        source: variant.source || "",
    };
}

async function extractHighestQualityVideo(detail) {
    const video = isObject(detail?.video) ? detail.video : {};
    let variants = await extractVideoVariants(video);

    if (!variants.length) {
        // 极端兜底：没有任何 bit_rate 档位时，沿用 play_addr / playApi
        let uri = stringValue(video.uri);
        if (!uri && isObject(video.play_addr) && video.play_addr.uri) {
            uri = String(video.play_addr.uri);
        }

        let playApi =
            typeof video.playApi === "string" && video.playApi
                ? video.playApi
                : isObject(video.play_addr) && Array.isArray(video.play_addr.url_list) && typeof video.play_addr.url_list[0] === "string"
                    ? video.play_addr.url_list[0]
                    : "";

        let url = playApi ? playApi.replace(/playwm/g, "play") : uri ? buildOriginalPlayUrl(uri) : null;
        url = url ? toHttps(url.replace(/playwm/g, "play")) : null;

        return {
            url,
            backup: [],
            gearName: "",
            variants: [],
            is_original: isOriginalSourceUrl(url),
            label: variantLabel({
                is_original: isOriginalSourceUrl(url),
                width: 0,
                height: 0,
                gear_name: "",
                bit_rate: 0,
            }),
            size: 0,
        };
    }

    sortVideoVariants(variants);
    await probeVariantSizes(variants, VARIANT_PROBE_LIMIT);
    sortVideoVariants(variants);
    variants = dedupeVideoVariants(variants);
    sortVideoVariants(variants);

    const best = variants[0];
    const backup = [];
    const variantOutput = [];

    variants.forEach((variant, index) => {
        variant.url = ensureVideoMimeType(variant.url);
        if (index > 0 && variant.url && !backup.includes(variant.url)) {
            backup.push(variant.url);
        }
    });

    for (const variant of variants) {
        variantOutput.push(formatVariantOutput(variant));
    }

    return {
        url: ensureVideoMimeType(best.url),
        backup,
        gearName: best.gear_name || "",
        variants: variantOutput,
        is_original: Boolean(best.is_original),
        label: variantLabel(best),
        size: Number(best.size) || 0,
    };
}

// 统一响应契约辅助：1024 进制 B/KB/MB/GB/TB，最多两位小数且不保留尾部 0
function formatSizeLabel(bytes) {
    const size = Number(bytes);
    if (!Number.isFinite(size) || size <= 0) {
        return "";
    }
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = size;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    if (unit === 0) {
        return `${Math.round(value)}B`;
    }
    const label = value.toFixed(2).replace(/\.?0+$/, "");
    return `${label}${units[unit]}`;
}

// 发布时间归一化：秒级直用，毫秒级（>=1e12）除一次 1000，非法/超范围归 0
function normalizeCreateTime(value) {
    let ts = Number(value);
    if (!Number.isFinite(ts) || ts <= 0) {
        return 0;
    }
    if (ts >= 1000000000000) {
        ts = Math.floor(ts / 1000);
    } else {
        ts = Math.floor(ts);
    }
    if (ts < 1000000000 || ts > 4102444800) {
        return 0;
    }
    return ts;
}

// 固定东八区格式化为 YYYY-MM-DD HH:mm:ss，未知返回空串
function formatPublishTime(createTime) {
    if (!createTime) {
        return "";
    }
    try {
        const formatter = new Intl.DateTimeFormat("zh-CN", {
            timeZone: "Asia/Shanghai",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        });
        const parts = formatter.formatToParts(new Date(createTime * 1000));
        const get = (type) => (parts.find((p) => p.type === type) || {}).value || "";
        return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
    } catch {
        return "";
    }
}

// 有界探测主视频真实字节大小：单次 HEAD、不下载正文，拿不到一律 0（契约允许未知）
async function probeVideoSize(url) {
    if (!url) {
        return 0;
    }
    try {
        const response = await fetch(url, {
            method: "HEAD",
            headers: {
                "user-agent": DEFAULT_UA,
                referer: "https://www.douyin.com/",
            },
        });
        if (!response.ok) {
            return 0;
        }
        const contentType = (response.headers.get("content-type") || "").toLowerCase();
        if (!contentType.includes("video") && !contentType.includes("octet-stream")) {
            return 0;
        }
        const length = Number(response.headers.get("content-length"));
        return Number.isFinite(length) && length > 0 ? Math.floor(length) : 0;
    } catch {
        return 0;
    }
}

function pickCover(detail) {
    const video = isObject(detail?.video) ? detail.video : null;

    if (video) {
        if (Array.isArray(video.originCover?.urlList) && video.originCover.urlList[0]) {
            return String(video.originCover.urlList[0]);
        }
        if (Array.isArray(video.origin_cover?.url_list) && video.origin_cover.url_list[0]) {
            return String(video.origin_cover.url_list[0]);
        }
        if (typeof video.originCover === "string") {
            return video.originCover;
        }
        if (Array.isArray(video.originCoverUrlList) && video.originCoverUrlList[0]) {
            return String(video.originCoverUrlList[0]);
        }

        if (isObject(video.cover)) {
            const line = video.cover.urlList?.[0] || video.cover.url_list?.[0] || "";
            if (typeof line === "string" && line) {
                return line;
            }
        }

        if (typeof video.cover === "string") {
            return video.cover;
        }
    }

    if (Array.isArray(detail?.cover?.url_list) && detail.cover.url_list[0]) {
        return String(detail.cover.url_list[0]);
    }

    if (video) {
        if (Array.isArray(video.dynamicCover?.urlList) && video.dynamicCover.urlList[0]) {
            return String(video.dynamicCover.urlList[0]);
        }
        if (Array.isArray(video.dynamic_cover?.url_list) && video.dynamic_cover.url_list[0]) {
            return String(video.dynamic_cover.url_list[0]);
        }
    }

    if (detail?.videoInfoRes?.item_list?.[0]?.video?.cover?.url_list?.[0]) {
        return String(detail.videoInfoRes.item_list[0].video.cover.url_list[0]);
    }

    let images = Array.isArray(detail?.images) ? detail.images : [];
    if (!images.length && Array.isArray(detail?.image_list)) {
        images = detail.image_list;
    }
    if (images.length && isObject(images[0]) && Array.isArray(images[0].url_list) && images[0].url_list[0]) {
        return String(images[0].url_list[0]);
    }

    return null;
}

function toHttps(url) {
    if (!url) {
        return null;
    }
    return url.startsWith("http://") ? `https://${url.slice(7)}` : url;
}

function host(url) {
    try {
        return new URL(url).host.toLowerCase();
    } catch {
        return null;
    }
}

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value) {
    return typeof value === "string" ? value : value == null ? "" : String(value);
}

// 补齐视频直链的 mime_type=video_mp4（抖音 CDN 约定参数）：已存在该参数则原样返回。
// 只对 http(s) 地址生效；只做字符串追加，不用 URL 对象重写查询串——
// 抖音 CDN 直链带签名参数，重写会改变参数顺序与编码，可能破坏签名。
function ensureVideoMimeType(url) {
    const value = stringValue(url);
    if (!value || !/^https?:\/\//i.test(value)) {
        return value;
    }

    // fragment 不参与查询串判断，追加时要放在 fragment 之前
    const hashIndex = value.indexOf("#");
    const base = hashIndex === -1 ? value : value.slice(0, hashIndex);
    const fragment = hashIndex === -1 ? "" : value.slice(hashIndex);

    const questionIndex = base.indexOf("?");
    if (questionIndex !== -1) {
        for (const pair of base.slice(questionIndex + 1).split("&")) {
            if (safeDecode(pair.split("=")[0]) === "mime_type") {
                return value;
            }
        }
        return `${base}&mime_type=video_mp4${fragment}`;
    }

    return `${base}?mime_type=video_mp4${fragment}`;
}

function safeDecode(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}
