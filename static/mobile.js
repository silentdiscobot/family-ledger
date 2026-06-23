const state = {
  accounts: [],
  categories: [],
  members: [],
  budgets: [],
  recurring: [],
  assets: [],
  summary: null,
  records: [],
  currentUser: null,
};

const money = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  maximumFractionDigits: 0,
});

const today = new Date();
const currentMonth = today.toISOString().slice(0, 7);

function $(selector) {
  return document.querySelector(selector);
}

function toast(message) {
  const el = $("#mobileToast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 1800);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function optionList(items, labelKey = "name") {
  return items.map((item) => `<option value="${item.id}">${item[labelKey]}</option>`).join("");
}

function typedCategories(type) {
  return state.categories.filter((category) => category.type === type);
}

function typeText(type) {
  return { income: "收入", expense: "支出", transfer: "转账" }[type] || type;
}

function renderRecords(selector, rows) {
  const el = $(selector);
  if (!el) return;
  el.innerHTML =
    rows
      .map((item) => {
        const sign = item.type === "income" ? "+" : item.type === "expense" ? "-" : "";
        const amountClass = item.type === "income" ? "income" : item.type === "expense" ? "expense" : "";
        return `
          <div class="list-item">
            <span>${item.category_name || "转账"}<small>${item.occurred_on} · ${item.account_name} · ${item.member_name} ${item.note || ""}</small></span>
            <strong class="${amountClass}">${sign}${money.format(item.amount)}</strong>
          </div>
        `;
      })
      .join("") || '<p class="muted">暂无数据。</p>';
}

function renderBarList(selector, rows, labelKey, valueKey, colorKey = "color") {
  const el = $(selector);
  if (!el) return;
  const max = Math.max(...rows.map((row) => row[valueKey] || 0), 1);
  el.innerHTML =
    rows
      .filter((row) => row[valueKey] > 0)
      .map((row) => {
        const width = Math.max(6, Math.round((row[valueKey] / max) * 100));
        return `
          <div class="bar-row">
            <div class="bar-meta"><strong>${row[labelKey]}</strong><span>${money.format(row[valueKey])}</span></div>
            <div class="bar-track"><div class="bar-fill" style="width:${width}%;background:${row[colorKey] || "#38bdf8"}"></div></div>
          </div>
        `;
      })
      .join("") || '<p class="muted">暂无数据。</p>';
}

function renderPie() {
  const rows = (state.summary?.categoryTotals || []).filter((row) => row.type === "expense" && row.total > 0).slice(0, 6);
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  const pie = $("#mPie");
  const legend = $("#mLegend");
  if (!total) {
    pie.style.background = "conic-gradient(#dbeafe 0deg 360deg)";
    pie.innerHTML = "<span>0%</span>";
    legend.innerHTML = '<p class="muted">暂无支出数据。</p>';
    return;
  }
  let cursor = 0;
  const segments = rows.map((row) => {
    const start = cursor;
    const degrees = (row.total / total) * 360;
    cursor += degrees;
    return `${row.color || "#38bdf8"} ${start}deg ${cursor}deg`;
  });
  pie.style.background = `conic-gradient(${segments.join(", ")})`;
  pie.innerHTML = `<span>${Math.round((rows[0].total / total) * 100)}%</span>`;
  legend.innerHTML = rows
    .map((row) => `<div class="legend-row"><i style="background:${row.color || "#38bdf8"}"></i><span>${row.category}</span><strong>${Math.round((row.total / total) * 100)}%</strong></div>`)
    .join("");
}

function renderStats() {
  if (!state.summary) return;
  $("#mIncome").textContent = money.format(state.summary.income);
  $("#mExpense").textContent = money.format(state.summary.expense);
  $("#mNet").textContent = money.format(state.summary.net);
  $("#mWorth").textContent = money.format(state.summary.netWorth);
  renderPie();
  renderBarList("#mCategoryBars", state.summary.categoryTotals.filter((row) => row.type === "expense"), "category", "total");
  renderBarList("#mMemberBars", state.summary.memberTotals.map((row) => ({ ...row, color: "#5eead4" })), "name", "expense");
  renderRecords("#mRecent", state.summary.recent || []);
  renderRecords("#mRecords", state.records);
}

function renderSettings() {
  const totalBudget = state.budgets.find((item) => item.category_id === null);
  const budgetAmount = totalBudget ? totalBudget.amount : state.summary?.budget || 0;
  const spent = state.summary?.expense || 0;
  const percent = budgetAmount > 0 ? Math.min(100, Math.round((spent / budgetAmount) * 100)) : 0;
  const degrees = Math.round((percent / 100) * 360);
  if ($("#mBudgetRing")) {
    $("#mBudgetRing").style.background = `conic-gradient(#38bdf8 ${degrees}deg, rgba(220, 242, 255, 0.8) ${degrees}deg)`;
    $("#mBudgetPercent").textContent = `${percent}%`;
    $("#mBudgetHint").textContent = budgetAmount > 0 ? `本月预算还剩 ${money.format(Math.max(budgetAmount - spent, 0))}` : "设置预算后可追踪本月支出压力。";
  }
  $("#mBudgetList").innerHTML =
    state.budgets.map((item) => {
      const category = state.categories.find((categoryItem) => categoryItem.id === item.category_id);
      return `<div class="list-item"><span>${category?.name || "总预算"}</span><strong>${money.format(item.amount)}</strong></div>`;
    }).join("") || '<p class="muted">暂无预算。</p>';
  $("#mCategoryList").innerHTML = state.categories.map((item) => `<div class="list-item"><span><i style="background:${item.color}"></i>${item.name}</span><strong>${typeText(item.type)}</strong></div>`).join("");
  $("#mMemberList").innerHTML = state.members.map((item) => `<div class="list-item"><span>${item.name}</span><strong>${item.role}</strong><button class="mini-danger" data-delete-member="${item.id}">删除</button></div>`).join("");
  $("#mUserList").innerHTML =
    (state.users || []).map((item) => {
      const canDelete = item.id !== state.currentUser?.id && item.role !== "super_admin";
      return `<div class="list-item"><span>${item.display_name}<small>${item.member_name || "未绑定成员"} · ${item.username}</small></span><strong>${item.role}</strong>${canDelete ? `<button class="mini-danger" data-delete-user="${item.id}">删除</button>` : ""}</div>`;
    }).join("") || '<p class="muted">暂无登录账号。</p>';
  $("#mRecurringList").innerHTML = state.recurring.map((item) => `<div class="list-item action-row"><span>${item.name}<small>每月 ${item.day_of_month} 日 · ${item.category_name || ""} · ${item.account_name}</small></span><strong>${money.format(item.amount)}</strong><button data-generate-recurring="${item.id}">生成本月</button></div>`).join("") || '<p class="muted">暂无周期账单。</p>';
  const accountTotal = state.accounts.reduce((sum, item) => sum + item.balance, 0);
  if ($("#mAssetValue")) {
    $("#mAssetValue").textContent = money.format(state.summary?.assetTotal || 0);
    $("#mLiabilityValue").textContent = money.format(state.summary?.liabilityTotal || 0);
    $("#mAccountTotalValue").textContent = money.format(accountTotal);
    $("#mAssetNetValue").textContent = money.format(state.summary?.netWorth || 0);
  }
  $("#mAssetList").innerHTML = state.assets.map((item) => `<div class="list-item"><span>${item.name}<small>${item.type === "asset" ? "资产" : "负债"}</small></span><strong>${money.format(item.amount)}</strong></div>`).join("") || '<p class="muted">暂无资产负债。</p>';
  $("#mAccountList").innerHTML = state.accounts.map((item) => `<div class="list-item"><span>${item.name}<small>${item.type}</small></span><strong>${money.format(item.balance)}</strong></div>`).join("");
  if ($("#mHouseholdNameInput") && state.household?.name) $("#mHouseholdNameInput").value = state.household.name;
}

function renderSelects() {
  const type = document.querySelector("#mTransactionForm input[name='type']:checked")?.value || "expense";
  $("#mCategorySelect").innerHTML = type === "transfer" ? '<option value="">转账</option>' : optionList(typedCategories(type));
  $("#mCategorySelect").disabled = type === "transfer";
  $("#mAccountSelect").innerHTML = optionList(state.accounts);
  $("#mToAccountSelect").innerHTML = optionList(state.accounts);
  $("#mToAccountSelect").classList.toggle("hidden", type !== "transfer");
  $("#mMemberSelect").innerHTML = optionList(state.members);
  $("#mFilterCategory").innerHTML = '<option value="">全部分类</option>' + optionList(state.categories);
  $("#mFilterAccount").innerHTML = '<option value="">全部账户</option>' + optionList(state.accounts);
  $("#mFilterMember").innerHTML = '<option value="">全部成员</option>' + optionList(state.members);
  $("#mBudgetCategory").innerHTML = optionList(typedCategories("expense"));
  const recurringType = $("#mRecurringType")?.value || "expense";
  $("#mRecurringCategory").innerHTML = optionList(typedCategories(recurringType));
  $("#mRecurringAccount").innerHTML = optionList(state.accounts);
  $("#mRecurringToAccount").innerHTML = optionList(state.accounts);
  $("#mRecurringMember").innerHTML = optionList(state.members);
  $("#mAccountMemberSelect").innerHTML = optionList(state.members);
  if (state.currentUser?.member_id) $("#mMemberSelect").value = state.currentUser.member_id;
  if ($("#mDateInput")) $("#mDateInput").value = today.toISOString().slice(0, 10);
}

function renderAll() {
  $("#mobileHousehold").textContent = state.household?.name || "家庭名称";
  renderStats();
  renderSettings();
  renderSelects();
}

function findNameMatch(items, text, aliases = {}) {
  const direct = [...items].sort((a, b) => b.name.length - a.name.length).find((item) => text.includes(item.name));
  if (direct) return { item: direct, token: direct.name };
  for (const [keyword, names] of Object.entries(aliases)) {
    if (!text.includes(keyword)) continue;
    const candidates = Array.isArray(names) ? names : [names];
    const item = items.find((entry) => candidates.some((name) => entry.name.includes(name)));
    if (item) return { item, token: keyword };
  }
  return { item: null, token: "" };
}

function inferCategory(text, type) {
  const categories = typedCategories(type);
  const direct = findNameMatch(categories, text);
  if (direct.item) return direct.item;
  const groups = [
    { names: ["餐饮"], keywords: ["早饭", "早餐", "午饭", "晚饭", "吃饭", "饭", "外卖", "奶茶", "买菜"] },
    { names: ["通勤", "交通"], keywords: ["地铁", "公交", "通勤", "单车"] },
    { names: ["运动", "娱乐"], keywords: ["打球", "篮球", "足球", "健身", "跑步", "游泳"] },
    { names: ["交通", "通勤"], keywords: ["打车", "滴滴", "油费", "高铁"] },
    { names: ["工资"], keywords: ["工资", "薪水", "奖金"] },
  ];
  for (const group of groups) {
    if (!group.keywords.some((keyword) => text.includes(keyword))) continue;
    const matched = group.names.map((name) => categories.find((category) => category.name.includes(name) || name.includes(category.name))).find(Boolean);
    if (matched) return matched;
  }
  return categories[0];
}

function parseTextEntry(rawText) {
  const text = rawText.trim();
  const amountMatch = text.match(/(?:￥|¥)?\s*(\d+(?:\.\d{1,2})?)\s*(?:元|块)?/);
  if (!amountMatch) throw new Error("missing amount");
  const type = /(工资|薪水|奖金|收入|利息|分红)/.test(text) ? "income" : "expense";
  const accountMatch = findNameMatch(state.accounts, text, {
    支付宝: ["支付宝"],
    微信: ["微信"],
    现金: ["现金"],
    信用卡: ["信用卡"],
    银行卡: ["银行卡"],
  });
  const account = accountMatch.item || state.accounts[0];
  const category = inferCategory(text, type);
  const member = state.members.find((item) => item.id === state.currentUser?.member_id) || state.members[0];
  if (!account || !category || !member) throw new Error("missing base data");
  const note = text.replace(amountMatch[0], "").replace(accountMatch.token, "").replace(category.name, "").trim() || category.name;
  return {
    type,
    amount: Number(amountMatch[1]),
    category_id: category.id,
    account_id: account.id,
    member_id: member.id,
    occurred_on: today.toISOString().slice(0, 10),
    note,
  };
}

async function load() {
  const [bootstrap, summary, records] = await Promise.all([
    api(`/api/bootstrap?month=${currentMonth}`),
    api(`/api/summary?month=${currentMonth}`),
    api("/api/transactions"),
  ]);
  Object.assign(state, bootstrap, { summary, records });
  renderAll();
}

function bindPostForm(selector, path, success, mapper = (data) => data) {
  const form = $(selector);
  if (!form) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      await api(path, { method: "POST", body: JSON.stringify(mapper(data)) });
      form.reset();
      toast(success);
      await load();
    } catch (error) {
      toast("保存失败，请检查输入");
    }
  });
}

