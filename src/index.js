// ---------------------------------------------------------------------------
// しあらぼ決済受付（shr-webhook）
//
// 2026-08-01 変更：データベースへの通信を公開キー（SUPABASE_ANON_KEY）から
//   管理者キー（SUPABASE_SERVICE_ROLE_KEY）へ切り替えた。
//   この処理はブラウザに配られないサーバー側の処理であり、公開キーを使う理由が
//   なかった。公開キーのままだと shr_members / shr_events / shr_billing_logs /
//   pay_products を公開キーから閉じられない（閉じた瞬間にこの処理が止まる）。
//   正本：2026-07-30 決定「画面は公開キーでデータベースに直接触らない」
//
//   切替箇所は6つ（supabase() の2・lookupProduct() の2・日次処理の2）と
//   /diag の表示1つ。フォールバックは置いていない。設定漏れを黙って
//   公開キーで動かさないため、未設定なら /diag が「未設定」と出る。
//
// 2026-09-05 変更：新しい会員の表（member / member_subscription）にも
//   同じ人と同じ支払いを写す「二重書き」を足した。
//   ・旧の shr_members への書き込みは 1 行も変えていない。
//   ・学ぶくんとポータルは切り替えの日まで旧の表を読む。新だけに書くと、
//     その間に払った人が入れなくなるため、両方へ書く。
//   ・写しの処理は例外を外へ出さない。決済の処理を止めないため。
//     失敗しても旧の表には正しく入っているので、切り替えの日に写し直せば埋まる。
//   ・権利（member_entitlement）はここでは作らない。プランと権利の対応表が
//     2 つの名前の体系に割れており、どちらが正本かが決まっていないため。
//     権利はいまも旧の道（引き金と定時実行）で組まれる。
//   ・切り替えの日に外すのは syncToNewTables の呼び出し 5 か所だけ。
//   正本：会員の仕組み ― 業務マニュアルの【新】の節
//   https://www.notion.so/3d19c6c1c43981579dc0ded0a37f53ab
// ---------------------------------------------------------------------------

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
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
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
        apikey:        env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
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

// ─────────────────────────────────────────────
// 新しい会員の表への写し（2026-09-05 追加）
//
// 旧の書き込みが終わった後ろで呼ぶ。ここで起きた失敗は外へ出さない。
// 決済の処理を止めないことを、新しい表がそろうことより優先する。
// ─────────────────────────────────────────────

/** 新しい表で決済業者を表す名前。移したときと同じ値を使う */
const NEW_PROVIDER = "univapay";

/**
 * 新しい表に入れてよいメールだけを返す。
 * 小文字にそろえる（member.email は小文字だけを受け付ける決まり）。
 * 仮の値（pending_ で始まる）は入れない。新しい表は「空は空のまま」にする。
 */
function newTableEmail(email) {
  const e = (email ?? "").trim().toLowerCase();
  if (!e || e.startsWith("pending_")) return null;
  return e;
}

/**
 * 新しい member の表へ 1 人を写す。鍵はメール。
 * 返りは member.id。写さなかったときは null。
 */
