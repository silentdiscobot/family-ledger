const page = document.documentElement.dataset.page || "dashboard";
const state = {
  accounts: [],
  categories: [],
  members: [],
  budgets: [],
  recurring: [],
  assets: [],
  users: [],
  householdAdmins: [],
  currentUser: null,
  summary: null,
  transactions: [],
};

const money = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  maximumFractionDigits: 0,
});

const titles = {
  dashboard: ["Family Finance", "家庭财务操作台"],
  entry: ["Quick Entry", "记一笔"],
  records: ["Transactions", "流水查询"],
  budget: ["Budget", "预算管理"],
  accounts: ["Accounts", "账户管理"],
  categories: ["Categories", "分类管理"],
  members: ["Members", "家庭成员"],
  "create-household-account": ["Super Admin", "创建新家庭账号"],
  recurring: ["Recurring", "周期账单"],
  assets: ["Balance Sheet", "资产负债"],
  "import-export": ["Data", "导入导出"],
};

const today = new Date();
const monthInput = document.querySelector("#monthInput");
monthInput.value = today.toISOString().slice(0, 7);
const currentTitle = titles[page] || titles.dashboard;
document.querySelector("#pageKicker").textContent = currentTitle[0];
document.querySelector("#pageTitle").textContent = currentTitle[1];
document.querySelectorAll("nav a").forEach((link) => link.classList.toggle("active", link.dataset.page === page));
document.querySelectorAll(".page").forEach((view) => view.classList.toggle("active", view.dataset.view === page));