document.querySelectorAll(".bottom-tabs button").forEach((button) => {
  button.addEventListener("click", () => {
    const target = button.dataset.moduleTarget;
    document.querySelectorAll(".bottom-tabs button").forEach((item) => item.classList.toggle("active", item === button));
    document.querySelectorAll(".module").forEach((item) => item.classList.toggle("active", item.dataset.module === target));
    $("#mobileTitle").textContent = button.textContent;
  });
});

document.querySelectorAll(".subtabs button").forEach((button) => {
  button.addEventListener("click", () => {
    const wrapper = button.closest(".module");
    wrapper.querySelectorAll(".subtabs button").forEach((item) => item.classList.toggle("active", item === button));
    wrapper.querySelectorAll(".subview").forEach((item) => item.classList.toggle("active", item.dataset.subview === button.dataset.subtab));
  });
});

document.querySelectorAll("#mTransactionForm input[name='type']").forEach((input) => input.addEventListener("change", renderSelects));

bindPostForm("#mTransactionForm", "/api/transactions", "已保存", (data) => ({ ...data, occurred_on: data.occurred_on || today.toISOString().slice(0, 10) }));
bindPostForm("#mBudgetForm", "/api/budgets", "预算已保存", (data) => ({ month: currentMonth, amount: data.amount }));
bindPostForm("#mCategoryBudgetForm", "/api/budgets", "分类预算已保存", (data) => ({ month: currentMonth, category_id: data.category_id, amount: data.amount }));
bindPostForm("#mCategoryForm", "/api/categories", "分类已添加", (data) => ({ ...data, color: "#38bdf8" }));
bindPostForm("#mMemberForm", "/api/members", "成员已添加");
bindPostForm("#mMemberAccountForm", "/api/member-accounts", "成员登录账号已创建");
bindPostForm("#mRecurringForm", "/api/recurring", "周期账单已添加", (data) => ({ ...data, active: true }));
bindPostForm("#mAssetForm", "/api/assets", "资产负债已添加");
bindPostForm("#mAccountForm", "/api/accounts", "账户已添加", (data) => ({ ...data, color: "#38bdf8" }));

