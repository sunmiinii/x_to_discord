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

/ 1) 기반 함수: 최신 트윗의 "공식 URL 문자열"을 반환
async function fetchLatestTweetUrl(username) {
  const url = `${nitterBase}/${encodeURIComponent(username)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    },
  });
  if (!res.ok) {
    throw new Error(`Nitter 요청 실패: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  // /<user>/status/<id> 패턴을 가진 첫 번째 링크에서 id 추출
  const re = new RegExp(`^/${username}/status/(\\d+)`);
  let id = null;

  $("a").each((_, a) => {
    const href = $(a).attr("href");
    const m = href && re.exec(href);
    if (m) {
      id = m[1];           // 숫자 ID만
      return false;        // 첫 번째 매치에서 중단
    }
  });

  // 폴백: 페이지 전체에서 한 번 더 정규식으로 검색
  if (!id) {
    const m = html.match(new RegExp(`/${username}/status/(\\d+)`));
    if (m) id = m[1];
  }

  if (!id) throw new Error("최신 트윗 링크를 찾지 못했습니다.");

  return `https://twitter.com/${username}/status/${id}`;
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