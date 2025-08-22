// index.js v2.1 — multi Nitter + batch send + deep debug
import * as cheerio from "cheerio";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * ENV
 * - DISCORD_WEBHOOK: 디스코드 웹훅 URL (Secret)
 * - LUNLUN: 감시할 X 사용자명 (@ 제외) (Variable)
 * - NITTER_LIST: 시도할 Nitter 인스턴스 목록(쉼표 구분)
 * - NITTER_BASE: (선택) 기본 nitter 인스턴스. 미설정 시 https://nitter.net
 * - DEBUG: "1"이면 상세로그
 */
const VERSION = "v2.1";
const webhook = process.env.DISCORD_WEBHOOK;
const user = process.env.LUNLUN;
const DEBUG = process.env.DEBUG === "1";

// 기본/커스텀 인스턴스 목록 구성
const nitterBase = process.env.NITTER_BASE || "https://nitter.net";
const DEFAULT_NITTERS = [
  nitterBase,
  "https://nitter.poast.org",
  "https://n.opnxng.com",
  "https://nitter.fdn.fr",
  "https://nitter.privacydev.net"
];
const NITTER_LIST = (process.env.NITTER_LIST
  ? process.env.NITTER_LIST.split(",").map(s => s.trim()).filter(Boolean)
  : DEFAULT_NITTERS);

// repo 루트의 state.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const statePath = path.join(__dirname, "state.json");

// 시작 로그
console.log("Boot:", { VERSION, DEBUG });
console.log("ENV check:", {
  HAS_WEBHOOK: Boolean(webhook),
  USER: user,
  NITTERS: NITTER_LIST
});

if (!webhook) {
  console.error("❌ DISCORD_WEBHOOK 환경변수가 없습니다.");
  process.exit(1);
}
if (!user) {
  console.error("❌ LUNLUN 환경변수가 없습니다. (감시할 사용자명을 넣으세요)");
  process.exit(1);
}

// ── util: 파일 I/O
async function readState() {
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { lastId: null, updatedAt: null };
  }
}
async function writeState(newId) {
  const data = { lastId: newId, updatedAt: new Date().toISOString() };
  await fs.writeFile(statePath, JSON.stringify(data, null, 2), "utf-8");
}

// ── util: 타임아웃
function withTimeout(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(t) };
}

// ── 파서: HTML에서 최근 트윗 여러 개 추출
function extractRecentFromHtml(username, html, max = 5) {
  const $ = cheerio.load(html);
  const candidates = $('a.tweet-link, .timeline-item .tweet-date a, a[href*="/status/"]');
  const seen = new Set();
  const out = [];

  candidates.each((_, a) => {
    if (out.length >= max) return false;
    const href = $(a).attr("href");
    if (!href) return;

    // /<author>/status/<id>
    let m = href.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/);
    if (m) {
      const [ , author, id ] = m;
      if (!seen.has(id)) { seen.add(id); out.push({ id, author, href }); }
      return;
    }

    // /i/status/<id>
    m = href.match(/^\/i\/status\/(\d+)/);
    if (m) {
      const id = m[1];
      if (!seen.has(id)) { seen.add(id); out.push({ id, author: username, href }); }
    }
  });

  // 부족하면 원시 HTML에서 보강
  if (out.length < max) {
    const re = /\/(?:i\/status|[A-Za-z0-9_]{1,15}\/status)\/(\d+)/g;
    let m;
    while ((m = re.exec(html)) && out.length < max) {
      const id = m[1];
      if (!seen.has(id)) {
        seen.add(id);
        out.push({ id, author: username, href: `/i/status/${id}` });
      }
    }
  }
  return out;
}

// ── 네트워크: 여러 Nitter 인스턴스에서 최근 트윗 n개 가져오기
async function fetchRecentTweets(username, max = 5) {
  const ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

  for (const base of NITTER_LIST) {
    const url = `${base}/${encodeURIComponent(username)}`;
    try {
      if (DEBUG) console.log(`→ Try ${base}`);
      const { signal, clear } = withTimeout(8000);
      const res = await fetch(url, { headers: { "User-Agent": ua }, signal });
      clear();

      if (!res.ok) {
        if (DEBUG) console.log(`  ${base} HTTP ${res.status} — skip`);
        continue;
      }

      const html = await res.text();
      const items = extractRecentFromHtml(username, html, max);

      if (DEBUG) {
        const $ = cheerio.load(html);
        console.log(`  [${base}] title="${$("title").text()}" len=${html.length} items=${items.length}`);
      }

      if (items.length > 0) {
        // href를 공식 URL로 변환
        return items.map(({ id, author, href }) => {
          if (href.startsWith("/i/status/")) {
            return { id, url: `https://twitter.com/i/web/status/${id}` };
          }
          const m = href.match(/^\/([A-Za-z0-9_]{1,15})\/status/);
          const finalAuthor = m ? m[1] : (author || username);
          return { id, url: `https://twitter.com/${finalAuthor}/status/${id}` };
        });
      }
      if (DEBUG) console.log(`  ${base} no /status/ found — next`);
    } catch (e) {
      if (DEBUG) console.log(`  ${base} ${e.name} — next`);
      continue;
    }
  }

  // 폴백: 정적 렌더
  try {
    const fallback = `https://r.jina.ai/http://nitter.net/${encodeURIComponent(username)}`;
    if (DEBUG) console.log(`→ Fallback ${fallback}`);
    const res = await fetch(fallback);
    if (res.ok) {
      const text = await res.text();
      const ids = [...text.matchAll(/\/(?:i\/status|[A-Za-z0-9_]{1,15}\/status)\/(\d+)/g)].map(m => m[1]);
      const uniq = [...new Set(ids)].slice(0, max);
      if (uniq.length) {
        return uniq.map(id => ({ id, url: `https://twitter.com/i/web/status/${id}` }));
      }
    } else if (DEBUG) {
      console.log(`  Fallback HTTP ${res.status}`);
    }
  } catch (_) {}

  throw new Error("최신 트윗 링크를 찾지 못했습니다.");
}

// ── (옵션) 단일 최신만 필요할 때
async function fetchLatestTweet(username) {
  const list = await fetchRecentTweets(username, 1);
  return list[0]; // { id, url }
}

// ── Discord 전송
async function sendToDiscord(content) {
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content })
  });
  if (!res.ok) throw new Error(`Discord 전송 실패: ${res.status} ${await res.text()}`);
}

// ── 메인
(async () => {
  try {
    const state = await readState();
    console.log("Prev state:", state);

    // 최근 5개 후보
    const recents = await fetchRecentTweets(user, 5);
    console.log("Recent tweets:", recents.map(t => t.id));

    // lastId 이후 것만, 오래된 것부터 전송
    let toSend;
    if (!state.lastId) {
      // 첫 실행: 스팸 방지 위해 1건만
      toSend = recents.slice(0, 1);
    } else {
      const idx = recents.findIndex(t => t.id === state.lastId);
      toSend = idx === -1 ? recents : recents.slice(0, idx);
    }
    toSend.reverse();

    if (toSend.length === 0) {
      console.log("🔁 새 트윗 없음. 전송 스킵.");
      process.exit(0);
    }

    for (const t of toSend) {
      await sendToDiscord(`🆕 @${user} 최신 트윗: ${t.url}`);
    }

    const newestId = toSend[toSend.length - 1].id;
    await writeState(newestId);
    console.log("✅ 상태 업데이트 완료:", newestId);
  } catch (err) {
    console.error("❌ 오류:", err.message);
    process.exit(1);
  }
})();