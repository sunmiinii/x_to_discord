import fetch from "node-fetch";

const webhook = process.env.DISCORD_WEBHOOK;

async function sendMessage() {
  if (!webhook) {
    console.error("DISCORD_WEBHOOK 환경변수가 없습니다.");
    process.exit(1);
  }

  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "🚀 Node.js에서 보낸 메시지!" })
  });

  if (res.ok) {
    console.log("✅ 메시지 전송 성공");
  } else {
    console.error("❌ 전송 실패", res.status, await res.text());
    process.exit(1);
  }
}

sendMessage();