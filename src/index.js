const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function supabase(env, method, path, body) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      "apikey": env.SUPABASE_ANON_KEY,
      "Authorization": `Bearer ${env.SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      "Prefer": method === "POST" ? "return=representation" : "return=minimal",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null };
}

// UnivaPayのトランザクショントークンからemailを取得
async function getEmailFromUnivaPay(env, tokenId) {
  const secret  = (env.UNIVA_APP_SECRET ?? "").trim();
  const token   = (env.UNIVA_APP_TOKEN ?? "").trim();
  const storeId = (env.UNIVA_STORE_ID ?? "").trim();
  const res = await fetch(
    `https://api.univapay.com/stores/${storeId}/tokens/${tokenId}`,
    {
      headers: {
        "Authorization": `Bearer ${secret}.${token}`,
        "Content-Type": "application/json",
      },
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data?.email ?? null;
}

// subscription_id で会員を検索
async function findMemberBySubscriptionId(env, subscriptionId) {
  const { data } = await supabase(env, "GET",
    `/shr_members?univa_subscription_id=eq.${subscriptionId}&limit=1`
  );
  return Array.isArray(data) ? data[0] : null;
}

// pay_products テーブルから plan_key に対応する商品情報を取得
async function lookupProduct(env, planKey) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/pay_products` +
    `?user_id=eq.${env.DEFAULT_USER_ID}` +
    `&plan_key=eq.${encodeURIComponent(planKey)}` +
    `&active=eq.true` +
    `&select=name,payment_status&limit=1`,
    {
      headers: {
        apikey:        env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      },
    }
  );
  const rows = await res.json();
  return rows?.[0] ?? null;
}

async function getPlanLabel(env, planKey) {
  const product = await lookupProduct(env, planKey ?? "standard");
  return product?.name ?? planKey ?? "スタンダード";
}

async function updateMemberById(env, id, fields) {
  await supabase(env, "PATCH",
    `/shr_members?id=eq.${id}`,
    { ...fields, updated_at: new Date().toISOString() }
  );
}

async function logBilling(env, memberId, eventType, payload) {
  return await supabase(env, "POST", "/shr_billing_logs", {
    member_id: memberId ?? null,
    event_type: eventType,
    amount: payload?.data?.charged_amount ?? payload?.data?.amount ?? null,
    currency: payload?.data?.charged_currency ?? payload?.data?.currency ?? "JPY",
    univa_charge_id: payload?.data?.id ?? null,
    raw_payload: payload,
  });
}

async function sendWelcomeEmail(env, { email, name, plan, subscriptionId }, debug) {
  if (!email || email.startsWith("pending_")) {
    debug.steps.push({ step: "sendWelcome", skipped: "no_valid_email" });
    return;
  }

  const base   = (env.HIGH_SHIN_API_BASE ?? "").trim();
  const secret = (env.HIGH_SHIN_INTERNAL_SECRET ?? "").trim();

  if (!base || !secret) {
    debug.steps.push({ step: "sendWelcome", skipped: "env_missing" });
    return;
  }

  try {
    const res = await fetch(`${base}/api/internal/send-welcome`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, name, plan, subscriptionId }),
    });
    const text = await res.text();
    debug.steps.push({
      step: "sendWelcome",
      ok: res.ok,
      status: res.status,
      body: text.substring(0, 200),
    });
  } catch (e) {
    debug.steps.push({ step: "sendWelcome", error: e.message });
  }
}

// ─────────────────────────────────────────────
// Pay-kun トリガーから呼ばれる外部 API 用のコア処理
// POST /api/external/register-member から呼び出す
// ─────────────────────────────────────────────
async function registerMemberCore(env, {
  pay_product_id,
  customer_email,
  customer_name,
  pay_order_id,
  amount,
}) {
  const result = { steps: [] };

  // 1. email で shr_members を検索
  let member = null;
  if (customer_email && !customer_email.startsWith("pending_")) {
    const { data } = await supabase(env, "GET",
      `/shr_members?email=eq.${encodeURIComponent(customer_email)}&order=enrolled_at.desc&limit=1`
    );
    member = Array.isArray(data) ? data[0] : null;
  }

  // 2. pay_products から plan_key・payment_status を取得
  let product = null;
  if (pay_product_id) {
    const { data } = await supabase(env, "GET",
      `/pay_products?id=eq.${pay_product_id}&active=eq.true&select=name,plan_key,payment_status&limit=1`
    );
    product = Array.isArray(data) ? data[0] : null;
  }
  const planKey       = product?.plan_key       ?? "standard";
  const paymentStatus = product?.payment_status ?? "basic";
  const planLabel     = product?.name           ?? planKey;

  result.steps.push({ step: "lookupProduct", planKey, paymentStatus, found: !!product });

  let isNew = false;
  let memberId = null;

  if (!member) {
    // 3a. 新規会員 INSERT
    const createResult = await supabase(env, "POST", "/shr_members", {
      user_id:               env.DEFAULT_USER_ID,
      email:                 customer_email ?? `pending_${pay_order_id}@shia2n.jp`,
      name:                  customer_name ?? null,
      plan:                  planKey,
      subscription_status:   "active",
      enrolled_at:           new Date().toISOString(),
    });
    isNew    = true;
    memberId = Array.isArray(createResult.data) ? createResult.data[0]?.id : createResult.data?.id;
    result.steps.push({ step: "createMember", ok: createResult.ok, memberId });

    // 新規会員には enroll-to-sequence を呼ぶ（選択肢A: shr-webhook が直接呼ぶ）
    const base   = (env.HIGH_SHIN_API_BASE ?? "").trim();
    const secret = (env.HIGH_SHIN_INTERNAL_SECRET ?? "").trim();
    if (base && secret && customer_email && !customer_email.startsWith("pending_")) {
      try {
        const enrollRes = await fetch(`${base}/api/internal/enroll-to-sequence`, {
          method: "POST",
          headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            contact_email:        customer_email,
            sequence_trigger_key: "shr_member_created",
            user_id:              env.DEFAULT_USER_ID,
          }),
        });
        const enrollText = await enrollRes.text();
        result.steps.push({ step: "enrollToSequence", ok: enrollRes.ok, status: enrollRes.status, body: enrollText.substring(0, 200) });
      } catch (e) {
        // enroll 失敗は会員登録自体を止めない
        result.steps.push({ step: "enrollToSequence", error: e.message });
      }
    } else {
      result.steps.push({ step: "enrollToSequence", skipped: "env_missing_or_no_email" });
    }

  } else {
    // 3b. 既存会員 UPDATE（プラン変更等）
    memberId = member.id;
    await supabase(env, "PATCH", `/shr_members?id=eq.${member.id}`, {
      subscription_status: "active",
      plan:                planKey,
      name:                customer_name ?? member.name,
      updated_at:          new Date().toISOString(),
    });
    result.steps.push({ step: "updateMember", memberId: member.id });
  }

  result.ok         = true;
  result.isNew      = isNew;
  result.memberId   = memberId;
  result.planKey    = planKey;
  result.planLabel  = planLabel;
  return result;
}

async function sendAdminNotification(env, { email, name, planLabel, subscriptionId }, debug) {
  const resendKey   = (env.RESEND_API_KEY    ?? "").trim();
  const fromEmail   = (env.RESEND_FROM_EMAIL ?? "").trim();
  const notifyEmail = (env.NAOKI_NOTIFY_EMAIL ?? "").trim();

  if (!resendKey || !fromEmail || !notifyEmail) {
    debug.steps.push({ step: "adminNotify", skipped: "env_missing" });
    return;
  }

  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [notifyEmail],
        subject: `【しあらぼNEXT】新規入会：${name ?? "不明"} (${planLabel})`,
        text: [
          `新規入会がありました。`,
          ``,
          `名前：${name ?? "不明"}`,
          `メール：${email ?? "取得失敗"}`,
          `プラン：${planLabel}`,
          `サブスクID：${subscriptionId}`,
          `日時：${now}`,
          ``,
          `Supabase確認：https://supabase.com/dashboard/project/htzadzpckcpdrmpjvaut/editor`,
        ].join("\n"),
      }),
    });
    const data = await res.json();
    debug.steps.push({ step: "adminNotify", ok: res.ok, status: res.status, messageId: data.id });
  } catch (e) {
    debug.steps.push({ step: "adminNotify", error: e.message });
  }
}

