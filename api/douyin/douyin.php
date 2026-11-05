<?php
/**
 * @Author: JH-Ahua
 * @CreateTime: 2026/1/19 下午8:59
 * @UpdateTime: 2026/10/19
 * @email: admin@bugpk.com
 * @blog: www.jiuhunwl.cn
 * @Api: api.bugpk.com
 * @tip: 抖音解析统一入口，免 Cookie，支持短视频、图集、实况
 */

require_once 'DouyinParser.php';

header("Access-Control-Allow-Origin: *");
header('Content-Type: application/json; charset=utf-8');

// 获取请求参数（GET 原样截取 url= 之后的完整内容，兼容未编码的分享文本）
$url = null;
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $fullUrl = $_SERVER['REQUEST_URI'];
    $urlParamPos = strpos($fullUrl, 'url=');
    if ($urlParamPos !== false) {
        $rawUrl = substr($fullUrl, $urlParamPos + 4);
        // url= 之后若还跟了 quality=/variant=，先剥掉这些尾部参数再还原链接
        $rawUrl = preg_replace('/(?:[?&](?:quality|variant|codec)=[^&]*)+$/i', '', $rawUrl);
        $url = urldecode($rawUrl);
    }
} else {
    $url = $_POST['url'] ?? null;
}

if (!$url && isset($_GET['url'])) {
    $url = $_GET['url'];
}

// 清晰度选择：quality=1080p / h264 / original，或 variant=2（档位下标）；
// 都不传时输出排序后的最高画质，保持旧行为。
$quality = '';
$variant = null;
foreach ([$_GET, $_POST] as $source) {
    if ($quality === '' && isset($source['quality']) && is_scalar($source['quality'])) {
        $quality = trim((string)$source['quality']);
    }
    if ($variant === null && isset($source['variant']) && is_scalar($source['variant']) && $source['variant'] !== '') {
        $variant = is_numeric($source['variant']) ? (int)$source['variant'] : null;
    }
}

$parser = new DouyinParser();
echo $parser->parse($url, ['quality' => $quality, 'variant' => $variant]);
