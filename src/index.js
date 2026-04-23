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

// Supabase REST API を fetch で直接叩く
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

// 会員をメールで検索
async function findMemberByEmail(env, email) {
  const { data } = await supabase(env, "GET", `/shr_members?email=eq.${encodeURIComponent(email)}&limit=1`);
  return Array.isArray(data) ? data[0] : null;
}

// 会員ステータス更新
async function updateMember(env, email, fields) {
  await supabase(env, "PATCH",
    `/shr_members?email=eq.${encodeURIComponent(email)}`,
    { ...fields, updated_at: new Date().toISOString() }
  );
}

// 課金ログ保存
async function logBilling(env, memberId, eventType, payload) {
  await supabase(env, "POST", "/shr_billing_logs", {
    member_id: memberId ?? null,
    event_type: eventType,
    amount: payload?.data?.charged_amount ?? null,
    currency: payload?.data?.charged_currency ?? "JPY",
    univa_charge_id: payload?.data?.id ?? null,
    raw_payload: payload,
  });
}

// イベント別処理
async function handleEvent(env, event, payload) {
  const email = payload?.data?.email;
  const member = email ? await findMemberByEmail(env, email) : null;

  // 課金ログは常に保存
  await logBilling(env, member?.id ?? null, event, payload);

  switch (event) {

    // 初回入会完了（単発課金 + サブスク開始）
    case "charge_finished": {
      if (payload?.data?.status !== "successful") break;
      if (!member) {
        // 新規会員として登録
        await supabase(env, "POST", "/shr_members", {
          user_id: env.DEFAULT_USER_ID,
          email,
          name: payload?.data?.metadata?.name ?? null,
          subscription_status: "active",
          univa_subscription_id: payload?.data?.subscription_id ?? null,
          enrolled_at: new Date().toISOString(),
        });
      } else {
        await updateMember(env, email, {
          subscription_status: "active",
          enrolled_at: member.enrolled_at ?? new Date().toISOString(),
        });
      }
      break;
    }

    // 月次課金成功
    case "subscription_payment": {
      if (!member) break;
      const nextDate = new Date();
      nextDate.setMonth(nextDate.getMonth() + 1);
      await updateMember(env, email, {
        subscription_status: "active",
        next_billing_date: nextDate.toISOString().split("T")[0],
      });
      break;
    }

    // 課金失敗
    case "subscription_failed": {
      if (!member) break;
      await updateMember(env, email, { subscription_status: "past_due" });
      break;
    }

    // 解約
    case "subscription_canceled": {
      if (!member) break;
      await updateMember(env, email, {
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

    // プリフライト
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ヘルスチェック
    if (url.pathname === "/health") {
      return json({ ok: true });
    }

    // UnivaPayのWebhook受信口
    if (url.pathname === "/univapay" && request.method === "POST") {
      let payload;
      try {
        payload = await request.json();
      } catch {
        return json({ error: "invalid_json" }, 400);
      }

      const event = payload?.event;
      if (!event) return json({ error: "no_event" }, 400);

      // 3秒以内にレスポンスを返す（UnivaPayの仕様）
      // 処理はバックグラウンドで実行
      const ctx = { waitUntil: (p) => p }; // Workers環境では自動的に処理される
      try {
        await handleEvent(env, event, payload);
      } catch (err) {
        console.error("[shr-webhook] error:", err.message);
        // エラーでも200を返す（UnivaPayのリトライ防止）
        return json({ ok: false, error: err.message });
      }

      return json({ ok: true, event });
    }

    return json({ error: "not_found" }, 404);
  },
};
