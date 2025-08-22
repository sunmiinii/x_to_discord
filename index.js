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

// 폴백: 정규식을 HTML 전체에 한 번 더
  if (!id) {
    const m = html.match(new RegExp(`/${username}/status/(\\d+)`));
    if (m) id = m[1];
  }
  if (!id) throw new Error("최신 트윗 링크를 찾지 못했습니다.");

  const officialUrl = `https://twitter.com/${username}/status/${id}`;
  return { id, url: officialUrl };
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