function $(selector) {
  return document.querySelector(selector);
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  window.setTimeout(() => el.classList.remove("show"), 1800);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

function optionList(items, labelKey = "name") {
  return items.map((item) => `<option value="${item.id}">${item[labelKey]}</option>`).join("");
}

function typedCategories(type) {
  return state.categories.filter((category) => category.type === type);
}

function typeText(type) {
  return { expense: "支出", income: "收入", transfer: "转账" }[type] || type;
}

function roleText(role) {
  return {
    super_admin: "超级管理员",
    household_admin: "家庭管理员",
    editor: "可记账成员",
    viewer: "只读成员",
  }[role] || role || "账号";
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
            <div class="bar-meta">
              <strong>${row[labelKey]}</strong>
              <span>${money.format(row[valueKey])}</span>
            </div>
            <div class="bar-track"><div class="bar-fill" style="width:${width}%;background:${row[colorKey] || "#38bdf8"}"></div></div>
          </div>
        `;
      })
      .join("") || '<p class="muted">暂无数据。</p>';
}

function transactionRows(items) {
  return items
    .map((item) => {
      const sign = item.type === "income" ? "+" : item.type === "expense" ? "-" : "";
      const amountClass = item.type === "income" ? "income" : item.type === "expense" ? "expense" : "";
      const account = item.type === "transfer" && item.to_account_name ? `${item.account_name} -> ${item.to_account_name}` : item.account_name;
      return `
        <tr>
          <td>${item.occurred_on}</td>
          <td><span class="pill">${typeText(item.type)}</span></td>
          <td>${item.category_name || "转账"}</td>
          <td>${account}</td>
          <td>${item.member_name}</td>
          <td>${item.note || ""}</td>
          <td class="${amountClass}">${sign}${money.format(item.amount)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderDashboard() {
  if (!state.summary) return;
  $("#incomeValue").textContent = money.format(state.summary.income);
  $("#expenseValue").textContent = money.format(state.summary.expense);
  $("#netValue").textContent = money.format(state.summary.net);
  $("#worthValue").textContent = money.format(state.summary.netWorth);
  renderBarList("#categoryBars", state.summary.categoryTotals.filter((row) => row.type === "expense"), "category", "total");
  renderBarList("#memberBars", state.summary.memberTotals.map((row) => ({ ...row, color: "#5eead4" })), "name", "expense");
  if ($("#recentRows")) {
    $("#recentRows").innerHTML = transactionRows(state.summary.recent);
  }
}

function renderSelects() {
  const typeInput = document.querySelector("input[name='type']:checked");
  const type = typeInput ? typeInput.value : "expense";
  const categorySelect = $("#categorySelect");
  if (categorySelect) {
    categorySelect.innerHTML = type === "transfer" ? '<option value="">转账</option>' : optionList(typedCategories(type));
    categorySelect.disabled = type === "transfer";
  }
  ["#accountSelect", "#toAccountSelect", "#recurringAccount"].forEach((selector) => {
    if ($(selector)) $(selector).innerHTML = optionList(state.accounts);
  });
  ["#memberSelect", "#recurringMember"].forEach((selector) => {
    if ($(selector)) $(selector).innerHTML = optionList(state.members);
  });
  if ($("#accountMemberSelect")) $("#accountMemberSelect").innerHTML = optionList(state.members);
  if ($("#memberSelect") && state.currentUser?.member_id) $("#memberSelect").value = state.currentUser.member_id;
  if ($("#toAccountWrap")) $("#toAccountWrap").classList.toggle("hidden", type !== "transfer");
  if ($("#recurringCategory")) $("#recurringCategory").innerHTML = optionList(typedCategories($("#recurringType")?.value || "expense"));
  if ($("#budgetCategory")) $("#budgetCategory").innerHTML = optionList(typedCategories("expense"));
  if ($("#filterCategory")) $("#filterCategory").innerHTML = '<option value="">全部分类</option>' + optionList(state.categories);
  if ($("#filterAccount")) $("#filterAccount").innerHTML = '<option value="">全部账户</option>' + optionList(state.accounts);
  if ($("#filterMember")) $("#filterMember").innerHTML = '<option value="">全部成员</option>' + optionList(state.members);
}

function renderBrand() {
  if ($("#brandHouseholdName")) {
    $("#brandHouseholdName").textContent = state.household?.name || "家庭名称";
  }
}

function renderBudget() {
  if (!$("#budgetLabel")) return;
  const totalBudget = state.budgets.find((item) => item.category_id === null);
  const amount = totalBudget ? totalBudget.amount : state.summary.budget;
  const spent = state.summary.expense;
  const percent = amount > 0 ? Math.min(100, Math.round((spent / amount) * 100)) : 0;
  const degrees = Math.round((percent / 100) * 360);
  $("#budgetLabel").textContent = `${money.format(spent)} / ${money.format(amount || 0)}`;
  $("#budgetPercent").textContent = `${percent}%`;
  $("#budgetRing").style.background = `conic-gradient(#38bdf8 ${degrees}deg, rgba(220, 242, 255, 0.8) ${degrees}deg)`;
  $("#budgetHint").textContent = amount > 0 ? `本月预算还剩 ${money.format(Math.max(amount - spent, 0))}` : "设置预算后可追踪本月支出压力。";
  $("#budgetList").innerHTML =
    state.budgets
      .filter((budget) => budget.category_id !== null)
      .map((budget) => {
        const category = state.categories.find((item) => item.id === budget.category_id);
        return `<div class="list-item"><span>${category?.name || "分类"}</span><strong>${money.format(budget.amount)}</strong></div>`;
      })
      .join("") || '<p class="muted">暂无分类预算。</p>';
}

function renderAccounts() {
  if (!$("#accountList")) return;
  $("#accountList").innerHTML = state.accounts
    .map(
      (account) => `
        <div class="account-item">
          <div class="account-name"><span class="dot" style="background:${account.color}"></span>${account.name}<small>${account.type}</small></div>
          <strong>${money.format(account.balance)}</strong>
        </div>
      `,
    )
    .join("");
}

function renderSettings() {
  if ($("#householdNameInput") && state.household?.name) {
    $("#householdNameInput").value = state.household.name;
  }
  if ($("#categoryList")) {
    $("#categoryList").innerHTML = state.categories
      .map((item) => `<div class="list-item"><span><i style="background:${item.color}"></i>${item.name}</span><strong>${typeText(item.type)}</strong></div>`)
      .join("");
  }
  if ($("#memberList")) {
    $("#memberList").innerHTML = state.members
      .map((item) => {
        const user = state.users.find((account) => account.member_id === item.id);
        const status = user ? `账号：${user.username}` : "未创建账号";
        return `
          <div class="list-item managed-item">
            <span>${item.name}<small>${status}</small></span>
            <strong>${item.role}</strong>
            <button class="danger-btn" data-delete-member="${item.id}">删除</button>
          </div>
        `;
      })
      .join("");
  }
  if ($("#userList")) {
    $("#userList").innerHTML =
      state.users
        .map((item) => {
          const canDelete = item.id !== state.currentUser?.id && item.role !== "super_admin";
          return `
            <div class="list-item managed-item">
              <span>${item.display_name}<small>${item.member_name || "未绑定成员"} · ${item.username}</small></span>
              <strong>${roleText(item.role)}</strong>
              ${canDelete ? `<button class="danger-btn" data-delete-user="${item.id}">删除</button>` : '<em>当前账号</em>'}
            </div>
          `;
        })
        .join("") || '<p class="muted">暂无登录账号。</p>';
  }
  if ($("#householdAdminList")) {
    $("#householdAdminList").innerHTML =
      state.householdAdmins
        .map(
          (item) => `
            <div class="list-item managed-item">
              <span>${item.household_name}<small>${item.display_name} · ${item.username}</small></span>
              <strong>${roleText(item.role)}</strong>
              <button class="danger-btn" data-delete-household="${item.household_id}">删除</button>
            </div>
          `,
        )
        .join("") || '<p class="muted">暂无已创建的家庭管理员账号。</p>';
  }
}

function renderRecurring() {
  if (!$("#recurringList")) return;
  $("#recurringList").innerHTML =
    state.recurring
      .map(
        (item) => `
          <div class="list-item action-item">
            <span>${item.name}<small>每月 ${item.day_of_month} 日 · ${item.category_name || "转账"} · ${item.account_name}</small></span>
            <strong>${money.format(item.amount)}</strong>
            <button data-generate="${item.id}">生成本月</button>
          </div>
        `,
      )
      .join("") || '<p class="muted">暂无周期账单。</p>';
}

function renderAssets() {
  if (!$("#assetList")) return;
  const accountTotal = state.accounts.reduce((sum, item) => sum + item.balance, 0);
  $("#assetValue").textContent = money.format(state.summary.assetTotal);
  $("#liabilityValue").textContent = money.format(state.summary.liabilityTotal);
  $("#accountTotalValue").textContent = money.format(accountTotal);
  $("#assetNetValue").textContent = money.format(state.summary.netWorth);
  $("#assetList").innerHTML =
    state.assets
      .map((item) => `<div class="list-item"><span>${item.name}<small>${item.note || ""}</small></span><strong class="${item.type === "liability" ? "expense" : "income"}">${money.format(item.amount)}</strong></div>`)
      .join("") || '<p class="muted">暂无资产负债条目。</p>';
}

async function loadTransactions(params = "") {
  state.transactions = await api(`/api/transactions${params}`);
  if ($("#transactionRows")) $("#transactionRows").innerHTML = transactionRows(state.transactions);
}

async function load() {
  const month = monthInput.value;
  const [bootstrap, summary] = await Promise.all([api(`/api/bootstrap?month=${month}`), api(`/api/summary?month=${month}`)]);
  Object.assign(state, bootstrap, { summary });
  renderBrand();
  renderSelects();
  renderDashboard();
  renderBudget();
  renderAccounts();
  renderSettings();
  renderRecurring();
  renderAssets();
  if (page === "records") await loadTransactions();
}

function bindForm(selector, path, success, payloadMapper = (data) => data) {
  const form = $(selector);
  if (!form) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      await api(path, { method: "POST", body: JSON.stringify(payloadMapper(data)) });
      form.reset();
      toast(success);
      await load();
    } catch (error) {
      const message = error.message.includes("username exists")
        ? "用户名已存在"
        : error.message.includes("password too short")
          ? "密码至少需要 6 位"
          : error.message.includes("forbidden")
            ? "当前账号没有权限执行此操作"
            : "保存失败，请检查输入";
      toast(message);
    }
  });
}

