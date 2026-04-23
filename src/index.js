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
  const res = await fetch(
    `https://api.univapay.com/stores/${env.UNIVA_STORE_ID}/tokens/${tokenId}`,
    {
      headers: {
        "Authorization": `Bearer ${env.UNIVA_APP_TOKEN}.${env.UNIVA_APP_SECRET}`,
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
      const meta = payload?.data?.metadata ?? {};
      const name = meta["univapay-name"] ?? null;
      const plan = meta["plan"] ?? "standard";
      const tokenId = payload?.data?.transaction_token_id;

      // emailを取得（失敗してもメンバー登録は続ける）
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

    // ヘルスチェック
    if (url.pathname === "/health") {
      return json({ ok: true });
    }

    // 診断エンドポイント
    if (url.pathname === "/diag") {
      const diag = {
        env_check: {
          SUPABASE_URL: env.SUPABASE_URL ? "set" : "MISSING",
          SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY ? `set (length=${env.SUPABASE_ANON_KEY.length})` : "MISSING",
          DEFAULT_USER_ID: env.DEFAULT_USER_ID ? `set (${env.DEFAULT_USER_ID.substring(0, 8)}...)` : "MISSING",
          UNIVA_APP_TOKEN: env.UNIVA_APP_TOKEN ? `set (${env.UNIVA_APP_TOKEN.substring(0, 8)}...)` : "MISSING",
          UNIVA_APP_SECRET: env.UNIVA_APP_SECRET ? `set (length=${env.UNIVA_APP_SECRET.length})` : "MISSING",
          UNIVA_STORE_ID: env.UNIVA_STORE_ID ? `set (${env.UNIVA_STORE_ID.substring(0, 8)}...)` : "MISSING",
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
        const uniRes = await fetch(
          `https://api.univapay.com/stores/${env.UNIVA_STORE_ID}`,
          { headers: { "Authorization": `Bearer ${env.UNIVA_APP_TOKEN}.${env.UNIVA_APP_SECRET}` } }
        );
        const uniText = await uniRes.text();
        diag.univapay_ping = { ok: uniRes.ok, status: uniRes.status, body: uniText.substring(0, 300) };
      } catch (e) {
        diag.univapay_ping = { error: e.message };
      }

      return json(diag);
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
