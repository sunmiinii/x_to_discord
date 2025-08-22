// import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * ENV
 * - DISCORD_WEBHOOK: 디스코드 웹훅 URL (Repository secret)
 * - LUNLUN: 감시할 X(트위터) 사용자명 (@ 없이) (Repository variable)
 * - NITTER_BASE: 선택. 기본값 https://nitter.net (원치 않으면 다른 인스턴스)
 */
const webhook = process.env.DISCORD_WEBHOOK;
const user = process.env.LUNLUN;
const nitterBase = process.env.NITTER_BASE || "https://nitter.net";

// ── 현재 파일 기준으로 repo 루트의 state.json 경로 계산
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const statePath = path.join(__dirname, "state.json");

// ── 디버그 로그: 환경 세팅 확인
console.log("ENV check:", {
  HAS_WEBHOOK: Boolean(webhook),
  USER: user,
  NITTER: nitterBase,
});

if (!webhook) {
  console.error("❌ DISCORD_WEBHOOK 환경변수가 없습니다.");
  process.exit(1);
}
if (!user) {
  console.error("❌ TW_USER 환경변수가 없습니다.");
  process.exit(1);
}

// ── state.json 읽기: 없으면 기본값 반환
async function readState() {
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { lastId: null, updatedAt: null };
  }
}

// ── state.json 쓰기: 마지막 트윗 ID와 업데이트 시간 기록
async function writeState(newId) {
  const data = { lastId: newId, updatedAt: new Date().toISOString() };
  await fs.writeFile(statePath, JSON.stringify(data, null, 2), "utf-8");
}

// 1) 최신 트윗의 "공식 URL 문자열"을 반환 (여러 패턴 지원)
async function fetchLatestTweetUrl(username) {
  const url = `${nitterBase}/${encodeURIComponent(username)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`Nitter 요청 실패: ${res.status} ${res.statusText}`);

  const html = await res.text();
  const $ = cheerio.load(html);

  // 디버그(옵션): 페이지가 이상하면 길이/타이틀 확인
  // console.log("nitter html length:", html.length);
  // console.log("page title:", $("title").text());

  // 후보 셀렉터: 트윗 상세 링크에 자주 쓰이는 것들
  const candidates = $('a.tweet-link, .timeline-item .tweet-date a, a[href*="/status/"]');

  let id = null;
  let foundHref = null;

  candidates.each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;

    // ① 본인 트윗: /<user>/status/<id>(#m 등 옵셔널 앵커)
    let m = href.match(new RegExp(`^/${username}/status/(\\d+)`));
    if (m) {
      id = m[1];
      foundHref = href;
      return false; // 첫 매치 사용
    }

    // ② /i/status/<id> 형태 (작성자 이름이 링크에 안 나오는 경우)
    m = href.match(/^\/i\/status\/(\d+)/);
    if (m) {
      id = m[1];
      foundHref = href;
      return false;
    }

    // ③ 타 계정 트윗(리트윗 등): /<someone>/status/<id>
    m = href.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/);
    if (m) {
      id = m[2];
      foundHref = href;
      return false;
    }
  });

  if (!id) {
    // 폴백: 페이지 전체 텍스트에서라도 /status/<id>를 긁어본다
    const m =
      html.match(new RegExp(`/${username}/status/(\\d+)`)) ||
      html.match(/\/i\/status\/(\d+)/) ||
      html.match(/\/[A-Za-z0-9_]{1,15}\/status\/(\d+)/);
    if (m) id = m[1];
  }

  if (!id) throw new Error("최신 트윗 링크를 찾지 못했습니다.");

  // 최종 URL 만들기
  let finalUrl;
  if (foundHref && foundHref.startsWith("/i/status/")) {
    // /i/status/…는 i/web/status로 바로 공유 가능
    finalUrl = `https://twitter.com/i/web/status/${id}`;
  } else {
    // 작성자명 얻기(없으면 대상 username 사용)
    let author = username;
    if (foundHref) {
      const m = foundHref.match(/^\/([A-Za-z0-9_]{1,15})\/status/);
      if (m) author = m[1];
    }
    finalUrl = `https://twitter.com/${author}/status/${id}`;
  }

  return finalUrl;
}

// 2) 래퍼: { id, url } 형태로 반환 (dedup에 쓰기 좋게)
async function fetchLatestTweet(username) {
  const url = await fetchLatestTweetUrl(username);
  const m = url.match(/\/status\/(\d+)/);
  if (!m) throw new Error("트윗 ID를 URL에서 추출하지 못했습니다.");
  return { id: m[1], url };
}

// ── Discord 웹훅으로 전송
async function sendToDiscord(content) {
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`Discord 전송 실패: ${res.status} ${await res.text()}`);
}

(async () => {
  try {
    // 1) 이전 상태 읽기
    const state = await readState();
    console.log("Prev state:", state);

    // 2) 최신 트윗 가져와서 ID 비교
    const latest = await fetchLatestTweet(user);
    console.log("Latest tweet:", latest);

    if (state.lastId && state.lastId === latest.id) {
      console.log("🔁 새 트윗 없음. 전송 스킵.");
      process.exit(0);
    }

    // 3) 새 트윗이면 전송
    await sendToDiscord(`🆕 @${user} 최신 트윗: ${latest.url}`);

    // 4) 상태 업데이트 파일 작성 (커밋은 워크플로우가 처리)
    await writeState(latest.id);
    console.log("✅ 상태 업데이트 완료:", latest.id);
  } catch (err) {
    console.error("❌ 오류:", err.message);
    process.exit(1);
  }
})();