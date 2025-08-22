import fetch from "node-fetch";
import * as cheerio from "cheerio";

/**
 * ENV
 * - DISCORD_WEBHOOK: 디스코드 웹훅 URL (Repository secret)
 * - TW_USER: 감시할 X(트위터) 사용자명 (@ 없이) (Repository variable)
 * - NITTER_BASE: 선택. 기본값 https://nitter.net (원치 않으면 다른 인스턴스)
 */
const webhook = process.env.DISCORD_WEBHOOK;
const user = process.env.TW_USER;
const nitterBase = process.env.NITTER_BASE || "https://nitter.net";

if (!webhook) {
  console.error("❌ DISCORD_WEBHOOK 환경변수가 없습니다.");
  process.exit(1);
}
if (!user) {
  console.error("❌ TW_USER 환경변수가 없습니다.");
  process.exit(1);
}

async function fetchLatestTweetUrl(username) {
  // 1) Nitter에서 해당 유저 페이지 HTML 가져오기
  const url = `${nitterBase}/${encodeURIComponent(username)}`;
  const res = await fetch(url, {
    headers: {
      // 약간의 헤더를 주면 차단 확률을 낮출 수 있음
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    },
  });

  if (!res.ok) {
    throw new Error(`Nitter 요청 실패: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();

  // 2) HTML 파싱해서 '/<user>/status/<id>' 형태의 첫 트윗 링크 찾기
  const $ = cheerio.load(html);

  // 안전하게: 페이지 안의 모든 <a> 중에서 해당 패턴을 가장 먼저 찾기
  let tweetPath = null;
  const pattern = new RegExp(`^/${username}/status/(\\d+)`);

  $("a").each((_, a) => {
    const href = $(a).attr("href");
    if (href && pattern.test(href)) {
      tweetPath = href; // 예: /jack/status/1234567890123456789
      return false; // 첫 번째만 사용
    }
  });

  if (!tweetPath) {
    // 폴백: 정규식으로 전체 HTML에서라도 한 번 더 시도
    const m = html.match(new RegExp(`/${username}/status/(\\d+)`));
    if (m) {
      tweetPath = `/${username}/status/${m[1]}`;
    }
  }

  if (!tweetPath) {
    throw new Error("최신 트윗 링크를 찾지 못했습니다.");
  }

  // 3) 공식 링크 형태로 반환(공유는 twitter.com 링크가 익숙함)
  const tweetId = tweetPath.split("/").pop();
  return `https://twitter.com/${username}/status/${tweetId}`;
}

async function sendToDiscord(content) {
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord 전송 실패: ${res.status} ${text}`);
  }
}

(async () => {
  try {
    console.log("ENV has DISCORD_WEBHOOK:", {
      HAS_WEBHOOK: Boolean(process.env.DISCORD_WEBHOOK)
      USER: user,
      NITTER: nitterBase,
    });

    const latestUrl = await fetchLatestTweetUrl(user);
    console.log("Latest tweet URL:", latestUrl);

    // [1단계] 일단 매번 전송 (중복 방지는 다음 단계에서 추가)
    await sendToDiscord(`🆕 @${user} 최신 트윗: ${latestUrl}`);

    console.log("✅ 완료");
  } catch (err) {
    console.error("❌ 오류:", err.message);
    process.exit(1);
  }
})();