async function syncNewMember(env, { email, name }, debug) {
  const normalized = newTableEmail(email);
  if (!normalized) {
    debug.steps.push({ step: "newMember", skipped: "no_real_email" });
    return null;
  }

  try {
    const body = { email: normalized, updated_at: new Date().toISOString() };
    if (name) body.name = name;

    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/member?on_conflict=email&select=id`,
      {
        method: "POST",
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify(body),
      }
    );
    const text = await res.text();
    if (!res.ok) {
      debug.steps.push({
        step: "newMember",
        ok: false,
        status: res.status,
        body: text.substring(0, 200),
      });
      return null;
    }
    const rows = text ? JSON.parse(text) : null;
    const memberId = Array.isArray(rows) ? (rows[0]?.id ?? null) : (rows?.id ?? null);
    debug.steps.push({ step: "newMember", ok: true, memberId });
    return memberId;
  } catch (e) {
    debug.steps.push({ step: "newMember", error: e.message });
    return null;
  }
}

/**
 * 新しい member_subscription の表へ支払いを 1 件写す。
 * 鍵は（決済業者・業者側の番号）の組。番号が無いときは行を作らない
 * （銀行振込・単発の注文は支払いの表に載せない決まり）。
 */
async function syncNewSubscription(
  env,
  { memberId, providerRef, plan, status, nextBillingDate },
  debug
) {
  if (!memberId) {
    debug.steps.push({ step: "newSubscription", skipped: "no_member_id" });
    return;
  }
  const ref = (providerRef ?? "").trim();
  if (!ref) {
    debug.steps.push({ step: "newSubscription", skipped: "no_provider_ref" });
    return;
  }

  try {
    const body = {
      member_id:    memberId,
      provider:     NEW_PROVIDER,
      provider_ref: ref,
      status:       status ?? "unknown",
      updated_at:   new Date().toISOString(),
    };
    if (plan) body.plan = plan;
    if (nextBillingDate) body.next_billing_date = nextBillingDate;

    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/member_subscription?on_conflict=provider,provider_ref`,
      {
        method: "POST",
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) {
      const text = await res.text();
      debug.steps.push({
        step: "newSubscription",
        ok: false,
        status: res.status,
        body: text.substring(0, 200),
      });
      return;
    }
    debug.steps.push({ step: "newSubscription", ok: true, providerRef: ref, status: body.status });
  } catch (e) {
    debug.steps.push({ step: "newSubscription", error: e.message });
  }
}

/**
 * 人と支払いをまとめて写す。呼ぶのは旧の書き込みが終わった後。
 * 権利（member_entitlement）はここでは触らない。
 */
async function syncToNewTables(
  env,
  { email, name, subscriptionId, plan, status, nextBillingDate },
  debug
) {
  const memberId = await syncNewMember(env, { email, name }, debug);
  if (subscriptionId) {
    await syncNewSubscription(
      env,
      { memberId, providerRef: subscriptionId, plan, status, nextBillingDate },
      debug
    );
  }
  return memberId;
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
    const isSuspicious = !customer_name;
    const createResult = await supabase(env, "POST", "/shr_members", {
      user_id:               env.DEFAULT_USER_ID,
      email:                 customer_email ?? `pending_${pay_order_id}@shia2n.jp`,
      name:                  customer_name ?? null,
      plan:                  planKey,
      subscription_status:   isSuspicious ? "suspicious" : "active",
      enrolled_at:           new Date().toISOString(),
    });
    if (isSuspicious) {
      result.steps.push({ step: "suspicious_flag", reason: "name_is_null" });
    }
    isNew    = true;
    memberId = Array.isArray(createResult.data) ? createResult.data[0]?.id : createResult.data?.id;
    result.steps.push({ step: "createMember", ok: createResult.ok, memberId });

    // 2026-08-04：要確認（名前が取れていない）ときだけ、管理あてに知らせる。
    // 決済くん経由のこの道は、これまで管理あての知らせを一度も出していなかった。
    // 業者からの通知を直接受ける道は 2026-05 から要確認の知らせを出しており、
    // 同じ出来事なのに片方だけ無音だったため揃える。
    // 通常の入会では出さない。毎回届くと要確認が埋もれるため。
    if (isSuspicious) {
      await sendAdminNotification(
        env,
        {
          email:          customer_email ?? null,
          name:           customer_name ?? null,
          planLabel,
          subscriptionId: pay_order_id ?? "-",
          isSuspicious:   true,
        },
        result
      );
    }

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

  // 新しい表への写し（2026-09-05 追加）。旧の書き込みが終わった後に行う。
  // この道は業者側の継続の番号を持たないので、支払いの行は作らない。
  await syncToNewTables(
    env,
    {
      email: customer_email ?? member?.email ?? null,
      name:  customer_name  ?? member?.name  ?? null,
    },
    result
  );

  result.ok         = true;
  result.isNew      = isNew;
  result.memberId   = memberId;
  result.planKey    = planKey;
  result.planLabel  = planLabel;
  return result;
}

