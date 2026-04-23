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

// 会員ステータス更新
async function updateMemberById(env, id, fields) {
  await supabase(env, "PATCH",
    `/shr_members?id=eq.${id}`,
    { ...fields, updated_at: new Date().toISOString() }
  );
}

// 課金ログ保存
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

// High-Shinくんのウェルカムメール送信を依頼
async function sendWelcomeEmail(env, { email, name, plan, subscriptionId }, debug) {
  // pending_ プレースホルダーの場合はスキップ
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
    // メール送信失敗はWebhook全体を失敗させない
    debug.steps.push({ step: "sendWelcome", error: e.message });
  }
}


// Naokiへの新規入会通知メール
async function sendAdminNotification(env, { email, name, plan, subscriptionId }, debug) {
  const resendKey   = (env.RESEND_API_KEY    ?? "").trim();
  const fromEmail   = (env.RESEND_FROM_EMAIL ?? "").trim();
  const notifyEmail = (env.NAOKI_NOTIFY_EMAIL ?? "").trim();

  if (!resendKey || !fromEmail || !notifyEmail) {
    debug.steps.push({ step: "adminNotify", skipped: "env_missing" });
    return;
  }

  const planLabel = plan === "premium" ? "プレミアム" : "スタンダード";
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
      const plan    = meta["plan"] ?? "standard";
      const tokenId = payload?.data?.transaction_token_id;

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
          plan,
          subscription_status: "pending",
          univa_subscription_id: subscriptionId,
          enrolled_at: new Date().toISOString(),
        });
        debug.steps.push({ step: "createMember", ok: createResult.ok, status: createResult.status, data: createResult.data });

        // 新規会員にウェルカムメールを送信
        if (createResult.ok) {
          await sendWelcomeEmail(env, { email, name, plan, subscriptionId }, debug);
          // Naokiに入会通知
          await sendAdminNotification(env, { email, name, plan, subscriptionId }, debug);
        }
      } else {
        await updateMemberById(env, member.id, {
          subscription_status: "active",
          name: name ?? member.name,
          plan: plan ?? member.plan,
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
      break;
    }

    case "subscription_failed": {
      if (!member) break;
      await updateMemberById(env, member.id, { subscription_status: "past_due" });
      break;
    }

    case "subscription_canceled": {
      if (!member) break;
      await updateMemberById(env, member.id, {
        subscription_status: "canceled",
        canceled_at: new Date().toISOString(),
      });
      break;
    }
  }
}

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
          SUPABASE_URL:             env.SUPABASE_URL             ? "set" : "MISSING",
          SUPABASE_ANON_KEY:        env.SUPABASE_ANON_KEY        ? `set (length=${env.SUPABASE_ANON_KEY.length})` : "MISSING",
          DEFAULT_USER_ID:          env.DEFAULT_USER_ID          ? `set (${env.DEFAULT_USER_ID.substring(0, 8)}...)` : "MISSING",
          UNIVA_APP_TOKEN:          env.UNIVA_APP_TOKEN          ? `set (${env.UNIVA_APP_TOKEN.substring(0, 8)}...)` : "MISSING",
          UNIVA_APP_SECRET:         env.UNIVA_APP_SECRET         ? `set (length=${env.UNIVA_APP_SECRET.length})` : "MISSING",
          UNIVA_STORE_ID:           env.UNIVA_STORE_ID           ? `set (${env.UNIVA_STORE_ID.substring(0, 8)}...)` : "MISSING",
          HIGH_SHIN_API_BASE:       env.HIGH_SHIN_API_BASE       ? `set (${env.HIGH_SHIN_API_BASE})` : "MISSING",
          HIGH_SHIN_INTERNAL_SECRET: env.HIGH_SHIN_INTERNAL_SECRET ? `set (length=${env.HIGH_SHIN_INTERNAL_SECRET.length})` : "MISSING",
        },
      };

      // Supabase疎通テスト
      try {
        const ping = await supabase(env, "GET", "/shr_members?limit=1");
        diag.supabase_ping = { ok: ping.ok, status: ping.status };
      } catch (e) {
        diag.supabase_ping = { error: e.message };
      }

      // Supabase書き込みテスト
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

      // UnivaPayのAPI疎通テスト
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

      // High-Shin疎通テスト（/api/internal/send-welcome のヘルスチェック）
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

    // テスト用：ブラウザからウェルカムメール送信を確認する
    // 例: /test-welcome?email=you@example.com&name=テスト太郎&plan=standard
    if (url.pathname === "/test-welcome" && request.method === "GET") {
      const email          = url.searchParams.get("email");
      const name           = url.searchParams.get("name") ?? "テストユーザー";
      const plan           = url.searchParams.get("plan") ?? "standard";
      const subscriptionId = `test-${Date.now()}`;

      if (!email) {
        return json({ error: "emailパラメータが必要です。例: /test-welcome?email=you@example.com" }, 400);
      }

      const debug = { steps: [] };
      await sendWelcomeEmail(env, { email, name, plan, subscriptionId }, debug);

      return json({ ok: true, sentTo: email, name, plan, subscriptionId, debug });
    }

    return json({ error: "not_found" }, 404);
  },
};