document.querySelectorAll("input[name='type']").forEach((input) => input.addEventListener("change", renderSelects));
if ($("#recurringType")) $("#recurringType").addEventListener("change", renderSelects);
monthInput.addEventListener("change", load);
if ($("#dateInput")) $("#dateInput").value = today.toISOString().slice(0, 10);

bindForm("#transactionForm", "/api/transactions", "已保存这笔记录");
bindForm("#budgetForm", "/api/budgets", "总预算已更新", (data) => ({ month: monthInput.value, amount: data.amount }));
bindForm("#categoryBudgetForm", "/api/budgets", "分类预算已保存", (data) => ({ month: monthInput.value, category_id: data.category_id, amount: data.amount }));
bindForm("#accountForm", "/api/accounts", "账户已添加");
bindForm("#categoryForm", "/api/categories", "分类已添加");
bindForm("#memberForm", "/api/members", "成员已添加");
bindForm("#memberAccountForm", "/api/member-accounts", "成员登录账号已创建");
bindForm("#householdForm", "/api/households", "新家庭已创建，可用新账号登录");
bindForm("#recurringForm", "/api/recurring", "周期账单已添加");
bindForm("#assetForm", "/api/assets", "资产负债条目已添加");

async function deleteResource(path, success) {
  try {
    await api(path, { method: "DELETE" });
    toast(success);
    await load();
  } catch (error) {
    const message = error.message.includes("member in use")
      ? "该成员已有流水，不能删除"
      : error.message.includes("cannot delete self")
        ? "不能删除当前登录账号"
        : error.message.includes("protected household")
          ? "不能删除默认家庭或当前家庭"
          : "删除失败";
    toast(message);
  }
}