/**
 * 古い窓口（合言葉なし）に決済業者からの通知が届いたことを知らせる。
 *
 * 2026-08-02 追加。合言葉つきの新しい窓口へ移す作業の途中で使う。
 * 決済を止めないため、古い窓口も当面は受け付ける。ただし黙って受け続けると
 * 「業者側の設定を新しいURLへ変えたかどうか」が分からなくなるため、
 * 届くたびに知らせる。このメールが来なくなれば、切り替えが済んだ証拠になる。
 */
async function sendLegacyPathNotice(env, { event, via }, debug) {
  const resendKey   = (env.RESEND_API_KEY     ?? "").trim();
  const fromEmail   = (env.RESEND_FROM_EMAIL  ?? "").trim();
  const notifyEmail = (env.NAOKI_NOTIFY_EMAIL ?? "").trim();

  if (!resendKey || !fromEmail || !notifyEmail) {
    debug.steps.push({ step: "legacyPathNotice", skipped: "env_missing" });
    return;
  }

  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

  const isMismatch    = via === "mismatch";
  const isSecretUnset = via === "secret_missing";

  const subject = isSecretUnset
    ? "【しあらぼNEXT】決済の通知の合言葉が未設定です"
    : isMismatch
      ? "【しあらぼNEXT】決済の通知の合言葉が合っていません"
      : "【しあらぼNEXT】決済の通知が合言葉なしで届きました";

  const lines = isSecretUnset
    ? [
        `この受け口に合言葉が設定されていません。`,
        `安全のため、決済業者からの通知を受け取らずに返しました。`,
        ``,
        `決済業者は時間をおいて送り直すため、通知そのものは失われていません。`,
        `Cloudflare の設定で UNIVAPAY_WEBHOOK_SECRET を入れ直してください。`,
      ]
    : isMismatch
      ? [
          `決済業者からの通知に、設定と違う合言葉が付いていました。`,
          `2026-08-09 から合言葉を必須にしたため、この通知は受け取らずに返しました。`,
          ``,
          `決済業者は時間をおいて送り直すため、通知そのものは失われていません。`,
          `UnivaPay の管理画面で入力した合言葉を、貼り直してください。`,
          `打ち間違い・前後の空白・改行が入っている可能性があります。`,
        ]
      : [
          `決済業者からの通知が、合言葉なしで届きました。`,
          `2026-08-09 から合言葉を必須にしたため、この通知は受け取らずに返しました。`,
          ``,
          `決済業者は時間をおいて送り直すため、通知そのものは失われていません。`,
          `UnivaPay の管理画面で合言葉が設定されているかを確認してください。`,
        ];

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
        subject,
        text: [...lines, ``, `種類：${event ?? "不明"}`, `日時：${now}`].join("\n"),
      }),
    });
    debug.steps.push({ step: "legacyPathNotice", ok: res.ok, status: res.status });
  } catch (e) {
    debug.steps.push({ step: "legacyPathNotice", error: e.message });
  }
}