$("#mHouseholdNameForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/household", { method: "PATCH", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget).entries())) });
    toast("家庭名称已更新");
    await load();
  } catch (error) {
    toast("只有家庭管理员可以修改家庭名称");
  }
});

$("#mTextEntryForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = parseTextEntry(new FormData(event.currentTarget).get("text") || "");
    await api("/api/transactions", { method: "POST", body: JSON.stringify(data) });
    event.currentTarget.reset();
    toast("文字记账已保存");
    await load();
  } catch (error) {
    toast("没有识别到完整记账信息");
  }
});

$("#mImportForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await api("/api/import/transactions", {
    method: "POST",
    body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget).entries())),
  });
  toast(`已导入 ${result.created} 条`);
  event.currentTarget.reset();
  await load();
});

$("#mFilterForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const params = new URLSearchParams();
  Object.entries(Object.fromEntries(new FormData(event.currentTarget).entries())).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  state.records = await api(`/api/transactions?${params.toString()}`);
  renderRecords("#mRecords", state.records);
});

document.addEventListener("click", async (event) => {
  const recurringButton = event.target.closest("[data-generate-recurring]");
  if (recurringButton) {
    await api(`/api/recurring/${recurringButton.dataset.generateRecurring}/generate`, {
      method: "POST",
      body: JSON.stringify({ month: currentMonth }),
    });
    toast("已生成本月流水");
    await load();
    return;
  }
  const memberButton = event.target.closest("[data-delete-member]");
  if (memberButton) {
    await api(`/api/members/${memberButton.dataset.deleteMember}`, { method: "DELETE" });
    toast("成员已删除");
    await load();
    return;
  }
  const userButton = event.target.closest("[data-delete-user]");
  if (userButton) {
    await api(`/api/member-accounts/${userButton.dataset.deleteUser}`, { method: "DELETE" });
    toast("账号已删除");
    await load();
  }
});

load().catch(() => toast("加载失败，请重新登录"));