document.addEventListener("click", async (event) => {
  const memberButton = event.target.closest("[data-delete-member]");
  if (memberButton) {
    await deleteResource(`/api/members/${memberButton.dataset.deleteMember}`, "成员已删除");
    return;
  }
  const userButton = event.target.closest("[data-delete-user]");
  if (userButton) {
    await deleteResource(`/api/member-accounts/${userButton.dataset.deleteUser}`, "账号已删除");
    return;
  }
  const householdButton = event.target.closest("[data-delete-household]");
  if (householdButton) {
    await deleteResource(`/api/households/${householdButton.dataset.deleteHousehold}`, "家庭管理员账号已删除");
  }
});

if ($("#householdNameForm")) {
  $("#householdNameForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      await api("/api/household", {
        method: "PATCH",
        body: JSON.stringify(data),
      });
      toast("家庭名称已更新");
      await load();
    } catch (error) {
      toast("只有家庭管理员可以修改家庭名称");
    }
  });
}

if ($("#filterForm")) {
  $("#filterForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const params = new URLSearchParams();
    Object.entries(Object.fromEntries(new FormData(event.currentTarget).entries())).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    await loadTransactions(`?${params.toString()}`);
  });
}

if ($("#recurringList")) {
  $("#recurringList").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-generate]");
    if (!button) return;
    await api(`/api/recurring/${button.dataset.generate}/generate`, {
      method: "POST",
      body: JSON.stringify({ month: monthInput.value }),
    });
    toast("已生成本月流水");
    await load();
  });
}

if ($("#importForm")) {
  $("#importForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    const result = await api("/api/import/transactions", {
      method: "POST",
      body: JSON.stringify(data),
    });
    toast(`已导入 ${result.created} 条流水`);
    event.currentTarget.reset();
    await load();
  });
}

load().catch((error) => {
  console.error(error);
  toast("加载失败，请检查服务是否正常");
});
