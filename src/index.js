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

async function handleEvent(env, event, payload, debug = { steps: [] }) {
  // subscription_id を取得（イベント種別によって場所が違う）
  const subscriptionId =
    payload?.data?.subscription_id ?? // charge_finished
    payload?.data?.id;                // subscription_payment / failed / canceled

  debug.subscriptionId = subscriptionId;

  const member = subscriptionId
    ? await findMemberBySubscriptionId(env, subscriptionId)
    : null;

  debug.memberFound = !!member;
  debug.memberId = member?.id ?? null;

  // 課金ログは常に保存
  const logResult = await logBilling(env, member?.id ?? null, event, payload);
  debug.steps.push({ step: "logBilling", result: logResult });

  switch (event) {

    // 初回課金完了 → 新規会員作成 or アクティブ化
    case "charge_finished": {
      if (payload?.data?.status !== "successful") break;
      const meta = payload?.data?.metadata ?? {};
      const name = meta["univapay-name"] ?? null;
      const plan = meta["plan"] ?? "standard";

      if (!member) {
        const createResult = await supabase(env, "POST", "/shr_members", {
          user_id: env.DEFAULT_USER_ID,
          email: `pending_${subscriptionId}@shia2n.jp`, // 仮メール（後で管理画面から更新）
          name,
          plan,
          subscription_status: "active",
          univa_subscription_id: subscriptionId,
          enrolled_at: new Date().toISOString(),
        });
        debug.steps.push({ step: "createMember", result: createResult });
      } else {
        await updateMemberById(env, member.id, {
          subscription_status: "active",
          name: name ?? member.name,
          plan: plan ?? member.plan,
        });
      }
      break;
    }

    // 月次課金成功
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

    // 課金失敗
    case "subscription_failed": {
      if (!member) break;
      await updateMemberById(env, member.id, { subscription_status: "past_due" });
      break;
    }

    // 解約
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

    return json({ error: "not_found" }, 404);
  },
};