async function sendEmail(env, { to, subject, text }) {
  const resendKey = (env.RESEND_API_KEY    ?? "").trim();
  const fromEmail = (env.RESEND_FROM_EMAIL ?? "").trim();
  if (!resendKey || !fromEmail) return { ok: false, reason: "env_missing" };

  const html = `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:'Hiragino Sans','Noto Sans JP',sans-serif;font-size:14px;color:#1A1A1A;line-height:1.8;padding:24px;">
${text.split("\n").map(line => line === "" ? "<br>" : `<p style="margin:0">${line}</p>`).join("\n")}
</body></html>`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: fromEmail, to: [to], subject, text, html }),
    });
    const data = await res.json();
    return { ok: res.ok, status: res.status, messageId: data.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function sendReceiptEmail(env, member, debug) {
  if (!member?.email || member.email.startsWith("pending_")) {
    debug.steps.push({ step: "receiptEmail", skipped: "no_valid_email" });
    return;
  }
  const planLabel = await getPlanLabel(env, member.plan);
  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  const result = await sendEmail(env, {
    to: member.email,
    subject: `【しあらぼNEXT】月次更新のご案内（${planLabel}）`,
    text: [
      `${member.name ?? "会員"} さん`,
      ``,
      `しあらぼNEXT（${planLabel}）の月次更新が完了しました。`,
      `引き続きご利用いただけます。`,
      ``,
      `更新日時：${now}`,
      `プラン：${planLabel}`,
      ``,
      `ポータル：https://portal.shia2n.jp`,
      ``,
      `ご不明な点は https://shia2n.jp よりお問い合わせください。`,
    ].join("\n"),
  });
  debug.steps.push({ step: "receiptEmail", ...result });
}

async function sendFailureEmailToUser(env, member, debug) {
  if (!member?.email || member.email.startsWith("pending_")) {
    debug.steps.push({ step: "failureEmailUser", skipped: "no_valid_email" });
    return;
  }
  const planLabel = await getPlanLabel(env, member.plan);
  const result = await sendEmail(env, {
    to: member.email,
    subject: `【しあらぼNEXT】決済処理に失敗しました`,
    text: [
      `${member.name ?? "会員"} さん`,
      ``,
      `しあらぼNEXT（${planLabel}）の月次決済処理に失敗しました。`,
      `お支払い情報をご確認のうえ、サポートまでご連絡ください。`,
      ``,
      `サポート：https://shia2n.jp`,
      ``,
      `このまま解決しない場合、サービスのご利用が一時停止される場合があります。`,
    ].join("\n"),
  });
  debug.steps.push({ step: "failureEmailUser", ...result });
}

async function sendFailureEmailToAdmin(env, member, debug) {
  const notifyEmail = (env.NAOKI_NOTIFY_EMAIL ?? "").trim();
  if (!notifyEmail) {
    debug.steps.push({ step: "failureEmailAdmin", skipped: "env_missing" });
    return;
  }
  const planLabel = await getPlanLabel(env, member?.plan);
  const result = await sendEmail(env, {
    to: notifyEmail,
    subject: `【しあらぼNEXT】決済失敗：${member?.name ?? "不明"} (${planLabel})`,
    text: [
      `決済失敗が発生しました。`,
      ``,
      `名前：${member?.name ?? "不明"}`,
      `メール：${member?.email ?? "不明"}`,
      `プラン：${planLabel}`,
      `サブスクID：${member?.univa_subscription_id ?? "不明"}`,
      ``,
      `Supabase確認：https://supabase.com/dashboard/project/htzadzpckcpdrmpjvaut/editor`,
    ].join("\n"),
  });
  debug.steps.push({ step: "failureEmailAdmin", ...result });
}

async function sendCancellationEmail(env, member, debug) {
  if (!member?.email || member.email.startsWith("pending_")) {
    debug.steps.push({ step: "cancellationEmail", skipped: "no_valid_email" });
    return;
  }
  const planLabel = await getPlanLabel(env, member.plan);
  const result = await sendEmail(env, {
    to: member.email,
    subject: `【しあらぼNEXT】解約が完了しました`,
    text: [
      `${member.name ?? "会員"} さん`,
      ``,
      `しあらぼNEXT（${planLabel}）の解約が完了しました。`,
      `これまでご利用いただきありがとうございました。`,
      ``,
      `再入会をご希望の場合は以下からお手続きください。`,
      `https://shia2n.jp`,
    ].join("\n"),
  });
  debug.steps.push({ step: "cancellationEmail", ...result });
}

async function handleEvent(env, event, payload, debug = { steps: [] }) {
  const subscriptionId =
    payload?.data?.subscription_id ??
    payload?.data?.id;

  debug.subscriptionId = subscriptionId;

  const member = subscriptionId
    ? await findMemberBySubscriptionId(env, subscriptionId)
    : null;

  debug.memberFound = !!member;
  debug.memberId = member?.id ?? null;

  const logResult = await logBilling(env, member?.id ?? null, event, payload);
  debug.steps.push({ step: "logBilling", ok: logResult.ok, status: logResult.status });

  switch (event) {

    case "charge_finished": {
      if (payload?.data?.status !== "successful") break;
      const meta    = payload?.data?.metadata ?? {};
      const name    = meta["univapay-name"] ?? null;
      const planKey = meta["plan"] ?? "standard";
      const tokenId = payload?.data?.transaction_token_id;

      const product = await lookupProduct(env, planKey);
      if (!product) {
        const errMsg = `unknown plan_key: ${planKey}`;
        console.error(`[shr-webhook] ${errMsg}`);
        debug.steps.push({ step: "lookupProduct", error: errMsg });
      }
      const planLabel     = product?.name           ?? planKey;
      const paymentStatus = product?.payment_status ?? "basic";
      debug.steps.push({ step: "lookupProduct", planKey, planLabel, paymentStatus });

      let email = null;
      try {
        email = tokenId ? await getEmailFromUnivaPay(env, tokenId) : null;
        debug.steps.push({ step: "getEmail", email: email ?? "null" });
      } catch (e) {
        debug.steps.push({ step: "getEmail", error: e.message });
      }

      if (!member) {
        const createResult = await supabase(env, "POST", "/shr_members", {
          user_id: env.DEFAULT_USER_ID,
          email: email ?? `pending_${subscriptionId}@shia2n.jp`,
          name,
          plan: planKey,
          subscription_status: "pending",
          univa_subscription_id: subscriptionId,
          enrolled_at: new Date().toISOString(),
        });
        debug.steps.push({ step: "createMember", ok: createResult.ok, status: createResult.status, data: createResult.data });

        if (createResult.ok) {
          await sendWelcomeEmail(env, { email, name, plan: planKey, subscriptionId }, debug);
          await sendAdminNotification(env, { email, name, planLabel, subscriptionId }, debug);
        }
      } else {
        await updateMemberById(env, member.id, {
          subscription_status: "active",
          name: name ?? member.name,
          plan: planKey ?? member.plan,
        });
        debug.steps.push({ step: "updateMember", memberId: member.id });
      }
      break;
    }

    case "subscription_payment": {
      if (!member) break;
      const nextDate = new Date();
      nextDate.setMonth(nextDate.getMonth() + 1);
      await updateMemberById(env, member.id, {
        subscription_status: "active",
        next_billing_date: nextDate.toISOString().split("T")[0],
      });
      await sendReceiptEmail(env, member, debug);
      break;
    }

    case "subscription_failed": {
      if (!member) break;
      await updateMemberById(env, member.id, { subscription_status: "past_due" });
      await sendFailureEmailToUser(env, member, debug);
      await sendFailureEmailToAdmin(env, member, debug);
      break;
    }

    case "subscription_canceled": {
      if (!member) break;
      await updateMemberById(env, member.id, {
        subscription_status: "canceled",
        canceled_at: new Date().toISOString(),
      });
      await sendCancellationEmail(env, member, debug);
      break;
    }
  }
}

// ─────────────────────────────────────────────
// 毎朝9時（0:00 UTC）の自動イベント通知
// ─────────────────────────────────────────────

const EVENT_TYPE_LABEL = {
  seminar:  "セミナー作業会",
  special:  "特別セミナー",
  offline:  "オフライン",
  party:    "オンライン飲み会",
  workshop: "作業・交流会",
  other:    "その他",
};

const SEMINAR_SEND_TEMPLATE = (title, zoom) =>
`🔥本日21時🔥
【しあらぼセミナー作業会】

今夜は
「${title}」
を開催します！

必ずリアル参加して理解度を上げていきましょう！

《Zoomリンク》
${zoom || "https://us02web.zoom.us/j/9297844714"}

ミーティングID: 929 784 4714`;

function buildEventNotificationHtml(events, today) {
  const rows = events.map(ev => {
    const typeLabel = EVENT_TYPE_LABEL[ev.type] || ev.type;
    const isSeminar = ev.type === "seminar" || ev.type === "special";

    const zoomBlock = ev.zoom
      ? `<p style="margin:8px 0 0;font-size:13px;">
           Zoom: <a href="${ev.zoom}" style="color:#4B72FF;">${ev.zoom}</a>
         </p>`
      : "";

    const templateBlock = isSeminar
      ? `<div style="margin:12px 0 0;background:#F0F4FF;border-left:3px solid #4B72FF;padding:10px 14px;border-radius:0 6px 6px 0;">
           <div style="font-size:10px;color:#4B72FF;font-weight:700;letter-spacing:1px;margin-bottom:8px;">配信テンプレ（コピーしてLINEへ）</div>
           <pre style="margin:0;font-size:12px;color:#333;white-space:pre-wrap;font-family:monospace;">${SEMINAR_SEND_TEMPLATE(ev.title, ev.zoom)}</pre>
         </div>`
      : "";

    return `
      <div style="background:#fff;border:1px solid #E8E4DF;border-radius:8px;padding:16px;margin-bottom:12px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          <span style="background:#EEF1FF;color:#4B72FF;border-radius:4px;padding:2px 10px;font-size:11px;font-weight:700;">${typeLabel}</span>
          ${ev.time ? `<span style="font-size:12px;color:#888;">${ev.time}</span>` : ""}
        </div>
        <div style="font-size:17px;font-weight:800;color:#1A1A2E;">${ev.title}</div>
        ${zoomBlock}
        ${templateBlock}
      </div>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>今日のイベント通知</title>
</head>
<body style="margin:0;padding:0;background:#F7F5F2;font-family:'Hiragino Sans','Noto Sans JP',sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px;">

    <div style="background:linear-gradient(135deg,#1A1A2E 0%,#2D1B5E 100%);border-radius:12px 12px 0 0;padding:24px;">
      <div style="font-size:10px;color:rgba(255,255,255,0.4);letter-spacing:2px;margin-bottom:6px;">SHIARABO ADMIN</div>
      <div style="font-size:22px;font-weight:800;color:#fff;line-height:1.2;">今日のイベント通知</div>
      <div style="font-size:13px;color:rgba(255,255,255,0.6);margin-top:6px;">${today}</div>
    </div>

    <div style="background:#F7F5F2;padding:20px;border:1px solid #E8E4DF;border-top:none;border-radius:0 0 12px 12px;">
      ${rows}
      <div style="text-align:center;margin-top:20px;">
        <a href="https://admin.shia2n.jp"
           style="display:inline-block;background:#4B72FF;color:#fff;border-radius:8px;padding:11px 28px;font-size:13px;font-weight:700;text-decoration:none;">
          管理画面を開く
        </a>
      </div>
    </div>

    <div style="text-align:center;margin-top:12px;font-size:11px;color:#A8A4B0;">
      毎朝9:00に自動送信 | しあらぼ管理システム
    </div>
  </div>
</body>
</html>`;
}

async function handleScheduled(event, env, ctx) {
  // JST（UTC+9）で今日の日付を取得
  const now   = new Date();
  const jst   = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const today = jst.toISOString().split("T")[0]; // "2025-06-18"

  console.log(`[cron] 実行日: ${today}`);

  // shr_events から今日のイベントを取得
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/shr_events?date=eq.${today}&select=*&order=time.asc`,
    {
      headers: {
        "apikey":        env.SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${env.SUPABASE_ANON_KEY}`,
      },
    }
  );

  if (!res.ok) {
    console.error(`[cron] Supabase fetch failed: ${res.status}`);
    return;
  }

  const events = await res.json();
  if (!Array.isArray(events) || events.length === 0) {
    console.log(`[cron] ${today}: イベントなし、通知スキップ`);
    return;
  }

  console.log(`[cron] ${today}: ${events.length}件のイベントを通知`);

  const resendKey   = (env.RESEND_API_KEY     ?? "").trim();
  const fromEmail   = (env.RESEND_FROM_EMAIL  ?? "").trim();
  const notifyEmail = (env.NAOKI_NOTIFY_EMAIL ?? "").trim();

  if (!resendKey || !fromEmail || !notifyEmail) {
    console.error("[cron] Resend環境変数が未設定");
    return;
  }

  const subject  = `【今日のイベント】${events.map(e => e.title).join(" / ")}`;
  const html     = buildEventNotificationHtml(events, today);

  const emailRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${resendKey}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      from: fromEmail,
      to:   [notifyEmail],
      subject,
      html,
    }),
  });

  if (emailRes.ok) {
    console.log(`[cron] 通知メール送信完了: ${subject}`);
  } else {
    const err = await emailRes.text();
    console.error(`[cron] Resend error: ${err}`);
  }
}