async function sendAdminNotification(env, { email, name, planLabel, subscriptionId, isSuspicious = false }, debug) {
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
        subject: `【しあらぼNEXT】${isSuspicious ? "⚠️要確認" : "新規入会"}：${name ?? "不明"} (${planLabel})`,
        text: [
          ...(isSuspicious ? [
            `⚠️ 名前が取得できませんでした。カードテスターの可能性があります。要確認。`,
            ``,
          ] : []),
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
      // UTAGE連携は metadata.customer_name キーで送信する
      const name    = meta["customer_name"] ?? meta["univapay-name"] ?? null;
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
        const isSuspicious = !name;
        const createResult = await supabase(env, "POST", "/shr_members", {
          user_id: env.DEFAULT_USER_ID,
          email: email ?? `pending_${subscriptionId}@shia2n.jp`,
          name,
          plan: planKey,
          subscription_status: isSuspicious ? "suspicious" : "pending",
          univa_subscription_id: subscriptionId,
          enrolled_at: new Date().toISOString(),
        });
        if (isSuspicious) {
          debug.steps.push({ step: "suspicious_flag", reason: "name_is_null" });
        }
        debug.steps.push({ step: "createMember", ok: createResult.ok, status: createResult.status, data: createResult.data });

        if (createResult.ok) {
          await sendWelcomeEmail(env, { email, name, plan: planKey, subscriptionId }, debug);
          await sendAdminNotification(env, { email, name, planLabel, subscriptionId, isSuspicious }, debug);
        }
      } else {
        await updateMemberById(env, member.id, {
          subscription_status: "active",
          name: name ?? member.name,
          plan: planKey ?? member.plan,
        });
        debug.steps.push({ step: "updateMember", memberId: member.id });
      }

      // 新しい表への写し（2026-09-05 追加）。旧の書き込みが終わった後に行う。
      // 状態は、いま旧の表へ書いたものと同じ値をそのまま使う。
      await syncToNewTables(
        env,
        {
          email:          email ?? member?.email ?? null,
          name:           name  ?? member?.name  ?? null,
          subscriptionId,
          plan:           planKey ?? member?.plan ?? null,
          status:         member ? "active" : (name ? "pending" : "suspicious"),
        },
        debug
      );
      break;
    }

    case "subscription_payment": {
      if (!member) break;
      const nextDate = new Date();
      nextDate.setMonth(nextDate.getMonth() + 1);
      const nextBillingDate = nextDate.toISOString().split("T")[0];
      await updateMemberById(env, member.id, {
        subscription_status: "active",
        next_billing_date: nextBillingDate,
      });
      await syncToNewTables(
        env,
        {
          email:  member.email,
          name:   member.name,
          subscriptionId,
          plan:   member.plan,
          status: "active",
          nextBillingDate,
        },
        debug
      );
      await sendReceiptEmail(env, member, debug);
      break;
    }

    case "subscription_failed": {
      if (!member) break;
      await updateMemberById(env, member.id, { subscription_status: "past_due" });
      await syncToNewTables(
        env,
        {
          email:  member.email,
          name:   member.name,
          subscriptionId,
          plan:   member.plan,
          status: "past_due",
        },
        debug
      );
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
      await syncToNewTables(
        env,
        {
          email:  member.email,
          name:   member.name,
          subscriptionId,
          plan:   member.plan,
          status: "canceled",
        },
        debug
      );
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
        "apikey":        env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
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

    // 認証の外に置かない：本番に副作用が出る操作は合言葉を必須にする（2026-08-01）
    const requireSecret = () => {
      const secret = (env.SHR_EXTERNAL_SECRET ?? "").trim();
      const auth   = request.headers.get("Authorization") || "";
      const q      = url.searchParams.get("key") || "";
      if (!secret) return json({ error: "SHR_EXTERNAL_SECRET が未設定です" }, 503);
      if (auth !== `Bearer ${secret}` && q !== secret) {
        return json({ error: "Unauthorized" }, 401);
      }
      return null;
    };

    if (url.pathname === "/health") {
      return json({ ok: true });
    }

    if (url.pathname === "/diag") {
      // ------------------------------------------------------------------
      // 2026-08-01 改訂：認証の外に置く画面は「設定あり／未設定」だけを返す。
      //   ・キーの長さ・先頭文字・メールアドレスは出さない
      //   ・本番の会員表への書き込みテストは廃止（生産データを試験対象にしない）
      //   ・外部サービスの応答本文は出さない（つながったかどうかだけ）
      //   正本：認証の外に置く診断画面は表示を存在確認だけに削る（2026-07-31）
      // ------------------------------------------------------------------
      const has = (v) => (v ? "設定あり" : "未設定");

      const diag = {
        env_check: {
          SUPABASE_URL:              has(env.SUPABASE_URL),
          SUPABASE_SERVICE_ROLE_KEY:  has(env.SUPABASE_SERVICE_ROLE_KEY),
          DEFAULT_USER_ID:           has(env.DEFAULT_USER_ID),
          UNIVA_APP_TOKEN:           has(env.UNIVA_APP_TOKEN),
          UNIVA_APP_SECRET:          has(env.UNIVA_APP_SECRET),
          UNIVA_STORE_ID:            has(env.UNIVA_STORE_ID),
          HIGH_SHIN_API_BASE:        has(env.HIGH_SHIN_API_BASE),
          HIGH_SHIN_INTERNAL_SECRET: has(env.HIGH_SHIN_INTERNAL_SECRET),
          RESEND_API_KEY:            has(env.RESEND_API_KEY),
          NAOKI_NOTIFY_EMAIL:        has(env.NAOKI_NOTIFY_EMAIL),
          SHR_EXTERNAL_SECRET:       has(env.SHR_EXTERNAL_SECRET),
          UNIVAPAY_WEBHOOK_SECRET:   has(env.UNIVAPAY_WEBHOOK_SECRET),
        },
      };

      // 疎通は「つながるか」だけ。件数・中身は返さない。
      try {
        const ping = await supabase(env, "GET", "/shr_members?select=id&limit=1");
        diag.supabase_ping = ping.ok ? "OK" : "NG";
      } catch {
        diag.supabase_ping = "NG";
      }

      try {
        const ping = await supabase(env, "GET", "/pay_products?select=id&limit=1");
        diag.pay_products_ping = ping.ok ? "OK" : "NG";
      } catch {
        diag.pay_products_ping = "NG";
      }

      try {
        const ping = await supabase(env, "GET", "/shr_events?select=id&limit=1");
        diag.shr_events_ping = ping.ok ? "OK" : "NG";
      } catch {
        diag.shr_events_ping = "NG";
      }

      // 新しい会員の表への写し先（2026-09-05 追加）。つながるかだけを返す。
      try {
        const ping = await supabase(env, "GET", "/member?select=id&limit=1");
        diag.new_member_ping = ping.ok ? "OK" : "NG";
      } catch {
        diag.new_member_ping = "NG";
      }

      try {
        const ping = await supabase(env, "GET", "/member_subscription?select=id&limit=1");
        diag.new_member_subscription_ping = ping.ok ? "OK" : "NG";
      } catch {
        diag.new_member_subscription_ping = "NG";
      }

      try {
        const product = await lookupProduct(env, "standard");
        diag.lookup_standard = product ? "OK" : "NG";
      } catch {
        diag.lookup_standard = "NG";
      }

      try {
        const secret  = (env.UNIVA_APP_SECRET ?? "").trim();
        const token   = (env.UNIVA_APP_TOKEN ?? "").trim();
        const storeId = (env.UNIVA_STORE_ID ?? "").trim();
        const uniRes = await fetch(
          `https://api.univapay.com/stores/${storeId}`,
          { headers: { "Authorization": `Bearer ${secret}.${token}` } }
        );
        diag.univapay_ping = uniRes.ok ? "OK" : "NG";
      } catch {
        diag.univapay_ping = "NG";
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
          diag.high_shin_ping = hsRes.ok ? "OK" : "NG";
        } catch {
          diag.high_shin_ping = "NG";
        }
      } else {
        diag.high_shin_ping = "未設定";
      }

      return json(diag);
    }

    // Cronテスト用エンドポイント（今日のイベント通知を手動実行）
    if (url.pathname === "/test-cron" && request.method === "GET") {
      const ng1 = requireSecret();
      if (ng1) return ng1;

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

      // 2026-08-04：決済くんは商品の番号を product_id という名前で送っている。
      // こちらは pay_product_id しか読んでおらず、常に空として扱っていた。
      // その結果、商品が引けずプランが standard に決め打ちされていた（既存会員の
      // 上書きも含む）。送る側を変えると他の呼び出し元を巻き添えにするため、
      // 受け取る側で両方の名前を受け付ける。
      const { customer_email, customer_name, pay_order_id, amount } = body;
      const pay_product_id = body.pay_product_id ?? body.product_id ?? null;
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

    // ── 決済業者からの通知の受け口 ───────────────────────────────
    // 2026-08-02：合言葉つきの受け取りを用意した。次の2つのどちらでもよい。
    //   ① 見出し（Authorization）に合言葉を入れる ← 決済くんと同じ方式・推奨
    //   ② URL に合言葉を足す： /univapay/<合言葉> または /univapay?key=<合言葉>
    // 旧： /univapay（合言葉なし・当面は受け付ける）
    // 決済が止まらないよう、業者側の設定を変えるまでは旧も通す。
    // 旧に届いたときは知らせのメールを送り、切り替えが済んだかを分かるようにする。
    const isUnivapayPath =
      url.pathname === "/univapay" || url.pathname.startsWith("/univapay/");

    if (isUnivapayPath && request.method === "POST") {
      const webhookSecret = (env.UNIVAPAY_WEBHOOK_SECRET ?? "").trim();

      const fromPath  = url.pathname.startsWith("/univapay/")
        ? url.pathname.slice("/univapay/".length)
        : "";
      const fromQuery = url.searchParams.get("key") ?? "";
      const fromUrl   = (fromPath || fromQuery).trim();

      // 見出しは、合言葉そのものでも「Bearer 合言葉」でも受け取る
      const rawHeader    = (request.headers.get("Authorization") ?? "").trim();
      const fromHeader   = rawHeader.replace(/^Bearer\s+/i, "").trim();

      const supplied = Boolean(fromUrl || fromHeader);
      const viaSecret =
        Boolean(webhookSecret) && (fromUrl === webhookSecret || fromHeader === webhookSecret);

      const via = viaSecret ? "new" : (supplied ? "mismatch" : "legacy");

      // 2026-08-09 段階3：合言葉を必須にした。
      // 8/02〜8/09 の間、合言葉なし・合言葉違いの知らせは1通も届かなかった
      // （受信箱2つで実測・対照つき）。業者側の設定が効いていることを確認できたため、
      // 合言葉の無い通知・違う通知は受け取らずに返す。
      // 断っても通知は失われない。決済業者は 2xx が返るまで送り直すため。
      // 合言葉が未設定のときも断る。未設定で素通しに戻ると、閉じた穴がそのまま開くため。
      if (via !== "new") {
        const reason = webhookSecret ? via : "secret_missing";
        await sendLegacyPathNotice(env, { event: null, via: reason }, { steps: [] });
        return webhookSecret
          ? json({ error: "unauthorized" }, 401)
          : json({ error: "webhook_secret_not_configured" }, 503);
      }

      let payload;
      try {
        payload = await request.json();
      } catch {
        return json({ error: "invalid_json" }, 400);
      }

      const event = payload?.event;
      if (!event) return json({ error: "no_event" }, 400);

      const debug = { event, steps: [], via };

      try {
        await handleEvent(env, event, payload, debug);
      } catch (err) {
        console.error("[shr-webhook] error:", err.message);
        return json({ ok: false, error: err.message, debug });
      }

      return json({ ok: true, event, debug });
    }

    if (url.pathname === "/test-welcome" && request.method === "GET") {
      const ng2 = requireSecret();
      if (ng2) return ng2;

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
