// Node 18/20: fetch는 내장. 별도 node-fetch 불필요.
import * as cheerio from "cheerio";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * ENV
 * - DISCORD_WEBHOOK: 디스코드 웹훅 URL (Repository secret)
 * - LUNLUN: 감시할 X(트위터) 사용자명 (@ 없이) (Repository variable)
 * - NITTER_LIST: 시도할 Nitter 인스턴스 목록(쉼표구분). 없으면 기본 3개 사용
 * - DEBUG: "1"이면 상세 로그 출력
 */

const webhook = process.env.DISCORD_WEBHOOK;
const users = (process.env.LUNLUN_LIST || process.env.LUNLUN).split(",").map(s=>s.trim());
    for (const u of users) {
    const { id, url } = await fetchLatestTweet(u);
    // u별 state 파일 분리 권장: state-u.json
}
const DEBUG = process.env.DEBUG === "1";

// Nitter 후보들(왼쪽부터 시도)
const NITTERS = (process.env.NITTER_LIST ||
  "https://nitter.net,https://nitter.poast.org,https://n.opnxng.com")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// ── repo 루트의 state.json 경로 계산
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const statePath = path.join(__dirname, "state.json");

// ── 디버그 로그: 환경 세팅 확인
console.log("ENV check:", {
  HAS_WEBHOOK: Boolean(webhook),
  USER: user,
  NITTERS,
  DEBUG
});

if (!webhook) {
  console.error("❌ DISCORD_WEBHOOK 환경변수가 없습니다.");
  process.exit(1);
}
if (!user) {
  console.error("❌ LUNLUN 환경변수가 없습니다. (감시할 사용자명을 넣으세요)");
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

// ── 타임아웃 보조
function withTimeout(ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(timer) };
}

// ── HTML에서 최신 트윗 id/href 추출 (여러 패턴 지원)
function extractLatestIdFromHtml(username, html) {
  const $ = cheerio.load(html);
  const candidates = $('a.tweet-link, .timeline-item .tweet-date a, a[href*="/status/"]');

  let id = null;
  let foundHref = null;

  candidates.each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;

    // ① 본인 트윗: /<user>/status/<id>
    let m = href.match(new RegExp(`^/${username}/status/(\\d+)`));
    if (m) { id = m[1]; foundHref = href; return false; }

    // ② /i/status/<id>
    m = href.match(/^\/i\/status\/(\d+)/);
    if (m) { id = m[1]; foundHref = href; return false; }

    // ③ 타 계정 트윗(리트윗/고정): /<someone>/status/<id>
    m = href.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/);
    if (m) { id = m[2]; foundHref = href; return false; }
  });

  if (!id) {
    // 폴백: 원시 HTML에서라도 /status/<id> 검색
    const m =
      html.match(new RegExp(`/${username}/status/(\\d+)`)) ||
      html.match(/\/i\/status\/(\d+)/) ||
      html.match(/\/[A-Za-z0-9_]{1,15}\/status\/(\d+)/);
    if (m) id = m[1];
  }

  return { id, foundHref, title: $("title").text(), len: html.length };
}

// ── 여러 Nitter 인스턴스를 순차 시도해서 최신 트윗 URL 반환
async function fetchLatestTweetUrl(username) {
  const ua =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

  for (const base of NITTERS) {
    const url = `${base}/${encodeURIComponent(username)}`;
    try {
      const { signal, clear } = withTimeout(8000);
      const res = await fetch(url, { headers: { "User-Agent": ua }, signal });
      clear();

      if (!res.ok) {
        if (DEBUG) console.log(`Nitter ${base} 응답 ${res.status} — 다음으로 시도`);
        continue;
      }
      const html = await res.text();

      const { id, foundHref, title, len } = extractLatestIdFromHtml(username, html);
      if (DEBUG) console.log(`[${base}] title="${title}" len=${len} id=${id} href=${foundHref || "-"}`);

      if (!id) {
        if (DEBUG) console.log(`Nitter ${base}에서 /status/ ID를 못 찾음 — 다음으로 시도`);
        continue;
      }

      // 최종 URL 만들기
      if (foundHref && foundHref.startsWith("/i/status/")) {
        return `https://twitter.com/i/web/status/${id}`;
      }
      let author = username;
      if (foundHref) {
        const m = foundHref.match(/^\/([A-Za-z0-9_]{1,15})\/status/);
        if (m) author = m[1];
      }
      return `https://twitter.com/${author}/status/${id}`;
    } catch (e) {
      if (DEBUG) console.log(`Nitter ${base} 요청 오류(${e.name}) — 다음으로 시도`);
      continue;
    }
  }

  // 마지막 폴백: r.jina.ai 정적 렌더로 /status/<id>만 추출
  try {
    const fallback = `https://r.jina.ai/http://nitter.net/${encodeURIComponent(username)}`;
    const res = await fetch(fallback);
    if (res.ok) {
      const text = await res.text();
      const m =
        text.match(new RegExp(`/${username}/status/(\\d+)`)) ||
        text.match(/\/i\/status\/(\d+)/) ||
        text.match(/\/[A-Za-z0-9_]{1,15}\/status\/(\d+)/);
      if (m) {
        const id = m[1];
        return `https://twitter.com/i/web/status/${id}`;
      }
    }
  } catch (_) {}

  throw new Error("최신 트윗 링크를 찾지 못했습니다.");
}

// ── { id, url }로 래핑 (dedup에 필요)
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
    body: JSON.stringify({
        embeds: [{
        title: `@${user} 새 트윗`,
        url: latest.url,
        description: latest.url,
        }]
    })
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