// ─────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/health") {
      return json({ ok: true });
    }

    if (url.pathname === "/diag") {
      const diag = {
        env_check: {
          SUPABASE_URL:              env.SUPABASE_URL              ? "set" : "MISSING",
          SUPABASE_ANON_KEY:         env.SUPABASE_ANON_KEY         ? `set (length=${env.SUPABASE_ANON_KEY.length})` : "MISSING",
          DEFAULT_USER_ID:           env.DEFAULT_USER_ID           ? `set (${env.DEFAULT_USER_ID.substring(0, 8)}...)` : "MISSING",
          UNIVA_APP_TOKEN:           env.UNIVA_APP_TOKEN           ? `set (${env.UNIVA_APP_TOKEN.substring(0, 8)}...)` : "MISSING",
          UNIVA_APP_SECRET:          env.UNIVA_APP_SECRET          ? `set (length=${env.UNIVA_APP_SECRET.length})` : "MISSING",
          UNIVA_STORE_ID:            env.UNIVA_STORE_ID            ? `set (${env.UNIVA_STORE_ID.substring(0, 8)}...)` : "MISSING",
          HIGH_SHIN_API_BASE:        env.HIGH_SHIN_API_BASE        ? `set (${env.HIGH_SHIN_API_BASE})` : "MISSING",
          HIGH_SHIN_INTERNAL_SECRET: env.HIGH_SHIN_INTERNAL_SECRET ? `set (length=${env.HIGH_SHIN_INTERNAL_SECRET.length})` : "MISSING",
          RESEND_API_KEY:            env.RESEND_API_KEY            ? `set (length=${env.RESEND_API_KEY.length})` : "MISSING",
          NAOKI_NOTIFY_EMAIL:        env.NAOKI_NOTIFY_EMAIL        ? `set (${env.NAOKI_NOTIFY_EMAIL})` : "MISSING",
          SHR_EXTERNAL_SECRET:       env.SHR_EXTERNAL_SECRET       ? `set (length=${env.SHR_EXTERNAL_SECRET.length})` : "MISSING",
        },
      };

      try {
        const ping = await supabase(env, "GET", "/shr_members?limit=1");
        diag.supabase_ping = { ok: ping.ok, status: ping.status };
      } catch (e) {
        diag.supabase_ping = { error: e.message };
      }

      try {
        const ping = await supabase(env, "GET", "/pay_products?limit=1");
        diag.pay_products_ping = { ok: ping.ok, status: ping.status, count: ping.data?.length ?? 0 };
      } catch (e) {
        diag.pay_products_ping = { error: e.message };
      }

      // shr_events 疎通テスト（新規追加）
      try {
        const ping = await supabase(env, "GET", "/shr_events?limit=1");
        diag.shr_events_ping = { ok: ping.ok, status: ping.status, count: ping.data?.length ?? 0 };
      } catch (e) {
        diag.shr_events_ping = { error: e.message };
      }

      try {
        const product = await lookupProduct(env, "standard");
        diag.lookup_standard = product
          ? { found: true, name: product.name, payment_status: product.payment_status }
          : { found: false };
      } catch (e) {
        diag.lookup_standard = { error: e.message };
      }

      try {
        const testId = `test-${Date.now()}`;
        const insert = await supabase(env, "POST", "/shr_members", {
          user_id: env.DEFAULT_USER_ID ?? "test-uid",
          email: `diag_${testId}@shia2n.jp`,
          name: "診断テスト",
          plan: "standard",
          subscription_status: "active",
          univa_subscription_id: testId,
        });
        diag.test_insert = { ok: insert.ok, status: insert.status };
        if (insert.ok) {
          await supabase(env, "DELETE", `/shr_members?univa_subscription_id=eq.${testId}`);
          diag.test_insert.cleaned_up = true;
        } else {
          diag.test_insert.error_detail = insert.data;
        }
      } catch (e) {
        diag.test_insert = { error: e.message };
      }

      try {
        const secret  = (env.UNIVA_APP_SECRET ?? "").trim();
        const token   = (env.UNIVA_APP_TOKEN ?? "").trim();
        const storeId = (env.UNIVA_STORE_ID ?? "").trim();
        const uniRes = await fetch(
          `https://api.univapay.com/stores/${storeId}`,
          { headers: { "Authorization": `Bearer ${secret}.${token}` } }
        );
        const uniText = await uniRes.text();
        diag.univapay_ping = { ok: uniRes.ok, status: uniRes.status, body: uniText.substring(0, 300) };
      } catch (e) {
        diag.univapay_ping = { error: e.message };
      }

      if (env.HIGH_SHIN_API_BASE && env.HIGH_SHIN_INTERNAL_SECRET) {
        try {
          const hsRes = await fetch(
            `${env.HIGH_SHIN_API_BASE}/api/internal/send-welcome`,
            {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${env.HIGH_SHIN_INTERNAL_SECRET}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ ping: true }),
            }
          );
          const hsText = await hsRes.text();
          diag.high_shin_ping = { ok: hsRes.ok, status: hsRes.status, body: hsText.substring(0, 200) };
        } catch (e) {
          diag.high_shin_ping = { error: e.message };
        }
      } else {
        diag.high_shin_ping = { skipped: "env_missing" };
      }

      return json(diag);
    }

    // Cronテスト用エンドポイント（今日のイベント通知を手動実行）
    if (url.pathname === "/test-cron" && request.method === "GET") {
      try {
        await handleScheduled({}, env, {});
        return json({ ok: true, message: "Cron実行完了。メールを確認してください。" });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // ─────────────────────────────────────────────
    // Pay-kun トリガーから呼ばれる外部 API
    // POST /api/external/register-member
    // ─────────────────────────────────────────────
    if (url.pathname === "/api/external/register-member" && request.method === "POST") {
      // 認証
      const auth   = request.headers.get("Authorization") || "";
      const secret = (env.SHR_EXTERNAL_SECRET ?? "").trim();
      if (!secret || auth !== `Bearer ${secret}`) {
        return json({ error: "Unauthorized" }, 401);
      }

      let body;
      try { body = await request.json(); }
      catch { return json({ error: "invalid_json" }, 400); }

      const { pay_product_id, customer_email, customer_name, pay_order_id, amount } = body;
      if (!customer_email && !pay_product_id) {
        return json({ error: "customer_email or pay_product_id is required" }, 400);
      }

      try {
        const result = await registerMemberCore(env, {
          pay_product_id,
          customer_email,
          customer_name,
          pay_order_id,
          amount,
        });
        return json({
          ok:            result.ok,
          shr_member_id: result.memberId,
          is_new:        result.isNew,
          plan_key:      result.planKey,
          steps:         result.steps,
        });
      } catch (e) {
        console.error("[shr-webhook] register-member error:", e.message);
        return json({ error: e.message }, 500);
      }
    }

    if (url.pathname === "/univapay" && request.method === "POST") {
      let payload;
      try {
        payload = await request.json();
      } catch {
        return json({ error: "invalid_json" }, 400);
      }

      const event = payload?.event;
      if (!event) return json({ error: "no_event" }, 400);

      const debug = { event, steps: [] };
      try {
        await handleEvent(env, event, payload, debug);
      } catch (err) {
        console.error("[shr-webhook] error:", err.message);
        return json({ ok: false, error: err.message, stack: err.stack, debug });
      }

      return json({ ok: true, event, debug });
    }

    if (url.pathname === "/test-welcome" && request.method === "GET") {
      const email          = url.searchParams.get("email");
      const name           = url.searchParams.get("name") ?? "テストユーザー";
      const planKey        = url.searchParams.get("plan") ?? "standard";
      const subscriptionId = `test-${Date.now()}`;

      if (!email) {
        return json({ error: "emailパラメータが必要です。例: /test-welcome?email=you@example.com" }, 400);
      }

      const planLabel = await getPlanLabel(env, planKey);
      const debug = { steps: [] };
      await sendWelcomeEmail(env, { email, name, plan: planKey, subscriptionId }, debug);
      await sendAdminNotification(env, { email, name, planLabel, subscriptionId }, debug);

      return json({ ok: true, sentTo: email, name, planKey, planLabel, subscriptionId, debug });
    }

    return json({ error: "not_found" }, 404);
  },

  scheduled: handleScheduled,
};
